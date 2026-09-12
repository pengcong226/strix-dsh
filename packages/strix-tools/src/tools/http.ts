/**
 * strix_http — raw HTTP client with full request control (the Burp Repeater /
 * Caido replay equivalent from Strix's proxy workflow, minus the interception
 * proxy itself). Supports structured requests and fully raw request text.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { clampTimeoutMs, safeWorkspacePath, truncate, workspaceDir, workspaceSub } from '../lib/util.js'
import { isAuthorizationExpired, matchesPreApprovedPost, readAuthorization, targetCoveredByAuth } from './authorization.js'

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

/**
 * Per-path counter for non-preapproved POSTs sent under a live attestation
 * (spray guard). Persisted as an APPEND-ONLY JSONL ledger in
 * workspace/http-post-counts.jsonl so concurrent agents share one budget.
 *
 * The previous implementation rewrote a JSON object (read → mutate → write).
 * Two agents sending in the same engagement each read the old total and both
 * wrote `old + 1`, so N concurrent POSTs collapsed into one increment and the
 * cap could be exceeded. Appending one line per send has no read-modify-write
 * window, and it doubles as an audit trail of who POSTed what, when.
 *
 * Pure filesystem helpers — unit-tested.
 */
const POST_COUNTS_FILE = 'http-post-counts.jsonl'

/**
 * Pre-0.12 ledger format (a JSON object of counts). Read, never written: an
 * existing engagement must not silently get a fresh POST budget on upgrade.
 */
const POST_COUNTS_LEGACY_FILE = 'http-post-counts.json'

export function postCountsPath(config: ConfigType): string {
  return join(workspaceDir(config), POST_COUNTS_FILE)
}

function legacyPostCountsPath(config: ConfigType): string {
  return join(workspaceDir(config), POST_COUNTS_LEGACY_FILE)
}

/** Tally the append-only ledger. A torn line is skipped, not fatal; a `void` line cancels one claim (see claimPostCount). */
export function tallyPostLog(config: ConfigType): Record<string, number> {
  const file = postCountsPath(config)
  if (!existsSync(file)) return {}
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, number> = {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { path?: unknown; void?: unknown }
      if (typeof parsed?.path !== 'string' || !parsed.path) continue
      if (parsed.void === true) {
        // A void line cancels ONE claim (written by claimPostCount when a
        // concurrent racer already took the last slot). Never below zero.
        out[parsed.path] = Math.max(0, (out[parsed.path] ?? 0) - 1)
      } else {
        out[parsed.path] = (out[parsed.path] ?? 0) + 1
      }
    } catch {
      /* skip the torn line; the rest of the ledger still counts */
    }
  }
  return out
}

function readLegacyPostCounts(config: ConfigType): Record<string, number> {
  const file = legacyPostCountsPath(config)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v)
    }
    return out
  } catch {
    return {}
  }
}

/** Current per-path totals: append-only ledger plus any legacy totals. */
export function readPostCounts(config: ConfigType): Record<string, number> {
  const counts = readLegacyPostCounts(config)
  for (const [path, n] of Object.entries(tallyPostLog(config))) {
    counts[path] = (counts[path] ?? 0) + n
  }
  return counts
}

/**
 * CLAIM one non-preapproved send against the per-path cap and return the
 * resulting valid count. Claim-then-check, not check-then-bump: the previous
 * read→decide→append order let two concurrent senders both read `seen < cap`,
 * both proceed, and both append — the cap was soft by exactly the number of
 * racers. Here the claim line is appended FIRST and the decision reads the
 * ledger back: a claim that lands beyond the cap is voided by appending a
 * `{void:true}` line (tally subtracts it), so at most `cap` valid claims ever
 * exist per path. Over-refusal under a race (both racers void) is possible —
 * fail-closed direction. `cap=0` means unlimited (claim always granted).
 * Filesystem-touching — unit-tested.
 */
export function claimPostCount(config: ConfigType, path: string, cap: number): { granted: boolean; count: number } {
  const before = readPostCounts(config)[path] ?? 0
  if (cap > 0 && before >= cap) return { granted: false, count: before }
  const ts = new Date().toISOString()
  try {
    appendFileSync(postCountsPath(config), `${JSON.stringify({ ts, path })}\n`, 'utf8')
  } catch {
    /* best-effort audit persistence: the send proceeds regardless */
  }
  const after = readPostCounts(config)[path] ?? 0
  if (cap > 0 && after > cap) {
    try {
      appendFileSync(postCountsPath(config), `${JSON.stringify({ ts, path, void: true })}\n`, 'utf8')
    } catch {
      /* best-effort: the refused claim stays in the tally (tighter cap) */
    }
    return { granted: false, count: after - 1 }
  }
  return { granted: true, count: after }
}

export type PostPolicyOutcome =
  | { proceed: true; note: string }
  | { proceed: false; rejection: string }

/** Verbs that change server state and therefore go through the spray-guard. Reads (GET/HEAD/OPTIONS) are uncounted by design. */
export const STATE_CHANGING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * Normalize a pathname into the per-path budget key: strip matrix params
 * (`;`), collapse duplicate slashes, drop the trailing slash, lowercase.
 * `/login`, `/login/`, `/login//`, `/login;a=1`, `/LOGIN` otherwise each
 * got an INDEPENDENT budget — rotating the path spelling bypassed the cap
 * (regression). Over-merging only tightens the cap (fail-closed direction).
 * Pure — unit-tested.
 */
export function normalizePathKey(pathname: string): string {
  let p = pathname.split(';')[0]
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p.toLowerCase()
}

/**
 * Shared state-changing-request spray-guard behind strix_http, strix_proxy
 * replay, and the browser page guard, so no caller can bypass the counting,
 * audit stamp, and per-path cap (Strix autonomy enabler, four branches):
 * (0) a LIVE (unexpired) attestation exists but the target host is NOT
 *     covered by its targets → REFUSE. Writes are the sensitive class; a
 *     recorded engagement boundary that state-changing requests can silently
 *     step outside is not a boundary (mirrors the recon/sast gates).
 * (a) pre-approved path+body in authorization.json (covered host) →
 *     proceed, stamp the clearance line (audit trail).
 * (b) non-preapproved but a live attestation covers the host → proceed,
 *     stamp an audit line with the per-path count, and enforce
 *     httpPostCapPerPath as the spray guard (over-cap refuses and points at
 *     needs_follow_up + pre-approval).
 * (c) no attestation → proceed exactly as before (send, no stamp).
 *
 * Covers POST, PUT, PATCH, and DELETE — the verbs that change server state.
 * Counts are keyed by the normalized path across all four verbs (a spray is
 * a spray whatever the verb and whatever the spelling), and pre-approval
 * entries match exact path+body on any of them. GET/HEAD/OPTIONS stay
 * uncounted by design (reads, not writes).
 *
 * Filesystem-touching (reads authorization.json, appends the counts ledger);
 * unit-tested against a scratch workspace.
 */
export function evaluatePostPolicy(config: ConfigType, url: string, body: string, method = 'POST'): PostPolicyOutcome {
  // Reads are uncounted by design — and gating here (not at call sites)
  // means no caller can forget the check and silently bypass the guard.
  if (!STATE_CHANGING_METHODS.includes(method.toUpperCase())) return { proceed: true, note: '' }
  try {
    const urlObj = new URL(url)
    const pathKey = normalizePathKey(urlObj.pathname)
    const auth = readAuthorization(config)
    if (auth && !isAuthorizationExpired(auth)) {
      // Branch (0): a live attestation bounds the engagement — a write to a
      // host it does not cover is refused, not silently sent.
      if (!targetCoveredByAuth(auth, url)) {
        return {
          proceed: false,
          rejection: `REJECTED: ${method} ${urlObj.host} is outside the recorded authorization targets (${auth.targets.join(', ')}). `
            + 'Ask the operator to extend the attestation (strix_authorization set) — do not test outside the recorded scope.',
        }
      }
      if (matchesPreApprovedPost(auth, urlObj.pathname, body)) {
        return {
          proceed: true,
          note: `\n[pre-approved ${method} ${urlObj.pathname} — operator clearance in authorization.json, proceeded without asking]`,
        }
      }
      const cap = config.httpPostCapPerPath
      const claim = claimPostCount(config, pathKey, cap)
      if (!claim.granted) {
        return {
          proceed: false,
          rejection: `REJECTED: per-path state-changing cap reached for ${pathKey} (${claim.count}/${cap} non-preapproved sends already made under this attestation). `
            + `Record a needs_follow_up coverage entry naming this path and ask the operator to pre-approve it (authorization.json pre_approved_post_paths) or raise the cap — do not retry with reworded bodies or respelled paths.`,
        }
      }
      return {
        proceed: true,
        note: `\n[non-preapproved ${method} ${pathKey} — live authorization (${auth.targets.join(', ')}), count ${claim.count}/${cap > 0 ? cap : '∞'}, proceeded without asking]`,
      }
    }
  } catch {
    /* unparsable URL: no pre-approval match, proceed normally */
  }
  return { proceed: true, note: '' }
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
  const timeoutMs = clampTimeoutMs(opts.timeoutMs, config.httpTimeoutMs)
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

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  // The timeout covers the WHOLE exchange: headers + body. The abort signal
  // stays live through body reception so a slow-drip or endless body cannot
  // hang the tool past the configured timeout (previously the timer was
  // cleared the moment headers arrived).
  //
  // The body is received through a byte-bounded stream read, not
  // response.text(): a multi-GB body otherwise flows fully into memory
  // before httpMaxBodyChars truncates the DISPLAY copy. At the limit the
  // stream is cancelled — the connection is torn down, the rest discarded.
  const maxBytes = config.httpMaxBodyBytes > 0 ? config.httpMaxBodyBytes : Number.POSITIVE_INFINITY
  let rawBody: string
  let byteCapped = false
  try {
    if (response.body && maxBytes !== Number.POSITIVE_INFINITY) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let text = ''
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        text += decoder.decode(value, { stream: true })
        if (received >= maxBytes) {
          byteCapped = true
          await reader.cancel().catch(() => {})
          break
        }
      }
      rawBody = text + decoder.decode()
    } else {
      rawBody = await response.text()
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.includes('abort')) {
      const text = `Request failed: timeout after ${timeoutMs}ms while receiving the body (aborted). Headers arrived (HTTP ${response.status}); the body stream stalled — treat as an unreliable target, do not retry blindly.`
      return { text, ok: false, status: 0, rawBody: '', finalUrl: url }
    }
    const text = `Request failed while receiving the body: ${reason}. Partial transfer — treat as an unreliable target, not as a finding.`
    return { text, ok: false, status: 0, rawBody: '', finalUrl: url }
  } finally {
    clearTimeout(timer)
  }
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
    byteCapped ? `[body reception stopped at ${config.httpMaxBodyBytes} bytes (httpMaxBodyBytes) — the rest was discarded; raise the limit or use a ranged request if you genuinely need more]` : '',
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
        + 'suspected issues with concrete evidence. State-changing requests (POST/PUT/PATCH/DELETE) matching authorization.json pre_approved_post_paths '
        + '(exact path + body) proceed WITHOUT asking — the clearance is stamped in the output; other writes count against the per-path cap. '
        + 'Only for authorized targets.',
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

        const method = (parsed?.method ?? args.method ?? 'GET').toUpperCase()
        const body = parsed?.body ?? args.body ?? ''
        // State-changing policy: shared with strix_proxy replay
        // (evaluatePostPolicy) — a replayed write must not bypass the
        // counting, audit stamp, or cap. The verb check lives inside the
        // helper so no call site can forget it.
        let postNote = ''
        {
          const verdict = evaluatePostPolicy(config, url, body, method)
          if (!verdict.proceed) return verdict.rejection
          postNote = verdict.note
        }
        const sent = await sendHttpRequest(config, {
          url,
          method: parsed?.method ?? args.method,
          headers: parsed?.headers ?? args.headers,
          body: parsed?.body ?? args.body,
          followRedirects: args.follow_redirects,
          timeoutMs: args.timeout_ms,
        })
        if (!args.save_to || !sent.ok) return `${sent.text}${postNote}`
        const dir = workspaceSub(config, 'responses')
        const target = safeWorkspacePath(dir, args.save_to)
        if (!target) return `${sent.text}${postNote}\nREJECTED: save_to must be a relative path inside workspace/responses/ (no .., no absolute paths).`
        const { dirname } = await import('node:path')
        const { mkdirSync } = await import('node:fs')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, sent.rawBody, 'utf8')
        return `${sent.text}${postNote}\n[full body saved to ${target}]`
      },
    }),
  )
}
