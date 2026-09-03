/**
 * strix_proxy — mitmproxy sidecar for traffic interception (the Caido
 * workflow from Strix: list_requests HTTPQL + repeat), plus the query side.
 *
 * The sidecar runs `mitmdump` in the official mitmproxy container with the
 * workspace mounted; a bundled addon logs every flow as a JSONL summary plus
 * raw request/response files. `replay` feeds a captured request back through
 * strix_http's raw-request path — the interception→replay loop closed with
 * native tools.
 *
 * Honest limits (documented, not hidden): HTTPS bodies need the client to
 * trust the sidecar CA; without it only CONNECT metadata is captured. The
 * sidecar is one per workspace (a second start refuses while one runs).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigType } from '../config.js'
import { checkBudget } from './budget.js'
import { truncate, workspaceSub } from '../lib/util.js'
import { parseRawRequest, sendHttpRequest } from './http.js'

const ADDON_DIR = fileURLToPath(new URL('../../assets/mitmproxy/', import.meta.url))
const IMAGE = 'mitmproxy/mitmproxy:latest'

export interface FlowSummary {
  id: string
  ts: string
  method: string
  url: string
  status: number
  req_bytes: number
  rsp_bytes: number
  rsp_preview?: string
}

function proxyDir(config: ConfigType): string {
  return workspaceSub(config, 'proxy')
}

function flowsFile(config: ConfigType): string {
  return join(proxyDir(config), 'flows.jsonl')
}

/** Read all flow summaries, newest last. Pure file read — unit-testable. */
export function readFlows(config: ConfigType): FlowSummary[] {
  const file = flowsFile(config)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as FlowSummary
      } catch {
        return null
      }
    })
    .filter((f): f is FlowSummary => f !== null && typeof f.id === 'string')
}

/** Filter flows by substring over method/url/status. Pure — unit-testable. */
export function filterFlows(flows: FlowSummary[], filter: string): FlowSummary[] {
  const q = filter.toLowerCase()
  return flows.filter(
    (f) => f.method.toLowerCase().includes(q) || f.url.toLowerCase().includes(q) || String(f.status).includes(q),
  )
}

/** Format one flow line for model consumption. */
export function formatFlow(f: FlowSummary): string {
  return `${f.id} ${f.method} ${f.status} ${f.url} (req ${f.req_bytes}B / rsp ${f.rsp_bytes}B)`
}

async function dockerContainerForPort(port: number): Promise<string | null> {
  const { spawnSync } = await import('node:child_process')
  try {
    const out = spawnSync('docker', ['ps', '--format', '{{.ID}} {{.Ports}} {{.Image}}'], { encoding: 'utf8', timeout: 15_000 })
    if (out.status !== 0) return null
    for (const line of (out.stdout ?? '').split('\n')) {
      if (line.includes(`0.0.0.0:${port}->`) && line.includes('mitmproxy/mitmproxy')) {
        return line.split(/\s+/)[0] ?? null
      }
    }
    return null
  } catch {
    return null
  }
}

async function sidecarState(config: ConfigType): Promise<{ running: boolean; pid?: number; port?: number; container?: string }> {
  const file = join(proxyDir(config), 'sidecar.json')
  if (!existsSync(file)) return { running: false }
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port: number }
    // Liveness 1: the marker records the docker child pid we spawned. Only
    // valid inside the process that spawned it — headless exits invalidate it.
    let alive = false
    try {
      process.kill(state.pid, 0)
      alive = true
    } catch {
      alive = false
    }
    if (alive) return { running: true, pid: state.pid, port: state.port }
    // Liveness 2: fall back to docker ps — the container outlives us.
    const container = await dockerContainerForPort(state.port)
    if (container) return { running: true, pid: state.pid, port: state.port, container }
    return { running: false }
  } catch {
    return { running: false }
  }
}

export function registerProxy(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_proxy',
      description:
        'Mitmproxy sidecar: intercept HTTP(S) traffic from a client pointed at it, then query the capture. '
        + 'start launches the sidecar (Docker, workspace-mounted, addon logs every flow); status shows capture '
        + 'stats; list shows flow summaries (filterable); get returns one flow with full request/response; '
        + 'replay re-sends a captured request via strix_http raw replay; stop kills the sidecar. HTTPS bodies '
        + 'need the client to trust the sidecar CA — without it only CONNECT metadata is captured. '
        + 'SCOPE: one sidecar per workspace, no scope allow/deny lists — the operator scopes the engagement by '
        + 'pointing only the authorized client at the proxy port (unlike Caido scope get/list/create/update/delete, '
        + 'there is no in-tool target filter; every flow through the port is captured). '
        + 'Only against authorized targets.',
      parameters: {
        action: { type: 'string', required: true, description: 'start | status | list | get | replay | stop' },
        port: { type: 'number', description: 'start: listen port on localhost. Default 8080.' },
        filter: { type: 'string', description: 'list: substring filter over method/url/status.' },
        limit: { type: 'number', description: 'list: max flows shown, newest last. Default 20.' },
        id: { type: 'string', description: 'get/replay: flow id (F-...).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>, exec): Promise<string> {
        const args = raw as unknown as { action: string; port?: number; filter?: string; limit?: number; id?: string }
        const dir = proxyDir(config)
        void dir

        if (args.action === 'status') {
          const state = await sidecarState(config)
          const flows = readFlows(config)
          const methods = [...new Set(flows.map((f) => f.method))].join(',')
          return state.running
            ? `Sidecar running (localhost:${state.port}, ${flows.length} flows captured${methods ? `, methods: ${methods}` : ''}). Point the client at http://localhost:${state.port} as its HTTP(S) proxy.`
            : flows.length
              ? `Sidecar stopped. ${flows.length} flows from the last run are still queryable (list/get/replay).`
              : 'Sidecar not running, no captures yet. Use action=start.'
        }

        if (args.action === 'start') {
          const gate = checkBudget(config, 'strix_proxy')
          if (gate.over && config.budgetAction === 'block') return gate.message
          const warnPrefix = gate.over ? gate.message + '\n' : ''
          const state = await sidecarState(config)
          if (state.running) {
            return `${warnPrefix}Sidecar already running on localhost:${state.port}. Stop it first (action=stop) to restart on another port.`
          }
          const port = Math.floor(args.port ?? 8080)
          if (port < 1024 || port > 65535) return 'REJECTED: port must be 1024-65535.'
          const { spawn } = await import('node:child_process')
          const addonHost = join(ADDON_DIR, 'strix_addon.py')
          if (!existsSync(addonHost)) return 'REJECTED: sidecar addon missing from the bundle (assets/mitmproxy/strix_addon.py).'
          const ws = join(dir, '..')
          const child = spawn(
            'docker',
            [
              'run', '--rm',
              '-p', `${port}:8080`,
              '-v', `${ws}:/workspace`,
              '-v', `${addonHost}:/addon.py:ro`,
              IMAGE,
              'mitmdump', '-p', '8080', '-s', '/addon.py', '--set', 'confdir=/workspace/proxy/.mitmproxy',
            ],
            { shell: false, windowsHide: true, stdio: 'ignore', detached: false },
          )
          const started = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), 3000)
            child.on('error', () => {
              clearTimeout(timer)
              resolve(false)
            })
            // docker run --rm with -p detaches the port quickly; survival past
            // 3s without an error event means the daemon accepted the run.
            child.on('exit', (code) => {
              clearTimeout(timer)
              resolve(code === 0)
            })
            void timer
          })
          if (!started || !child.pid) {
            return 'Sidecar failed to start: is Docker Desktop running? (docker run mitmproxy/mitmproxy must work). Nothing is listening.'
          }
          try {
            child.unref()
          } catch {
            /* best effort */
          }
          writeFileSync(join(dir, 'sidecar.json'), JSON.stringify({ pid: child.pid, port }), 'utf8')
          return (
            `${warnPrefix}Sidecar listening on http://localhost:${port} (container mitmdump, addon logging to workspace/proxy/).\n`
            + `Point the client/browser at it as HTTP(S) proxy. Captures: workspace/proxy/flows.jsonl + flows/<id>.req/.rsp.\n`
            + `HTTPS bodies need the client to trust the sidecar CA (export it: workspace/proxy/.mitmproxy/mitmproxy-ca-cert.pem).`
          )
        }

        if (args.action === 'list') {
          const flows = args.filter ? filterFlows(readFlows(config), args.filter) : readFlows(config)
          if (flows.length === 0) return args.filter ? `No flows matching "${args.filter}".` : 'No flows captured yet.'
          const limit = Math.max(1, Math.floor(args.limit ?? 20))
          const shown = flows.slice(-limit)
          return [
            `${flows.length} flow(s)${args.filter ? ` matching "${args.filter}"` : ''}, showing last ${shown.length}:`,
            ...shown.map(formatFlow),
          ].join('\n')
        }

        if (args.action === 'get' || args.action === 'replay') {
          const id = String(args.id ?? '').trim()
          if (!id) return `REJECTED: id is required for ${args.action}.`
          if (id.includes('/') || id.includes('\\') || id.includes('..')) return `REJECTED: bad flow id "${id}".`
          const reqFile = join(dir, 'flows', `${id}.req`)
          const rspFile = join(dir, 'flows', `${id}.rsp`)
          if (!existsSync(reqFile)) {
            const known = readFlows(config).map((f) => f.id).slice(-5).join(', ') || '(none)'
            return `Flow ${id} not found. Recent ids: ${known}`
          }
          const rawReq = readFileSync(reqFile, 'utf8')
          if (args.action === 'get') {
            const rsp = existsSync(rspFile) ? readFileSync(rspFile, 'utf8') : '(no response captured)'
            return `--- request ${id} ---\n${truncate(rawReq, 8000)}\n--- response ${id} ---\n${truncate(rsp, 8000)}`
          }
          // replay: re-send the captured request through the shared sender
          // (same fetch path and output format as strix_http).
          const parsed = parseRawRequest(rawReq)
          if (!parsed.url) return `REJECTED: flow ${id} has no replayable URL (CONNECT metadata only — HTTPS without the sidecar CA).`
          const sent = await sendHttpRequest(config, {
            url: parsed.url,
            method: parsed.method,
            headers: parsed.headers,
            body: parsed.body,
          })
          return `Replay of ${id}:\n${sent.text}`
        }

        if (args.action === 'stop') {
          const state = await sidecarState(config)
          if (!state.running) return 'Sidecar not running.'
          // Kill path 1: our own spawned child (same-process start).
          let stopped = false
          if (state.pid !== undefined) {
            try {
              process.kill(state.pid, 'SIGKILL')
              stopped = true
            } catch {
              stopped = false
            }
          }
          // Kill path 2: docker stop by container id (cross-process: the
          // container outlives the headless/one-shot process that started it).
          if (!stopped) {
            const container = state.container ?? (state.port !== undefined ? await dockerContainerForPort(state.port) : null)
            if (container) {
              const { spawnSync } = await import('node:child_process')
              try {
                const out = spawnSync('docker', ['stop', container], { encoding: 'utf8', timeout: 30_000 })
                stopped = out.status === 0
              } catch {
                stopped = false
              }
            }
          }
          if (!stopped) {
            return `Could not stop the sidecar (pid ${state.pid ?? 'unknown'}${state.container ? `, container ${state.container}` : ''}). Kill it manually: docker stop <id> (docker ps | grep mitmproxy).`
          }
          try {
            const { rmSync } = await import('node:fs')
            rmSync(join(dir, 'sidecar.json'))
          } catch {
            /* marker already gone */
          }
          const n = readFlows(config).length
          return `Sidecar stopped. ${n} flow(s) remain queryable (list/get/replay).`
        }

        return `Unknown action "${args.action}". Use start | status | list | get | replay | stop.`
      },
    }),
  )
}

/** List captured flow files on disk (ids with both .req and .rsp). For runs.ts orientation. */
export function listFlowFiles(config: ConfigType): string[] {
  const flowsDir = join(proxyDir(config), 'flows')
  if (!existsSync(flowsDir)) return []
  return readdirSync(flowsDir).filter((f) => f.endsWith('.req')).map((f) => f.slice(0, -4)).sort()
}
