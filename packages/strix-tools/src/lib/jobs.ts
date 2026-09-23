/**
 * Background job producer for strix_shell: long scans run as dsh jobs
 * (`ctx.jobs`) instead of blocking one tool call, and the model-facing
 * `job_output` / `job_list` / `job_kill` tools (shipped by dsh's own
 * `dsh-tool-jobs` bundle) manage them. This file owns the producer side:
 * kind registration, streaming docker spawn, and cancellation.
 *
 * dsh 0.1.7 restructured the jobs registry: the starter receives a JobHandle
 * (output is pushed into the registry-owned ring via `job.append`), the
 * producer's `readOutput()` hook is gone, and the caller/owner fence switched
 * from Agent objects to SessionId strings. dsh 0.1.6 and earlier keep the old
 * dialect. One plugin build serves both runtimes: the registry's 0.1.7-only
 * `events` property is the dialect marker, and every registry call site goes
 * through the two helpers below so the dialect choice stays in one place.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ConfigType } from '../config.js'
import { logEvidence } from './approval.js'
import { dockerRmContainer, readCidFile, workspaceDir } from './util.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'strix-shell': 'strix-shell'
  }
}

/** True when `ctx.jobs` speaks the 0.1.7 JobSpec dialect (JobHandle + events). */
export function modernJobsRegistry(ctx: Context): boolean {
  return 'events' in ctx.jobs
}

/**
 * Caller fence value for registry list/wait/kill: the Agent object on
 * <=0.1.6, the agent's session id string on 0.1.7+.
 */
export function jobsCaller(ctx: Context, caller: { id?: string } | undefined): unknown {
  return modernJobsRegistry(ctx) ? caller?.id : caller
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
 * Live strix-shell jobs this process started, for finish convergence
 * accounting. The dsh jobs registry fences list/kill by the CALLING agent
 * (an agent sees only its own jobs), so a root calling strix_report finish
 * cannot even SEE the background shells its operator children left running
 * through ctx.jobs alone. This map is process-wide (all agents share one
 * plugin instance), records every job we started with its owner, and drops
 * the entry when the job settles — finish can then report other-owned live
 * jobs honestly instead of claiming an empty convergence.
 */
const trackedShellJobs = new Map<string, { label: string; ownerAgentId?: string }>()

/** Live (unsettled) strix-shell jobs started by this process, with owners. Pure. */
export function listTrackedShellJobs(): Array<{ id: string; label: string; ownerAgentId?: string }> {
  return [...trackedShellJobs.entries()].map(([id, t]) => ({ id, ...t }))
}

/** Hooks shape of the <=0.1.6 dialect: readOutput() is the producer's delta cursor. */
type LegacyJobHooks = JobHooks & { readOutput?(): string }

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
  const modern = modernJobsRegistry(ctx)

  // Producer-owned mutable state, closed over by the hooks below.
  let child: ChildProcess | undefined
  let output = ''
  let consumed = 0
  let appendedBytes = 0
  let capped = false
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

  // Shared process wiring — spawn, timeout, error/close settlement. The two
  // registry dialects only differ in how stdout/stderr reach the job's
  // output stream (onData forwards each chunk).
  const spawnAndWire = (onData: (chunk: Buffer, channel: 'stdout' | 'stderr') => void): ChildProcess => {
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

    proc.stdout?.on('data', (d: Buffer) => onData(d, 'stdout'))
    proc.stderr?.on('data', (d: Buffer) => onData(d, 'stderr'))
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
    return proc
  }

  const cancel = (_reason?: string): void => {
    try {
      child?.kill('SIGKILL')
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
  }

  // 0.1.7+: push each chunk into the registry-owned ring. The producer-side
  // 400KB cap survives: once reached, one truncation note is appended and
  // later chunks drop (the ring's own retention is independent of it).
  const modernRun = (job: JobHandle): JobHooks => {
    spawnAndWire((chunk, channel) => {
      if (capped) return
      if (appendedBytes >= MAX_OUTPUT) {
        capped = true
        job.append('\n[... output truncated at 400KB ...]\n')
        return
      }
      appendedBytes += chunk.byteLength
      job.append(chunk.toString('utf8'), { channel })
    })
    return { cancel, done }
  }

  // <=0.1.6: producer-owned buffer plus the readOutput() delta hook.
  const legacyRun = (): LegacyJobHooks => {
    spawnAndWire((chunk) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    })
    return {
      cancel,
      done,
      readOutput(): string {
        const delta = output.slice(consumed)
        consumed = output.length
        const tail = output.length >= MAX_OUTPUT ? '\n[... output truncated at 400KB ...]' : ''
        return delta === '' ? `(no new output)${tail}` : delta + tail
      },
    }
  }

  const startSpec = modern
    ? { kind: 'strix-shell', label: jobLabel(spec.command), owner: agent?.id, run: modernRun }
    : { kind: 'strix-shell', label: jobLabel(spec.command), owner: agent, run: legacyRun }
  const id = ctx.jobs.start(startSpec as never)
  // Bookkeeping for finish convergence (see trackedShellJobs): record the
  // job with its owner, drop it once settled. `done` never rejects.
  trackedShellJobs.set(String(id), { label: jobLabel(spec.command), ownerAgentId: agent?.id })
  void done.then(() => {
    trackedShellJobs.delete(String(id))
  })
  return id as string
}
