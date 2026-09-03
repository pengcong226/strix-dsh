/**
 * Shared helpers for StriX-DH tools: workspace resolution, bounded output,
 * subprocess execution with timeouts, and Docker invocation.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { ConfigType } from '../config.js'

/** Harness home: mirrors dsh-home-paths ($DSH_HOME or ~/.dsh). */
export function dshHome(): string {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/** Directory where operators can drop engine binaries for auto-discovery. */
export function dshBinDir(): string {
  return join(dshHome(), 'bin')
}

/** Resolve (and create) the shared engagement workspace directory. */
export function workspaceDir(config: ConfigType): string {
  if (config.workspaceDir.trim() === '') {
    // Stable default: anchor to the harness home so the workspace survives
    // boots from any working directory.
    const dir = join(dshHome(), 'strix-workspace')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = isAbsolute(config.workspaceDir)
    ? config.workspaceDir
    : resolve(process.cwd(), config.workspaceDir)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Ensure a subdirectory of the workspace exists and return its absolute path. */
export function workspaceSub(config: ConfigType, ...parts: string[]): string {
  const dir = join(workspaceDir(config), ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Guard for model-supplied path fragments (ids, filenames, save_to): only
 * letters, digits, dash, underscore, dot — and no leading dot, no `..`.
 * Rejects traversal (`../`), separators, and absolute paths alike.
 */
export function safeId(value: string): boolean {
  if (!value || value.length > 128) return false
  if (value.startsWith('.')) return false
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/**
 * Resolve a model-supplied relative path under a workspace base directory.
 * Returns null when the resolved path escapes the base (traversal attempt).
 */
export function safeWorkspacePath(base: string, rel: string): string | null {
  if (!rel || rel.trim() === '') return null
  const resolved = resolve(base, rel)
  const baseResolved = resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + sep)) return null
  return resolved
}

/** Bound a string for model consumption, stating the truncation explicitly. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  return `${cut}\n\n[... truncated: showing ${maxChars} of ${text.length} characters — full output saved to workspace when the tool supports save_to ...]`
}

export interface RunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** Spawn a process, capture output, enforce a timeout (kills the tree on expiry). */
export function runProcess(
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; maxOutputChars?: number },
): Promise<RunResult> {
  const maxChars = opts.maxOutputChars ?? 400_000
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxChars * 4) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxChars * 4) stderr += d.toString('utf8')
    })

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode, signal, timedOut, stdout, stderr })
    }
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/**
 * Run a one-shot command inside a Docker container with the workspace mounted
 * at /workspace (read-write). Used by strix_shell and strix_pybox.
 */
export async function dockerRun(
  config: ConfigType,
  opts: {
    image: string
    command: string[]
    timeoutMs: number
    network: boolean
    workdir?: string
    /** Extra -v mounts (host path already formatted for docker). */
    extraVolumes?: string[]
    /** Skip the default workspace mount (e.g. when mounting a different dir). */
    skipWorkspaceMount?: boolean
  },
): Promise<RunResult & { dockerMissing?: boolean }> {
  const ws = workspaceDir(config)
  const args = [
    'run',
    '--rm',
    ...(!opts.skipWorkspaceMount ? ['-v', `${ws}:/workspace`] : []),
    ...(opts.extraVolumes ?? []),
    '-w',
    opts.workdir ?? '/workspace',
    ...(opts.network ? [] : ['--network', 'none']),
    opts.image,
    ...opts.command,
  ]
  const result = await runProcess('docker', args, { timeoutMs: opts.timeoutMs })
  if (result.exitCode !== 0 && /docker.*(not recognized|not found|cannot find)/i.test(result.stderr)) {
    return { ...result, dockerMissing: true }
  }
  if (result.exitCode === 125 && /Cannot connect to the Docker daemon/is.test(result.stderr)) {
    return { ...result, dockerMissing: true }
  }
  return result
}

/** Locate an engine binary: configured dir, then ~/.dsh/bin, then PATH. */
export function findBinary(config: ConfigType, name: string): string | null {
  const exe = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name
  const searchDirs: string[] = []
  if (config.binariesDir) {
    searchDirs.push(
      isAbsolute(config.binariesDir) ? config.binariesDir : resolve(process.cwd(), config.binariesDir),
    )
  }
  searchDirs.push(dshBinDir())
  searchDirs.push(...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'))
  for (const dir of searchDirs) {
    if (!dir) continue
    const candidate = join(dir.trim(), exe)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Format a RunResult as bounded, model-facing text. */
export function formatRunResult(result: RunResult, maxChars: number): string {
  const parts: string[] = []
  parts.push(
    result.timedOut
      ? `[timed out and killed]`
      : `[exit code: ${result.exitCode ?? 'unknown'}${result.signal ? `, signal: ${result.signal}` : ''}]`,
  )
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${truncate(result.stdout, maxChars)}`)
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${truncate(result.stderr, Math.min(maxChars, 10_000))}`)
  return parts.join('\n')
}
