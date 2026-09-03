/**
 * Shared helpers for StriX-DH tools: workspace resolution, bounded output,
 * subprocess execution with timeouts, and Docker invocation.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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
 * Next free id of the form `<prefix>NNN` given the ids already in use.
 * `prefix` is the literal id prefix including its separator, e.g. `'F-'`.
 *
 * The number comes from the MAXIMUM existing id, never from the COUNT: an
 * engagement archives or deletes entries in the middle (findings move to
 * _archive/, notes get deleted), and `count + 1` then collides with a live
 * id — silently overwriting a real finding. On top of max+1 we walk forward
 * past any id still in use, so a file created outside this process (another
 * dsh instance, a manual copy) cannot be clobbered either.
 *
 * Pure — unit-tested.
 */
export function nextIdAmong(existingIds: string[], prefix: string, pad = 3): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}(\\d+)$`)
  let max = 0
  for (const id of existingIds) {
    const m = pattern.exec(id)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  return `${prefix}${String(max + 1).padStart(pad, '0')}`
}

/**
 * Write `data` to `file`, refusing to clobber an existing file (O_EXCL).
 * Returns false when the file already existed — callers re-allocate an id
 * and retry. This is what makes concurrent creators (two subagents, or a
 * second dsh process on the same workspace) fail loudly instead of
 * silently overwriting each other's findings.
 */
export function writeExclusive(file: string, data: string): boolean {
  try {
    writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    throw err
  }
}

/** True when a write failed only because the target file already existed. */
export function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST'
}

/**
 * Filesystem flavour of {@link nextIdAmong}: scans a workspace subdirectory
 * for `<prefix>NNN.json` files and returns the next free id. Used by
 * strix_finding (findings/) and strix_notes (notes/).
 */
export function nextSequentialId(dir: string, prefix: string, pad = 3): string {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return `${prefix}${String(1).padStart(pad, '0')}`
  }
  const ids = names
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
  return nextIdAmong(ids, prefix, pad)
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

/**
 * Spawn a process, capture output, enforce a timeout.
 *
 * On expiry the WHOLE process tree is killed, not just the direct child:
 * engines here shell out (`nuclei -t ...` spawning workers, `bash -c "a; b"`)
 * and a bare SIGKILL on the parent orphans the grandchildren, which keep
 * burning CPU and network after the tool call has already returned "timed
 * out". POSIX: the child is spawned detached (own process group) so a single
 * `kill(-pid)` reaps the group. Windows has no process groups, so the
 * equivalent is `taskkill /T /F`.
 */
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
      // POSIX only: own process group, so kill(-pid) reaps the tree. On
      // Windows `detached` would detach the child into its own console,
      // which buys nothing — taskkill /T walks the tree directly.
      detached: process.platform !== 'win32',
      env: { ...process.env },
    })

    const killTree = (): void => {
      if (process.platform === 'win32') {
        if (child.pid) {
          // spawnSync ON PURPOSE. The async fire-and-forget variant loses a
          // race against the child.kill() fallback: cmd dies first, and when
          // taskkill finally gets to enumerate the tree the root is gone, so
          // /T never reaches the grandchildren — which then keep the stdio
          // pipes (and this whole call) open for their full natural lifetime.
          const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          if (r.error || (r.status !== 0 && r.status !== null)) {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          }
          return
        }
      } else if (child.pid) {
        // The child was spawned detached, i.e. as its own process-group
        // leader: one negative-pid kill reaps the whole tree.
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* group already gone */
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
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
