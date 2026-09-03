/**
 * strix_shell — command execution inside a disposable Docker container with
 * the engagement workspace mounted at /workspace. This restores Strix's
 * "commands run in an isolated sandbox, not on the host" property. The
 * container image is configurable; point shellImage at a Kali image for the
 * full upstream tool inventory.
 *
 * Every call passes dsh's approval gate first (HITL): only an explicit
 * operator grant executes; rejections/absences fail closed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConfigType } from '../config.js'
import { createApprovalGate, logEvidence, splitApprovalSummary } from '../lib/approval.js'
import { newCidFile, startBackgroundShell } from '../lib/jobs.js'
import { clampTimeoutMs, dockerRun, formatRunResult } from '../lib/util.js'

export function registerShell(ctx: Context, config: ConfigType) {
  const requestApproval = createApprovalGate(ctx, config)
  ctx.tools.register(
    defineTool({
      name: 'strix_shell',
      description:
        'Execute a shell command inside a disposable Docker container with the engagement workspace mounted '
        + 'at /workspace (read-write). Each call is a fresh container: persist state through files in the '
        + 'workspace. Use for running security engines, parsing recon output, and batch payload work — NOT '
        + 'for touching the host. Pass background=true for long scans: the command runs as a dsh background '
        + 'job (manage with job_output / job_list / job_kill) instead of blocking this call. Subject to '
        + 'operator approval per call. Only against authorized targets.',
      parameters: {
        command: { type: 'string', required: true, description: 'The shell command to run inside the container (bash -c).' },
        timeout_ms: { type: 'number', description: 'Kill the command after this many milliseconds. Default from config.' },
        image: { type: 'string', description: 'Override the container image for this call (e.g. a Kali image with the toolset you need). Attended runs: the image name shows in the approval prompt and the operator decides. Unattended runs (approvalGate off): only the default shellImage and shellAllowedImages.' },
        network: { type: 'boolean', description: 'Container network access. Default from config (enabled).' },
        workdir: { type: 'string', description: 'Working directory inside the container. Default /workspace.' },
        background: { type: 'boolean', description: 'Run as a background dsh job; returns the job id immediately. Read output with job_output, stop with job_kill.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>, exec): Promise<string> {
        const args = raw as unknown as { command: string; timeout_ms?: number; image?: string; network?: boolean; workdir?: string; background?: boolean }
        const image = args.image ?? config.shellImage
        // Image allowlist binds ONLY in unattended mode: with the approval
        // gate on, the image name rides the human-readable approval summary
        // and the operator decides per call. With the gate off nobody reads
        // that summary, so off-list images are refused fail-closed.
        if (config.approvalGate === 'off' && image !== config.shellImage
          && !(config.shellAllowedImages ?? []).includes(image)) {
          return `REJECTED: unattended mode (approvalGate 'off') allows only the default image (${config.shellImage}) `
            + 'and shellAllowedImages. Ask the operator to allowlist the image, or run attended.'
        }
        const network = args.network ?? config.shellNetwork
        const timeoutMs = clampTimeoutMs(args.timeout_ms, config.shellTimeoutMs)
        // Match on the FULL command, display truncated+hash-stamped: a
        // prefix-type auto-allow must never grant on an invisible suffix.
        const gate = await requestApproval(
          exec,
          splitApprovalSummary(
            `strix_shell${args.background ? ' (background job)' : ''}: run "${args.command}" in ${image} `
            + `(network: ${network ? 'on' : 'off'}, timeout: ${timeoutMs}ms, workdir: ${args.workdir ?? '/workspace'})`,
          ),
        )
        if (!gate.granted) return gate.message

        if (args.background) {
          const jobId = startBackgroundShell(ctx, config, exec.agent, {
            command: args.command,
            image,
            network,
            workdir: args.workdir,
            timeoutMs,
            callId: exec.callId,
            cidFile: newCidFile(),
          })
          logEvidence(config, {
            ts: new Date().toISOString(),
            kind: 'result',
            tool: 'strix_shell',
            callId: exec.callId,
            exitCode: null,
            durationMs: 0,
          })
          return `Background job started: ${jobId}. Read streaming output with job_output, list jobs with job_list, stop it with job_kill.`
        }

        const started = Date.now()
        const result = await dockerRun(config, {
          image,
          command: ['bash', '-c', args.command],
          timeoutMs,
          network,
          workdir: args.workdir,
        })
        logEvidence(config, {
          ts: new Date().toISOString(),
          kind: 'result',
          tool: 'strix_shell',
          callId: exec.callId,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
        })
        if (result.dockerMissing) {
          return 'Docker is unavailable: install Docker Desktop (or start the daemon) to use strix_shell/strix_pybox/strix browser-backed flows. Install docs: https://www.docker.com/products/docker-desktop/'
        }
        const text = formatRunResult(result, 20_000)
        // Honest accounting: killing the local CLI does not stop the daemon
        // container, so a timed-out run is `rm -f`'d — say so explicitly.
        return result.containerRemoved ? `${text}\n[container removed after timeout — no residual workload]` : text
      },
    }),
  )
}
