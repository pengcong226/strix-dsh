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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { createApprovalGate, logEvidence } from '../lib/approval.js'
import { dockerRun, formatRunResult, truncate, workspaceSub } from '../lib/util.js'

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
        const packages = args.install_packages?.trim()
        const gate = await requestApproval(
          exec,
          `strix_pybox: run Python script (${args.script.length} chars, first line: "${truncate(args.script.split('\n').find((l) => l.trim()) ?? '', 120)}")`
            + `${packages ? ` installing: ${packages}` : ''} (network: ${network ? 'on' : 'off'})`,
        )
        if (!gate.granted) return gate.message

        const runDir = workspaceSub(config, 'pybox', `run-${Date.now()}`)
        writeFileSync(join(runDir, 'main.py'), args.script, 'utf8')
        if (args.arguments) {
          writeFileSync(join(runDir, 'args.json'), JSON.stringify(args.arguments, null, 2), 'utf8')
        }
        for (const [name, content] of Object.entries(args.files ?? {})) {
          if (name.includes('..') || name.includes('/') || name.includes('\\')) {
            return `REJECTED: file entry "${name}" must be a plain filename (no path separators).`
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
          timeoutMs: args.timeout_ms ?? config.pyboxTimeoutMs,
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
