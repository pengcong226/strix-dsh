/**
 * strix_sast — dynamic and static analysis wrappers: nuclei template scanning
 * against a live target (rate-limited by default), semgrep against local
 * source. Strix discipline applies: scanner output is a LEAD, never a finding
 * — validate everything with strix_http/strix_pybox/strix_browser before
 * filing.
 */
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { ConfigType } from '../config.js'
import { readAuthorization, targetCoveredByAuth } from './authorization.js'
import { checkBudget } from './budget.js'
import { clampTimeoutMs, dockerRun, findBinary, formatRunResult, runProcess, workspaceDir, type RunResult } from '../lib/util.js'

const NUCLEI_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical', 'unknown'])

/**
 * Flags that would let a nuclei call escape the tool's contract: retargeting
 * the scan off the authorized target, disabling the rate limiter / raising
 * concurrency, or changing engine behavior via config/update switches.
 * Everything else stays open — template selection (-t/-tags/-severity),
 * output formatting (-o/-json/-sarif, container-local and discarded with
 * --rm), and proxy routing are normal pentest operation on an authorized
 * target, and blocking them only taxes the model. Pure — unit-tested.
 */
const NUCLEI_BLOCKED_EXTRA_FLAGS = new Set([
  'u', 'target', 'l', 'list', 'resume',
  'rl', 'rate-limit', 'c', 'concurrency', 'bulk-size', 'headless',
  'config', 'rc', 'update', 'update-templates', 'disable-update-check',
  'duc', 'disable-clustering', 'uncover', 'expose',
])

/**
 * Separate table for semgrep: its `-l/--lang` is a legitimate language
 * selector (the shared nuclei table would mis-block it), while its own
 * exfiltration surface is remote rulesets, metrics, and uploads. Exported
 * for regression tests.
 */
export const SEMGREP_BLOCKED_EXTRA_FLAGS = new Set([
  'config', 'remote', 'metrics', 'upload', 'gitlab', 'github', 'pro',
])

/** Normalize one extra_args token to its flag stem: lowercase, no leading dashes, value after `=` dropped. */
function flagStem(token: string): string {
  return token.toLowerCase().replace(/^-+/, '').split('=')[0] ?? ''
}

export function checkExtraArgs(extra: string[], blocked: Set<string> = NUCLEI_BLOCKED_EXTRA_FLAGS): string | null {
  for (const token of extra) {
    const stem = flagStem(token)
    if (blocked.has(stem)) {
      return `REJECTED: extra_args flag "${token}" is not allowed (scan target, rate-limit/concurrency, and engine config/update switches are fixed by the tool).`
    }
    // Attached short value forms (`-rl100`, `-c5`) dodge the exact/stem
    // match — but only where the table actually holds those value flags.
    if (/^(rl|c)\d/.test(stem) && (blocked.has('rl') || blocked.has('c'))) {
      return `REJECTED: extra_args flag "${token}" is not allowed (scan target, rate-limit/concurrency, and engine config/update switches are fixed by the tool).`
    }
  }
  return null
}

/**
 * Is a semgrep target inside the engagement workspace (or an operator-listed
 * `sastExtraMountRoots` entry)? The container fallback mounts the host
 * directory, so an unconstrained absolute path would expose arbitrary host
 * trees to the container — and via extra_args, to the network. Pure
 * filesystem check — unit-tested.
 */
export function semgrepTargetAllowed(config: ConfigType, target: string): boolean {
  // resolve() first: join() keeps `..` segments lexically, so a raw
  // startsWith check would mistake `<ws>/../other` for "inside".
  const abs = resolve(target)
  const roots = [workspaceDir(config), ...(config.sastExtraMountRoots ?? [])]
  return roots.some((root) => {
    if (!root.trim()) return false
    const base = resolve(root)
    return abs === base || abs.startsWith(base + sep)
  })
}

/** Named volume holding nuclei templates across `--rm` scans (backlog A-1). */
export const NUCLEI_TEMPLATE_VOLUME = 'strix-nuclei-templates'

/** Best-effort `docker volume create` — failure just means stock templates. */
export function ensureNucleiTemplateVolume(): void {
  try {
    spawnSync('docker', ['volume', 'create', NUCLEI_TEMPLATE_VOLUME], { timeout: 15_000, windowsHide: true })
  } catch {
    /* without Docker there is no volume; the scan falls back below anyway */
  }
}

export function registerSast(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_sast',
      description:
        'Run nuclei (template scan against a live target) or semgrep (static analysis against local source). ' +
        'Scanner output is a lead, never evidence: follow up with strix_http/strix_pybox validation before ' +
        'registering anything in strix_finding. Nuclei is rate-limited by default — keep it that way unless ' +
        'the target is yours.',
      parameters: {
        engine: { type: 'string', required: true, description: 'nuclei | semgrep' },
        target: { type: 'string', required: true, description: 'nuclei: target URL. semgrep: local source directory.' },
        severity: { type: 'string', description: 'nuclei severity filter, comma-separated. Default "low,medium,high,critical".' },
        extra_args: { type: 'string', description: 'Additional engine arguments (space-split). Use sparingly.' },
        timeout_ms: { type: 'number', description: 'Default from recon timeout config.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { engine: string; target: string; severity?: string; extra_args?: string; timeout_ms?: number }
        const gate = checkBudget(config, 'strix_sast')
        if (gate.over && config.budgetAction === 'block') return gate.message
        const warnPrefix = gate.over ? gate.message + '\n' : ''
        const timeoutMs = clampTimeoutMs(args.timeout_ms, config.reconTimeoutMs)

        if (args.engine === 'nuclei') {
          const extra = (args.extra_args ?? '').split(' ').filter(Boolean)
          const extraRejection = checkExtraArgs(extra)
          if (extraRejection) return extraRejection
          const severity = args.severity ?? 'low,medium,high,critical'
          const badSeverity = severity.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && !NUCLEI_SEVERITIES.has(s))
          if (badSeverity.length > 0) {
            return `REJECTED: unknown nuclei severity value(s): ${badSeverity.join(', ')}. Use info, low, medium, high, critical, unknown.`
          }
          // Active scan: the target is an http(s) URL inside the live
          // attestation — description text alone never authorizes traffic.
          if (!/^https?:\/\//i.test(args.target)) {
            return `REJECTED: nuclei target must be an http(s) URL, got "${args.target}".`
          }
          if (!targetCoveredByAuth(readAuthorization(config), args.target)) {
            return `REJECTED: target "${args.target}" is not covered by a live authorization. Record one with strix_authorization (action=set) naming this target first.`
          }
          // Container first: the projectdiscovery/nuclei image ships its own
          // template library and avoids Windows config-dir write failures in
          // sandboxed child processes (nuclei otherwise hangs on startup).
          // Templates persist in the `strix-nuclei-templates` named volume
          // (backlog A-1): refresh with
          // `docker run --rm -v strix-nuclei-templates:/root/nuclei-templates
          // projectdiscovery/nuclei -update-templates` — daily upstream merges
          // then reach every scan without re-pulling the image.
          const docker = findBinary(config, 'docker')
          const hostBin = findBinary(config, 'nuclei')
          let result: RunResult
          let via: string

          if (docker) {
            ensureNucleiTemplateVolume()
            result = await dockerRun(config, {
              image: config.sastNucleiImage,
              command: [
                '-target',
                args.target,
                '-severity',
                severity,
                '-rl',
                String(config.nucleiRateLimit),
                '-silent',
                '-nc',
                ...extra,
              ],
              timeoutMs,
              network: config.sastNetwork,
              workdir: '/workspace',
              extraVolumes: ['-v', `${NUCLEI_TEMPLATE_VOLUME}:/root/nuclei-templates`],
            })
            via = `container (${config.sastNucleiImage}, templates volume)`
          } else if (hostBin) {
            result = await runProcess(
              hostBin,
              [
                '-target',
                args.target,
                '-severity',
                severity,
                '-rl',
                String(config.nucleiRateLimit),
                '-silent',
                '-nc',
                ...extra,
              ],
              { timeoutMs },
            )
            via = 'host binary'
          } else {
            return 'nuclei unavailable: no Docker daemon and no host binary. Install Docker Desktop, or install '
              + 'nuclei (https://github.com/projectdiscovery/nuclei) into ~/.dsh/bin and set binariesDir.'
          }
          return warnPrefix + `nuclei scan via ${via} (rate limit ${config.nucleiRateLimit}/s):\n${formatRunResult(result, 20_000)}\n`
            + 'Remember: these are template matches, not validated findings.'
        }

        if (args.engine === 'semgrep') {
          const extra = (args.extra_args ?? '').split(' ').filter(Boolean)
          const extraRejection = checkExtraArgs(extra, SEMGREP_BLOCKED_EXTRA_FLAGS)
          if (extraRejection) return extraRejection
          // The target becomes a container mount (or a host-binary scan
          // root): it must live under the engagement workspace or an
          // operator-listed sastExtraMountRoots entry — never an arbitrary
          // host path — and the mount is read-only.
          if (!semgrepTargetAllowed(config, args.target)) {
            return `REJECTED: semgrep target "${args.target}" is outside the engagement workspace. Scan a copy inside the workspace, or ask the operator to list its root in sastExtraMountRoots.`
          }
          let result: RunResult

          const bin = findBinary(config, 'semgrep')
          if (bin) {
            result = await runProcess(bin, ['scan', '--config', 'auto', '--quiet', args.target, ...extra], { timeoutMs })
          } else if (existsSync(args.target) && isAbsolute(args.target)) {
            // No host semgrep (common on Windows) — fall back to the official
            // container image with the source directory mounted at /src.
            const docker = findBinary(config, 'docker') ?? 'docker'
            const hostDir = dirname(args.target)
            const mounted = args.target.split(/[\\/]/).pop() ?? 'src'
            result = await dockerRun(config, {
              image: config.sastSemgrepImage,
              command: ['semgrep', 'scan', '--config', 'auto', '--quiet', `./${mounted}`, ...extra],
              timeoutMs,
              network: config.sastNetwork,
              workdir: '/src',
              skipWorkspaceMount: true,
              extraVolumes: ['-v', `${hostDir.split('\\').join('/')}:/src:ro`],
            })
          } else {
            return 'semgrep not found on host. Install it (pip install semgrep), set binariesDir, or pass an '
              + 'absolute local target path so the container fallback can mount it.'
          }
          return warnPrefix + `semgrep scan of ${args.target}:\n${formatRunResult(result, 20_000)}\n`
            + 'Remember: static analysis is a lead — trace it, then validate dynamically where possible.'
        }

        return `REJECTED: unknown engine "${args.engine}". Use nuclei | semgrep.`
      },
    }),
  )
}
