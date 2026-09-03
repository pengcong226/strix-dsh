/**
 * strix_sast — dynamic and static analysis wrappers: nuclei template scanning
 * against a live target (rate-limited by default), semgrep against local
 * source. Strix discipline applies: scanner output is a LEAD, never a finding
 * — validate everything with strix_http/strix_pybox/strix_browser before
 * filing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { ConfigType } from '../config.js'
import { checkBudget } from './budget.js'
import { dockerRun, findBinary, formatRunResult, runProcess, type RunResult } from '../lib/util.js'

const NUCLEI_SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical', 'unknown'])

/**
 * Flags that would let a call escape the tool's contract: retargeting the
 * scan off the authorized target, disabling the rate limiter / raising
 * concurrency, or changing engine behavior via config/update switches.
 * Everything else stays open — template selection (-t/-tags/-severity),
 * output formatting (-o/-json/-sarif, container-local and discarded with
 * --rm), and proxy routing are normal pentest operation on an authorized
 * target, and blocking them only taxes the model. Pure — unit-tested.
 */
const BLOCKED_EXTRA_FLAGS = new Set([
  '-u', '-target', '-l', '-list', '-resume',
  '-rl', '-rate-limit', '-c', '-concurrency', '-bulk-size', '-headless',
  '-config', '-rc', '-update', '-update-templates', '-disable-update-check',
  '-duc', '-disable-clustering', '-uncover', '-expose',
])

export function checkExtraArgs(extra: string[]): string | null {
  for (const token of extra) {
    if (BLOCKED_EXTRA_FLAGS.has(token.toLowerCase())) {
      return `REJECTED: extra_args flag "${token}" is not allowed (scan target, rate-limit/concurrency, and engine config/update switches are fixed by the tool).`
    }
  }
  return null
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
        const timeoutMs = args.timeout_ms ?? config.reconTimeoutMs

        if (args.engine === 'nuclei') {
          const extra = (args.extra_args ?? '').split(' ').filter(Boolean)
          const extraRejection = checkExtraArgs(extra)
          if (extraRejection) return extraRejection
          const severity = args.severity ?? 'low,medium,high,critical'
          const badSeverity = severity.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && !NUCLEI_SEVERITIES.has(s))
          if (badSeverity.length > 0) {
            return `REJECTED: unknown nuclei severity value(s): ${badSeverity.join(', ')}. Use info, low, medium, high, critical, unknown.`
          }
          // Container first: the projectdiscovery/nuclei image ships its own
          // template library and avoids Windows config-dir write failures in
          // sandboxed child processes (nuclei otherwise hangs on startup).
          const docker = findBinary(config, 'docker')
          const hostBin = findBinary(config, 'nuclei')
          let result: RunResult
          let via: string

          if (docker) {
            result = await dockerRun(config, {
              image: 'projectdiscovery/nuclei',
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
              network: true,
              workdir: '/workspace',
            })
            via = 'container (projectdiscovery/nuclei)'
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
          const extraRejection = checkExtraArgs(extra)
          if (extraRejection) return extraRejection
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
              image: 'returntocorp/semgrep',
              command: ['semgrep', 'scan', '--config', 'auto', '--quiet', `./${mounted}`, ...extra],
              timeoutMs,
              network: true,
              workdir: '/src',
              skipWorkspaceMount: true,
              extraVolumes: ['-v', `${hostDir.split('\\').join('/')}:/src`],
            })
          } else {
            return 'semgrep not found on host. Install it (pip install semgrep), set binariesDir, or pass an '
              + 'absolute local target path so the container fallback can mount it.'
          }
          return warnPrefix + `semgrep scan of ${args.target}:\n${formatRunResult(result, 20_000)}\n`
            + 'Remember: static analysis is a lead — trace it, then validate dynamically where possible.'
        }

        return `Unknown engine "${args.engine}". Use nuclei | semgrep.`
      },
    }),
  )
}
