/**
 * strix_browser — Playwright-driven browser automation with per-session
 * isolation (Strix's `agent-browser --session <name>` discipline: concurrent
 * agents use separate sessions so navigation doesn't invalidate each other's
 * pages). Actions: navigate, click, fill, evaluate, screenshot, content,
 * close. Playwright is a soft dependency: the tool registers even when
 * playwright isn't installed and fails with actionable guidance at call time.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
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
  close(): Promise<unknown>
}

const sessions = new Map<string, BrowserLike>()
let playwrightUnavailable = false

async function getSession(config: ConfigType, session: string): Promise<BrowserLike> {
  const existing = sessions.get(session)
  if (existing) return existing
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
  sessions.set(session, browser)
  return browser
}

export function registerBrowser(ctx: Context, config: ConfigType) {
  // Dispose browsers when the plugin unloads/reloads.
  ctx.effect(() => {
    return () => {
      for (const browser of sessions.values()) {
        void browser.close().catch(() => {})
      }
      sessions.clear()
    }
  })

  ctx.tools.register(
    defineTool({
      name: 'strix_browser',
      description:
        'Automated Chromium session (Playwright) for XSS/CSRF/clickjacking/auth-flow validation — the dynamic ' +
        'half of validation where raw HTTP is not enough. Sessions are isolated per name: use a distinct ' +
        'session per agent/task so concurrent navigation does not invalidate each other\u2019s pages. Session ' +
        'names are plain identifiers (letters/digits/dash/underscore/dot); screenshot files derive from them. ' +
        'Sessions live in this plugin process — parallel engagements sharing one process must use distinct names. ' +
        'Every page carries the automated spray-guard: browser-fired writes (form submits, XHR/fetch from evaluate) ' +
        'go through the same pre-approval/cap policy as strix_http with no human involved — over-cap writes are ' +
        'aborted before they leave and stamped into the action result. ' +
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
          const browser = sessions.get(sessionName)
          if (!browser) return `Session "${sessionName}" not open.`
          await browser.close()
          sessions.delete(sessionName)
          return `Session "${sessionName}" closed.`
        }

        let browser: BrowserLike
        try {
          browser = await getSession(config, sessionName)
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }

        const page = await browser.newPage()
        // Automated enforcement, no human: intercept every request the page
        // fires and run writes through the shared spray-guard. Reads take a
        // fast path; the verdicts accumulate into guardNotes below.
        const guardNotes: string[] = []
        const withNotes = (text: string): string =>
          guardNotes.length > 0 ? `${text}\n${guardNotes.join('\n')}` : text
        if (config.browserEnforcePostPolicy) {
          try {
            await page.route('**/*', createSprayGuardHandler(config, guardNotes))
          } catch {
            guardNotes.push('Warning: browser spray-guard route could not attach — writes on this page are uncounted.')
          }
        }
        try {
          switch (args.action) {
            case 'navigate': {
              if (!args.url) return 'REJECTED: url is required for navigate.'
              await page.goto(args.url, { waitUntil: args.wait_until ?? 'load', timeout: 30_000 })
              const title = await page.evaluate('document.title')
              return withNotes(`Navigated ${args.url} — title: ${title}`)
            }
            case 'click': {
              if (!args.selector) return 'REJECTED: selector is required for click.'
              await page.click(args.selector, { timeout: 10_000 })
              return withNotes(`Clicked ${args.selector}.`)
            }
            case 'fill': {
              if (!args.selector || args.value === undefined) return 'REJECTED: selector and value are required for fill.'
              await page.fill(args.selector, args.value, { timeout: 10_000 })
              return withNotes(`Filled ${args.selector}.`)
            }
            case 'evaluate': {
              if (!args.value) return 'REJECTED: value (JS expression) is required for evaluate.'
              const result = await page.evaluate<unknown>(args.value)
              return withNotes(truncate(typeof result === 'string' ? result : JSON.stringify(result, null, 2), 10_000))
            }
            case 'screenshot': {
              const dir = workspaceSub(config, 'screenshots')
              const path = join(dir, `${sessionName}-${Date.now()}.png`)
              await page.screenshot({ path, fullPage: args.full_page ?? false })
              return `Screenshot saved: ${path} (view it with the read_image tool).`
            }
            case 'content': {
              const html = await page.content()
              return truncate(html, 20_000)
            }
            default:
              return `Unknown action "${args.action}". Use navigate | click | fill | evaluate | screenshot | content | close.`
          }
        } finally {
          await page.close().catch(() => {})
        }
      },
    }),
  )
}

export { playwrightUnavailable }
