/**
 * Background job producer for strix_shell: long scans run as dsh jobs
 * (`ctx.jobs`) instead of blocking one tool call, and the model-facing
 * `job_output` / `job_list` / `job_kill` tools (shipped by dsh's own
 * `dsh-tool-jobs` bundle) manage them. This file owns the producer side:
 * kind registration, streaming docker spawn, and cancellation.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ConfigType } from '../config.js'
import { logEvidence } from './approval.js'
import { dockerRmContainer, readCidFile, workspaceDir } from './util.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'strix-shell': 'strix-shell'
  }
}

export interface BackgroundShellSpec {
  command: string
  image: string
  network: boolean
  workdir?: string
  timeoutMs: number
  callId?: string
  /** Host path of the docker --cidfile binding this job to its container. */
  cidFile: string
}

/**
 * Allocate a host-side cidfile path for one background job. Pure.
 */
export function newCidFile(): string {
  return join(tmpdir(), `strix-job-${process.pid}-${randomUUID()}.cid`)
}

/**
 * Build the `docker run` argv for a background shell job. Pure function —
 * unit-tested; startBackgroundShell uses it verbatim.
 */
export function buildBackgroundDockerArgs(ws: string, spec: BackgroundShellSpec): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${ws}:/workspace`,
    '-w',
    spec.workdir ?? '/workspace',
    ...(spec.network ? [] : ['--network', 'none']),
    '--cidfile',
    spec.cidFile,
    spec.image,
    'bash',
    '-c',
    spec.command,
  ]
}

/** Shorten a command to a one-line job label. */
export function jobLabel(command: string): string {
  return command.length > 80 ? command.slice(0, 80) + '…' : command
}

/**
 * Start a background shell job. The approval gate must already have granted
 * this command — this function executes unconditionally.
 *
 * @returns the registry-issued job id (`strix-shell-N`).
 */
export function startBackgroundShell(
  ctx: Context,
  config: ConfigType,
  agent: Agent | undefined,
  spec: BackgroundShellSpec,
): string {
  const ws = workspaceDir(config)
  const dockerArgs = buildBackgroundDockerArgs(ws, spec)

  // Producer-owned mutable state, closed over by the hooks below.
  let child: ChildProcess | undefined
  let output = ''
  let consumed = 0
  let settled = false
  let outcome: JobOutcome = { status: 'failed', detail: 'never started' }
  let exitCode: number | null = null
  const startedAt = Date.now()
  let resolveDone!: (o: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve
  })
  /** Remove the daemon-side container (killing the CLI never stops it) and drop the cidfile. */
  const removeContainer = (): void => {
    const cid = readCidFile(spec.cidFile)
    try {
      rmSync(spec.cidFile, { force: true })
    } catch {
      /* marker cleanup is best effort */
    }
    if (cid) dockerRmContainer(cid)
  }
  const finish = (o: JobOutcome) => {
    if (settled) return
    settled = true
    outcome = o
    if (timer) clearTimeout(timer)
    removeContainer()
    // Foreground runs log a result to evidence/log.jsonl; background runs
    // must not be an audit hole — log completion here (best effort).
    logEvidence(config, {
      ts: new Date().toISOString(),
      kind: 'result',
      tool: 'strix_shell',
      callId: spec.callId,
      exitCode,
      durationMs: Date.now() - startedAt,
    })
    resolveDone(o)
  }
  let timer: NodeJS.Timeout | undefined
  const MAX_OUTPUT = 400_000

  const id = ctx.jobs.start({
    kind: 'strix-shell',
    label: jobLabel(spec.command),
    owner: agent,
    run(): JobHooks {
      const proc = spawn('docker', dockerArgs, { shell: false, windowsHide: true })
      child = proc
      timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        // The CLI is dead but the container is not — remove it so a
        // timed-out scan cannot keep running against the target unseen.
        // finish() reaps the cidfile as well (idempotent).
        const cid = readCidFile(spec.cidFile)
        if (cid) dockerRmContainer(cid)
        finish({ status: 'failed', detail: 'timeout exceeded (container removed)' })
      }, spec.timeoutMs)

      proc.stdout?.on('data', (d: Buffer) => {
        if (output.length < MAX_OUTPUT) output += d.toString('utf8')
      })
      proc.stderr?.on('data', (d: Buffer) => {
        if (output.length < MAX_OUTPUT) output += d.toString('utf8')
      })
      proc.on('error', (err: Error) => {
        finish({ status: 'failed', detail: `spawn error: ${err.message}` })
      })
      proc.on('close', (code) => {
        exitCode = code
        finish(
          code === 0
            ? { status: 'completed', detail: 'exit code: 0' }
            : { status: 'failed', detail: `exit code: ${code ?? 'unknown'}` },
        )
      })

      return {
        cancel(_reason?: string) {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone; close handler settles */
          }
          // Kills the CLI, not the container: remove the daemon-side
          // container too, or a cancelled scan keeps running unseen.
          const cid = readCidFile(spec.cidFile)
          if (cid) dockerRmContainer(cid)
          // If the process ignores the signal, still settle the record so the
          // registry does not leak a zombie entry (finish is idempotent, so a
          // later close event is a harmless no-op).
          const fallback = setTimeout(() => finish({ status: 'killed', detail: 'cancelled by operator' }), 5000)
          if (typeof fallback.unref === 'function') fallback.unref()
        },
        done,
        readOutput(): string {
          const delta = output.slice(consumed)
          consumed = output.length
          const tail = output.length >= MAX_OUTPUT ? '\n[... output truncated at 400KB ...]' : ''
          return delta === '' ? `(no new output)${tail}` : delta + tail
        },
      }
    },
  })
  return id as string
}
