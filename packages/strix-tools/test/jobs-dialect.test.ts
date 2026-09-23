/**
 * Jobs-registry dialect tests: dsh 0.1.7 restructured `ctx.jobs` (JobHandle
 * push model, SessionId fences), while <=0.1.6 keeps the Agent-object
 * dialect with the producer's readOutput() hook. One plugin build serves
 * both runtimes — these tests pin both branches of the adapter in
 * src/lib/jobs.ts. Docker is never invoked: node:child_process.spawn is
 * mocked, so startBackgroundShell runs against a fake ChildProcess.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnMock }))

import type { ConfigType } from '../src/config.js'
import { jobsCaller, listTrackedShellJobs, modernJobsRegistry, newCidFile, startBackgroundShell } from '../src/lib/jobs.js'

function scratchConfig(): ConfigType {
  return {
    workspaceDir: mkdtempSync(join(tmpdir(), 'strix-jobs-test-')),
    httpTimeoutMs: 1000, httpMaxBodyChars: 200, httpMaxBodyBytes: 2_000_000, httpPostCapPerPath: 5,
    shellImage: 'python:3.12-slim', shellAllowedImages: [], approvalAutoAllow: [], shellNetwork: false, shellTimeoutMs: 1000,
    pyboxImage: 'python:3.12-slim', pyboxExtraPackages: [], pyboxNetwork: false, pyboxTimeoutMs: 1000,
    binariesDir: '', reconTimeoutMs: 1000, nucleiRateLimit: 50,
    sastNucleiImage: 'x', sastSemgrepImage: 'x', sastNetwork: true, sastExtraMountRoots: [],
    depcheckTimeoutMs: 5_000, finishJobWaitMs: 200, proxyImage: 'x', browserHeadless: true, browserEnforcePostPolicy: true,
    strictEvidence: true, approvalGate: 'off', budgetLimitUsd: 0, budgetInputPer1k: 0, budgetOutputPer1k: 0, budgetAction: 'warn',
  } as ConfigType
}

/** Fake ChildProcess: EventEmitter core + stream emitters + kill spy. */
function fakeProc(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const proc = new EventEmitter() as never as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  spawnMock.mockReturnValueOnce(proc)
  return proc
}

/** Capturing registry fake; `modern: true` adds the 0.1.7 `events` marker. */
function fakeRegistry(modern: boolean) {
  const reg: {
    events?: object
    spec?: Record<string, unknown>
    start: (spec: Record<string, unknown>) => string
  } = {
    ...(modern ? { events: {} } : {}),
    start: (spec) => {
      reg.spec = spec
      return 'strix-shell-1'
    },
  }
  return reg
}

/** Fake JobHandle capturing ring appends (0.1.7 starter argument). */
function fakeJobHandle() {
  const appended: Array<{ text: string; channel?: string }> = []
  return { appended, job: { append: (text: string, options?: { channel?: string }) => appended.push({ text, channel: options?.channel }) } }
}

const baseSpec = (over: Partial<Parameters<typeof startBackgroundShell>[3]> = {}) => ({
  command: 'nmap -sV target.example',
  image: 'python:3.12-slim',
  network: false,
  timeoutMs: 60_000,
  cidFile: newCidFile(),
  ...over,
})

const agent = { id: 'agent-root' } as never

describe('registry dialect detection', () => {
  it('modernJobsRegistry: events property marks the 0.1.7 dialect', () => {
    expect(modernJobsRegistry({ jobs: {} } as never)).toBe(false)
    expect(modernJobsRegistry({ jobs: { events: {} } } as never)).toBe(true)
  })

  it('jobsCaller: Agent object on <=0.1.6, session id string on 0.1.7+', () => {
    const caller = { id: 'agent-root' }
    expect(jobsCaller({ jobs: {} } as never, caller)).toBe(caller)
    expect(jobsCaller({ jobs: { events: {} } } as never, caller)).toBe('agent-root')
    expect(jobsCaller({ jobs: { events: {} } } as never, undefined)).toBeUndefined()
  })
})

describe('startBackgroundShell on the 0.1.7 jobs dialect', () => {
  it('registers with a SessionId owner and pushes stream chunks into the ring', async () => {
    const config = scratchConfig()
    const registry = fakeRegistry(true)
    const proc = fakeProc()
    const { appended, job } = fakeJobHandle()
    const id = startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec())
    expect(id).toBe('strix-shell-1')
    expect(registry.spec!.owner).toBe('agent-root')
    expect(registry.spec!.kind).toBe('strix-shell')
    // The starter runs inside run(job); spawn happens there, not before.
    expect(spawnMock).not.toHaveBeenCalled()
    const hooks = (registry.spec!.run as (j: unknown) => { cancel: (r?: string) => void; done: Promise<unknown> })(job)
    expect(spawnMock).toHaveBeenCalledOnce()
    proc.stdout.emit('data', Buffer.from('PORT STATE SERVICE'))
    proc.stderr.emit('data', Buffer.from('warning'))
    expect(appended).toEqual([
      { text: 'PORT STATE SERVICE', channel: 'stdout' },
      { text: 'warning', channel: 'stderr' },
    ])
    proc.emit('close', 0)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 0' })
    expect(listTrackedShellJobs()).toHaveLength(0)
  })

  it('caps ring appends at 400KB with one truncation note, then drops chunks', () => {
    const config = scratchConfig()
    const registry = fakeRegistry(true)
    const proc = fakeProc()
    const { appended, job } = fakeJobHandle()
    const id = startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec())
    void id
    const hooks = (registry.spec!.run as (j: unknown) => { cancel: (r?: string) => void; done: Promise<unknown> })(job)
    void hooks
    proc.stdout.emit('data', Buffer.alloc(300_000, 'a'))
    proc.stdout.emit('data', Buffer.alloc(300_000, 'b'))
    proc.stdout.emit('data', Buffer.from('post-cap output'))
    proc.stdout.emit('data', Buffer.from('more post-cap'))
    expect(appended).toHaveLength(3)
    expect(appended[2]!.text).toBe('\n[... output truncated at 400KB ...]\n')
  })

  it('cancel kills the CLI and settles the record', async () => {
    const config = scratchConfig()
    const registry = fakeRegistry(true)
    const proc = fakeProc()
    const { job } = fakeJobHandle()
    startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec())
    const hooks = (registry.spec!.run as (j: unknown) => { cancel: (r?: string) => void; done: Promise<{ status: string; detail?: string }> })(job)
    hooks.cancel('operator stop')
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    // The close handler settles first; the 5s fallback is a no-op after that.
    proc.emit('close', null)
    const outcome = await hooks.done
    expect(['killed', 'failed']).toContain(outcome.status)
  })

  it('timeout removes the container and fails the job', async () => {
    const config = scratchConfig()
    const registry = fakeRegistry(true)
    const proc = fakeProc()
    const { job } = fakeJobHandle()
    startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec({ timeoutMs: 15 }))
    const hooks = (registry.spec!.run as (j: unknown) => { cancel: (r?: string) => void; done: Promise<{ status: string; detail?: string }> })(job)
    const outcome = await hooks.done
    expect(outcome).toEqual({ status: 'failed', detail: 'timeout exceeded (container removed)' })
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})

describe('startBackgroundShell on the <=0.1.6 jobs dialect (unchanged behavior)', () => {
  it('registers with the Agent object and serves readOutput() deltas', async () => {
    const config = scratchConfig()
    const registry = fakeRegistry(false)
    const proc = fakeProc()
    const id = startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec())
    void id
    expect(registry.spec!.owner).toBe(agent)
    const hooks = (registry.spec!.run as () => { cancel: (r?: string) => void; done: Promise<unknown>; readOutput?(): string })()
    proc.stdout.emit('data', Buffer.from('first delta'))
    expect(hooks.readOutput!()).toBe('first delta')
    expect(hooks.readOutput!()).toBe('(no new output)')
    proc.emit('close', 0)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('keeps the 400KB producer-side cap with the per-read truncation tail', () => {
    const config = scratchConfig()
    const registry = fakeRegistry(false)
    const proc = fakeProc()
    startBackgroundShell({ jobs: registry } as never, config, agent, baseSpec())
    const hooks = (registry.spec!.run as () => { readOutput?(): string })()
    proc.stdout.emit('data', Buffer.alloc(500_000, 'x'))
    const first = hooks.readOutput!()
    expect(first).toContain('[... output truncated at 400KB ...]')
    expect(hooks.readOutput!()).toBe(`(no new output)\n[... output truncated at 400KB ...]`)
  })
})
