/**
 * strix_pybox — Python exploit sandbox ported from Strix's custom exploit
 * runtime: user Python scripts run inside a disposable Docker container with
 * the workspace mounted, optional network isolation, and a hard timeout.
 * This is where spray payloads and PoC scripts run — never iterate payloads
 * manually when a script can batch them.
 *
 * Every call passes dsh's approval gate first (HITL): only an explicit
 * operator grant executes; rejections/absences fail closed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { createApprovalGate, logEvidence, splitApprovalSummary } from '../lib/approval.js'
import { dockerRun, formatRunResult, safeId, clampTimeoutMs, truncate, workspaceSub } from '../lib/util.js'

/**
 * pip package spec allowlist: version pins (`==`, `>=`, `~=`, `,`), extras
 * (`pkg[extra]`), and plain names — but never a token starting with `-`
 * (`--index-url`, `-r`, `--find-links`, `--extra-index-url` would redirect
 * the dependency source). The script itself is already arbitrary code, so
 * this is about keeping the install line reviewable, not about containment.
 * Pure — unit-tested.
 */
export function validPipPackages(spec: string): boolean {
  if (!spec.trim()) return true
  if (!/^[A-Za-z0-9_.\-=<>~, \[\]]+$/.test(spec)) return false
  return !spec.split(/\s+/).some((t) => t.startsWith('-'))
}

export function registerPybox(ctx: Context, config: ConfigType) {
  const requestApproval = createApprovalGate(ctx, config)
  ctx.tools.register(
    defineTool({
      name: 'strix_pybox',
      description:
        'Run a Python script inside a disposable Docker sandbox (workspace mounted at /workspace), with a hard ' +
        'timeout and optional network isolation. THE way to spray payloads (SQLi/XSS/SSRF/fuzzing) in bulk and ' +
        'to execute PoC scripts — write one script that batches hundreds of attempts instead of manual ' +
        'iteration. Stdlib only by default; configure extra packages in plugin config or pass install_packages. ' +
        'Subject to operator approval per call. Only against authorized targets.',
      parameters: {
        script: { type: 'string', required: true, description: 'Python source code to execute (saved as /workspace/pybox/<run>/main.py).' },
        files: { type: 'object', additionalProperties: true, description: 'Extra files to write next to the script: {filename: content}. Wordlists, payload sets, configs.' },
        install_packages: { type: 'string', description: 'Space-separated pip packages to install in the container before running (requires network).' },
        timeout_ms: { type: 'number', description: 'Kill the container after this many milliseconds. Default from config.' },
        network: { type: 'boolean', description: 'Container network access. Default from config (enabled).' },
        arguments: { type: 'object', additionalProperties: true, description: 'Optional JSON passed to the script as /workspace/pybox/<run>/args.json (read it instead of complex quoting).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>, exec): Promise<string> {
        const args = raw as unknown as { script: string; files?: Record<string, string>; install_packages?: string; timeout_ms?: number; network?: boolean; arguments?: Record<string, unknown> }
        const network = args.network ?? config.pyboxNetwork
        // Operator-configured base packages plus the per-call request share
        // one install line (previously the config key was declared but never
        // read — dead config).
        const packages = [...(config.pyboxExtraPackages ?? []), args.install_packages?.trim() ?? '']
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' ')
        if (packages && !validPipPackages(packages)) {
          return 'REJECTED: install_packages allows only package names with version pins (==, >=, ~=, extras [...]) — no flags (--index-url, -r, --find-links).'
        }
        // Match on the FULL script, display truncated+hash-stamped (same
        // truncation-before-match fix as strix_shell).
        const firstLine = args.script.split('\n').find((l) => l.trim()) ?? ''
        const timeoutMs = clampTimeoutMs(args.timeout_ms, config.pyboxTimeoutMs)
        const gate = await requestApproval(
          exec,
          splitApprovalSummary(
            `strix_pybox: run Python script (${args.script.length} chars, first line: "${truncate(firstLine, 120)}")`
            + `${packages ? ` installing: ${packages}` : ''} (network: ${network ? 'on' : 'off'}, timeout: ${timeoutMs}ms)\n--- full script below ---\n${args.script}`,
          ),
        )
        if (!gate.granted) return gate.message

        const runDir = workspaceSub(config, 'pybox', `run-${Date.now()}-${randomUUID().slice(0, 8)}`)
        writeFileSync(join(runDir, 'main.py'), args.script, 'utf8')
        if (args.arguments) {
          writeFileSync(join(runDir, 'args.json'), JSON.stringify(args.arguments, null, 2), 'utf8')
        }
        for (const [name, content] of Object.entries(args.files ?? {})) {
          if (!safeId(name)) {
            return `REJECTED: file entry "${name}" must be a plain filename (letters, digits, dash, underscore, dot — no path separators, no leading dot).`
          }
          writeFileSync(join(runDir, name), content, 'utf8')
        }

        // Workdir is the run dir so relative file access is predictable.
        const command = packages
          ? ['bash', '-c', `pip install --no-input ${packages} && python main.py`]
          : ['python', 'main.py']

        const started = Date.now()
        const result = await dockerRun(config, {
          image: config.pyboxImage,
          command,
          timeoutMs,
          network,
          workdir: `/workspace/pybox/${runDir.split(/[\\/]/).pop()}`,
        })
        logEvidence(config, {
          ts: new Date().toISOString(),
          kind: 'result',
          tool: 'strix_pybox',
          callId: exec.callId,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          runDir,
        })
        if (result.dockerMissing) {
          return 'Docker is unavailable: install Docker Desktop (or start the daemon) to use strix_pybox. Script saved at ' + runDir
        }
        return `Run dir: ${runDir}\n${formatRunResult(result, 20_000)}`
      },
    }),
  )
}
