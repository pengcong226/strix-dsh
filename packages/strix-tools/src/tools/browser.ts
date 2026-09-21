/**
 * strix_browser — Playwright-driven browser automation with per-session
 * isolation (Strix's `agent-browser --session <name>` discipline: concurrent
 * agents use separate sessions so navigation doesn't invalidate each other's
 * pages). Actions: navigate, click, fill, evaluate, screenshot, content,
 * close. Playwright is a soft dependency: the tool registers even when
 * playwright isn't installed and fails with actionable guidance at call time.
 *
 * A session is a persistent BrowserContext + Page pair: navigation state,
 * cookies, and localStorage SURVIVE between tool calls within the session
 * (login → fill → click → screenshot sequences work), until `close` or
 * plugin unload. The spray-guard is installed once per page at creation.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { checkBudget } from './budget.js'
import { evaluatePostPolicy, STATE_CHANGING_METHODS } from './http.js'
import { safeId, truncate, workspaceSub } from '../lib/util.js'

// Minimal structural types to avoid a hard dependency at build time.
interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  click(selector: string, opts?: { timeout?: number }): Promise<unknown>
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<unknown>
  evaluate<T>(fn: string): Promise<T>
  content(): Promise<string>
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<unknown>
  route(pattern: string, handler: (route: GuardedRoute) => Promise<void>): Promise<unknown>
  close(): Promise<unknown>
}
/** Structural half of a Playwright route: only what the guard touches. */
export interface GuardedRequest {
  method(): string
  url(): string
  postData(): string | null | undefined
}
export interface GuardedRoute {
  request(): GuardedRequest
  continue(): Promise<unknown>
  abort(): Promise<unknown>
}

/**
 * Automated spray-guard for browser-initiated traffic: every request the
 * page fires goes through the SAME policy as strix_http and proxy replay
 * (pre-approval match, per-path counting, cap) with NO human in the loop.
 * Reads take a fast path (no ledger touch); rejected writes are aborted
 * before they leave, and the verdict lands in `notes` for the action's
 * return text. A guard failure on a write blocks fail-closed — never a
 * silent bypass. Pure logic over scratch workspaces — unit-tested with fake
 * routes (no playwright needed).
 */
export function createSprayGuardHandler(config: ConfigType, notes: string[]): (route: GuardedRoute) => Promise<void> {
  return async (route) => {
    const req = route.request()
    let method = 'GET'
    try {
      method = req.method().toUpperCase()
    } catch {
      await route.continue().catch(() => {})
      return
    }
    if (!STATE_CHANGING_METHODS.includes(method)) {
      await route.continue().catch(() => {})
      return
    }
    try {
      const verdict = evaluatePostPolicy(config, req.url(), req.postData() ?? '', method)
      if (verdict.proceed) {
        if (verdict.note.trim()) notes.push(verdict.note.trim())
        await route.continue().catch(() => {})
      } else {
        notes.push(verdict.rejection)
        await route.abort().catch(() => {})
      }
    } catch {
      notes.push(`REJECTED: browser spray-guard error on ${method} — write blocked fail-closed, nothing was sent.`)
      await route.abort().catch(() => {})
    }
  }
}
interface BrowserLike {
  newPage(): Promise<PageLike>
  newContext(): Promise<ContextLike>
  close(): Promise<unknown>
}
/** Structural half of a Playwright BrowserContext: pages share its cookie jar. */
interface ContextLike {
  newPage(): Promise<PageLike>
  close(): Promise<unknown>
  /** Context-level routing covers every page INCLUDING popups (window.open / target=_blank). */
  route(pattern: string, handler: (route: GuardedRoute) => Promise<void>): Promise<unknown>
}

interface Session {
  browser: BrowserLike
  context: ContextLike
  page: PageLike
  /** Spray-guard route installed once per context; later calls reuse it. */
  guardInstalled: boolean
  /**
   * Session-level guard notes. The route handler is installed ONCE but
   * pushes verdicts on every request across every execute call — so the
   * array must live on the session, not in a per-call closure (the closure
   * captured the first call's array and every verdict from the second call
   * on vanished into an orphan — regression). Each call drains what
   * accumulated during its action.
   */
  guardNotes: string[]
}

const sessions = new Map<string, Session>()
/**
 * In-flight session creations. Two concurrent calls for the SAME session name
 * both missed the `sessions.get` hit and each launched a browser — one entry
 * overwrote the other in the map and the loser browser leaked (never closed,
 * invisible to close/unload). The promise cache makes creation single-flight:
 * concurrent callers await the SAME launch. A failed launch is removed so a
 * retry can try again.
 */
const sessionPromises = new Map<string, Promise<Session>>()
let playwrightUnavailable = false

/**
 * Get or create a session: one BrowserContext + one long-lived Page per
 * session name. The context keeps cookies/localStorage across calls; the page
 * keeps navigation state. The spray-guard route is installed on the context
 * once, at creation — later calls reuse the guarded context.
 */
async function getSession(config: ConfigType, session: string): Promise<Session> {
  const existing = sessions.get(session)
  if (existing) return existing
  const inflight = sessionPromises.get(session)
  if (inflight) return inflight
  const created = createSession(config, session)
  sessionPromises.set(session, created)
  try {
    const entry = await created
    sessions.set(session, entry)
    return entry
  } finally {
    sessionPromises.delete(session)
  }
}

async function createSession(config: ConfigType, _session: string): Promise<Session> {
  let pw: typeof import('playwright')
  try {
    pw = await import('playwright')
  } catch {
    playwrightUnavailable = true
    throw new Error(
      'playwright is not installed. Install it in this package: npm install playwright && npx playwright install chromium',
    )
  }
  const browser = await pw.chromium.launch({ headless: config.browserHeadless })
  // serviceWorkers: 'block' — a service worker's fetches bypass page/context
  // routing, which would make the spray-guard (and any page-level policy)
  // unenforceable for SW-driven writes. Blocking SW entirely is the only
  // sound default for a validation browser.
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  return { browser, context, page, guardInstalled: false, guardNotes: [] }
}

export function registerBrowser(ctx: Context, config: ConfigType) {
  // Dispose browsers when the plugin unloads/reloads.
  ctx.effect(() => {
    return () => {
      for (const entry of sessions.values()) {
        void entry.browser.close().catch(() => {})
      }
      sessions.clear()
    }
  })

  ctx.tools.register(
    defineTool({
      name: 'strix_browser',
      description:
        'Automated Chromium session (Playwright) for XSS/CSRF/clickjacking/auth-flow validation — the dynamic ' +
        'half of validation where raw HTTP is not enough. Sessions are PERSISTENT: one BrowserContext + Page per ' +
        'session name, so navigation, cookies, and localStorage SURVIVE between calls — login once, then fill/' +
        'click/screenshot in later calls. Use a distinct session per agent/task so concurrent work does not ' +
        'invalidate each other\u2019s pages. Session names are plain identifiers (letters/digits/dash/underscore/' +
        'dot); screenshot files derive from them. Sessions live in this plugin process — parallel engagements ' +
        'sharing one process must use distinct names. Every page carries the automated spray-guard: browser-fired ' +
        'writes (form submits, XHR/fetch from evaluate) go through the same pre-approval/cap policy as strix_http ' +
        'with no human involved — over-cap writes are aborted before they leave and stamped into the action result. ' +
        'Close sessions when done. Only against authorized targets.',
      parameters: {
        action: { type: 'string', required: true, description: 'navigate | click | fill | evaluate | screenshot | content | close' },
        session: { type: 'string', description: 'Session name for isolation. Default "default".' },
        url: { type: 'string', description: 'navigate: target URL.' },
        selector: { type: 'string', description: 'click/fill: CSS selector.' },
        value: { type: 'string', description: 'fill: text to type. evaluate: JS expression to run in the page.' },
        wait_until: { type: 'string', description: 'navigate: load | domcontentloaded | networkidle. Default "load".' },
        full_page: { type: 'boolean', description: 'screenshot: capture full scrollable page.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { action: string; session?: string; url?: string; selector?: string; value?: string; wait_until?: string; full_page?: boolean }
        const sessionName = args.session ?? 'default'
        if (!safeId(sessionName)) return `REJECTED: bad session name "${sessionName}" (letters/digits/dash/underscore/dot only).`

        if (args.action === 'close') {
          const entry = sessions.get(sessionName)
          if (!entry) return `Session "${sessionName}" not open.`
          sessions.delete(sessionName)
          await entry.browser.close().catch(() => {})
          return `Session "${sessionName}" closed.`
        }

        // Budget gate AFTER close: cleanup must stay available over budget,
        // but browser automation is an execution-class operation — 'block'
        // must refuse it like shell/pybox, not just recon/sast.
        const budgetGate = checkBudget(config, 'strix_browser')
        if (budgetGate.over && config.budgetAction === 'block') return budgetGate.message

        let entry: Session
        try {
          entry = await getSession(config, sessionName)
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }

        // The page is long-lived: navigation, cookies, and localStorage from
        // previous calls in this session are still here.
        const page = entry.page
        // Automated enforcement, no human: intercept every request the
        // context fires (page + popups) and run writes through the shared
        // spray-guard. Reads take a fast path; verdicts accumulate in the
        // SESSION-level guardNotes and each call drains what its action
        // produced.
        const withNotes = (text: string): string => {
          if (entry.guardNotes.length === 0) return text
          const drained = entry.guardNotes.splice(0, entry.guardNotes.length)
          return `${text}\n${drained.join('\n')}`
        }
        if (config.browserEnforcePostPolicy && !entry.guardInstalled) {
          try {
            // Context-level route: covers the page AND popups opened from it
            // (window.open / target=_blank) — page.route would leave popup
            // writes completely unguarded.
            await entry.context.route('**/*', createSprayGuardHandler(config, entry.guardNotes))
            entry.guardInstalled = true
          } catch {
            // Fail-closed: without the guard, writes on this session would
            // be uncounted and uncapped — the tool promises the operator
            // "over-cap writes are aborted before they leave", so a session
            // we cannot enforce on must not run actions at all.
            return 'REJECTED: browser spray-guard could not attach to this session — write enforcement is unavailable, '
              + 'so no action runs. Close the session (action=close) and retry; if it persists, check the Playwright install '
              + 'or disable browserEnforcePostPolicy only if you accept unguarded pages.'
          }
        }
        switch (args.action) {
            case 'navigate': {
              if (!args.url) return 'REJECTED: url is required for navigate.'
              // Scheme guard: file:// turns navigate+content/screenshot into a
              // local-file read channel (and chrome:// leaks environment
              // info) — a validation browser only speaks http(s).
              try {
                const scheme = new URL(args.url).protocol.replace(':', '').toLowerCase()
                if (scheme !== 'http' && scheme !== 'https') {
                  return `REJECTED: navigate only accepts http/https URLs (got "${scheme}:"). Local files and browser-internal pages are out of scope.`
                }
              } catch {
                return `REJECTED: could not parse url "${args.url}".`
              }
              await page.goto(args.url, { waitUntil: args.wait_until ?? 'load', timeout: 30_000 })
              // Wrap as an expression: a bare identifier like `document.title`
              // evaluates to undefined in Playwright's expression context.
              const title = await page.evaluate<unknown>('(() => document.title)()')
              return withNotes(budgetGate.over ? `${budgetGate.message}\nNavigated ${args.url} — title: ${title}` : `Navigated ${args.url} — title: ${title}`)
            }
            case 'click': {
              if (!args.selector) return 'REJECTED: selector is required for click.'
              await page.click(args.selector, { timeout: 10_000 })
              return withNotes(budgetGate.over ? `${budgetGate.message}\nClicked ${args.selector}.` : `Clicked ${args.selector}.`)
            }
            case 'fill': {
              if (!args.selector || args.value === undefined) return 'REJECTED: selector and value are required for fill.'
              await page.fill(args.selector, args.value, { timeout: 10_000 })
              return withNotes(budgetGate.over ? `${budgetGate.message}\nFilled ${args.selector}.` : `Filled ${args.selector}.`)
            }
            case 'evaluate': {
              if (!args.value) return 'REJECTED: value (JS expression) is required for evaluate.'
              // Try the input as an EXPRESSION first (the common case: a
              // bare identifier like `document.title` is a valid expression
              // and needs no wrapping); if the page rejects it as a syntax
              // error, retry once wrapped as an IIFE so multi-statement
              // snippets (`let x = 1; x + 2`) also work. The previous
              // `includes('=>')` heuristic mis-wrapped arrow functions and
              // let statement strings through unwrapped, both failing.
              let result: unknown
              let usedStatementFallback = false
              try {
                result = await page.evaluate<unknown>(args.value)
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                if (!/SyntaxError|Unexpected (token|end|identifier)|Unexpected token/i.test(msg)) throw err
                result = await page.evaluate<unknown>(`(() => { ${args.value} })()`)
                usedStatementFallback = true
              }
              const rendered =
                typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? String(result)
              const suffix = usedStatementFallback ? '\n[ran as statements — pass a single expression to avoid the retry]' : ''
              return withNotes(truncate(rendered, 10_000) + suffix)
            }
            case 'screenshot': {
              const dir = workspaceSub(config, 'screenshots')
              const path = join(dir, `${sessionName}-${Date.now()}.png`)
              await page.screenshot({ path, fullPage: args.full_page ?? false })
              const text = `Screenshot saved: ${path} (view it with the read_image tool).`
              return withNotes(budgetGate.over ? `${budgetGate.message}\n${text}` : text)
            }
            case 'content': {
              const html = await page.content()
              const text = truncate(html, 20_000)
              return withNotes(budgetGate.over ? `${budgetGate.message}\n${text}` : text)
            }
            default:
              return `Unknown action "${args.action}". Use navigate | click | fill | evaluate | screenshot | content | close.`
        }
      },
    }),
  )
}

export { playwrightUnavailable }
