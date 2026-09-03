/**
 * Session-event mirror for file-backed state (coverage ledger, notes).
 *
 * Files stay the source of truth; the session log gets a best-effort,
 * log-only mirror so engagement state travels with the persisted session
 * (multi-turn context, replay, audit) instead of living only on disk.
 *
 * Runtime shape note: `ToolRunContext.agent` is typed as `{ id }`, but the
 * live object carries `.session` with `append()` — the approval service
 * (`dsh-user-approval`) already relies on exactly this (`req.agent.session`).
 * We depend only on that proven shape, guarded by try/catch: a failed mirror
 * must never break the tool call it mirrors.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Mirror of one coverage-ledger mutation. Log-only, ignorable: pure
     * information — losing it cannot affect session reconstruction.
     */
    'strix/coverage': {
      action: 'record' | 'update'
      entry: {
        id: string
        surface: string
        risk_area: string
        outcome: string
        evidence_note: string
      }
    }
    /**
     * Mirror of one scratchpad mutation. Log-only, ignorable, same rationale.
     */
    'strix/note': {
      action: 'create' | 'update' | 'delete'
      note: {
        id: string
        title: string
        /** Omitted for delete (the body is gone). */
        body?: string
      }
    }
  }
}

interface SessionLike {
  append(type: string, data: unknown): unknown
}

function liveSession(exec: ToolRunContext): SessionLike | undefined {
  try {
    const agent = exec.agent as unknown as { session?: SessionLike } | undefined
    const session = agent?.session
    if (session && typeof session.append === 'function') return session
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Append a log-only mirror event. Best-effort: never throws — the file
 * write it mirrors already succeeded, and a mirror failure must not turn a
 * success into an error.
 */
export function mirrorEvent(exec: ToolRunContext, type: 'strix/coverage' | 'strix/note', data: unknown): void {
  try {
    liveSession(exec)?.append(type, data)
  } catch {
    /* mirror is advisory; the file is the source of truth */
  }
}
