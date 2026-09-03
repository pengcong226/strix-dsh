/**
 * strix_http — raw HTTP client with full request control (the Burp Repeater /
 * Caido replay equivalent from Strix's proxy workflow, minus the interception
 * proxy itself). Supports structured requests and fully raw request text.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import type { ConfigType } from '../config.js'
import { safeWorkspacePath, truncate, workspaceSub } from '../lib/util.js'

interface HttpArgs {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Full raw HTTP request (request line + headers + body). Overrides the structured fields. */
  raw_request?: string
  follow_redirects?: boolean
  timeout_ms?: number
  /** Save the untruncated response body to workspace/responses/<save_to>. */
  save_to?: string
}

interface HttpResult {
  status: number
  status_text: string
  headers: Record<string, string>
  body: string
  body_truncated: boolean
  duration_ms: number
  final_url: string
  saved_to?: string
}

export function parseRawRequest(raw: string): { url?: string; method: string; headers: Record<string, string>; body?: string } {  const normalized = raw.replace(/\r\n/g, '\n')
  const splitAt = normalized.indexOf('\n\n')
  const head = splitAt === -1 ? normalized : normalized.slice(0, splitAt)
  const body = splitAt === -1 ? undefined : normalized.slice(splitAt + 2)
  const lines = head.split('\n')
  const requestLine = lines[0]?.trim().split(/\s+/) ?? []
  const method = requestLine[0] ?? 'GET'
  const path = requestLine[1] ?? '/'
  const headers: Record<string, string> = {}
  let host = ''
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'host') host = value
    else headers[key] = value
  }
  let url: string | undefined
  if (/^https?:\/\//i.test(path)) {
    url = path
  } else if (host) {
    url = `http://${host}${path.startsWith('/') ? path : `/${path}`}`
  }
  return { url, method, headers, body }
}

export interface SendHttpOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  followRedirects?: boolean
  timeoutMs?: number
}

/**
 * Shared sender behind strix_http and strix_proxy replay: one fetch path,
 * one output format. Pure function of config + options — no tool context.
 * Returns the model-facing text plus the raw body and status for callers
 * that need to persist or branch on them.
 */
export async function sendHttpRequest(
  config: ConfigType,
  opts: SendHttpOptions,
): Promise<{ text: string; ok: boolean; status: number; rawBody: string; finalUrl: string }> {
  const url = opts.url
  const method = (opts.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  const body = opts.body

  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? config.httpTimeoutMs
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined && method !== 'GET' && method !== 'HEAD' ? body : undefined,
      redirect: (opts.followRedirects ?? true) ? 'follow' : 'manual',
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.includes('abort')) {
      const text = `Request failed: timeout after ${timeoutMs}ms (aborted). The host may be filtered, down, or the port/scheme wrong — fix the target rather than retrying blindly.`
      return { text, ok: false, status: 0, rawBody: '', finalUrl: url }
    }
    const text = `Request failed: ${reason}. Check DNS, scheme (http/https), and port; a refused connection means nothing is listening — treat as unreachable, not as a finding.`
    return { text, ok: false, status: 0, rawBody: '', finalUrl: url }
  }
  clearTimeout(timer)

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  const rawBody = await response.text()
  const durationMs = Date.now() - started

  const result: HttpResult = {
    status: response.status,
    status_text: response.statusText,
    headers: responseHeaders,
    body: truncate(rawBody, config.httpMaxBodyChars),
    body_truncated: rawBody.length > config.httpMaxBodyChars,
    duration_ms: durationMs,
    final_url: response.url,
    saved_to: undefined,
  }

  const headerLines = Object.entries(result.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const text = [
    `HTTP ${result.status} ${result.status_text} — ${result.duration_ms}ms — ${result.final_url}`,
    headerLines,
    result.body_truncated ? `[body truncated at ${config.httpMaxBodyChars} chars]` : '',
    '',
    result.body,
  ]
    .filter(Boolean)
    .join('\n')
  return { text, ok: true, status: response.status, rawBody, finalUrl: response.url }
}

export function registerHttp(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_http',
      description:
        'Send a raw HTTP request with full control (method, headers, body, or a complete raw request text) '
        + 'and inspect the response. The replay workflow from Strix: use it to reproduce and validate '
        + 'suspected issues with concrete evidence. Only for authorized targets.',
      parameters: {
        url: { type: 'string', description: 'Target URL. Omit when raw_request includes an absolute request target.' },
        method: { type: 'string', description: 'HTTP method. Default GET.' },
        headers: { type: 'object', additionalProperties: true, description: 'Request headers as key/value pairs.' },
        body: { type: 'string', description: 'Request body (sent as-is).' },
        raw_request: {
          type: 'string',
          description:
            'Complete raw HTTP request text (e.g. from captured traffic): request line, headers, blank line, body. '
            + 'Overrides url/method/headers/body. Use an absolute-form request line or a Host header.',
        },
        follow_redirects: { type: 'boolean', description: 'Follow 3xx redirects. Default true.' },
        timeout_ms: { type: 'number', description: 'Request timeout in milliseconds. Default from plugin config.' },
        save_to: {
          type: 'string',
          description: 'Save the full response body to workspace/responses/<save_to> (relative path). '
            + 'The tool output stays truncated; use this for large bodies.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as HttpArgs
        const parsed = args.raw_request ? parseRawRequest(args.raw_request) : null
        const url = parsed?.url ?? args.url
        if (!url) return 'Error: no target. Provide url, or a raw_request with an absolute request line or Host header.'

        const sent = await sendHttpRequest(config, {
          url,
          method: parsed?.method ?? args.method,
          headers: parsed?.headers ?? args.headers,
          body: parsed?.body ?? args.body,
          followRedirects: args.follow_redirects,
          timeoutMs: args.timeout_ms,
        })
        if (!args.save_to || !sent.ok) return sent.text
        const dir = workspaceSub(config, 'responses')
        const target = safeWorkspacePath(dir, args.save_to)
        if (!target) return `${sent.text}\nREJECTED: save_to must be a relative path inside workspace/responses/ (no .., no absolute paths).`
        const { dirname } = await import('node:path')
        const { mkdirSync } = await import('node:fs')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, sent.rawBody, 'utf8')
        return `${sent.text}\n[full body saved to ${target}]`
      },
    }),
  )
}
