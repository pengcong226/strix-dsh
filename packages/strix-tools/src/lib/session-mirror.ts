/**
 * Session-event mirror — RETIRED as an event writer.
 *
 * History: this module used to append `strix/coverage` and `strix/note`
 * rows to the session log so engagement state would travel with the
 * persisted session. That was a contract violation on two counts, discovered
 * the hard way (34 sessions became unloadable with
 * "unknown historical event type strix/coverage" → the desktop history view
 * showed "network error (gateway/internal)"):
 *
 * 1. `Session.append()` has no `ignorable` option — a custom type lands in
 *    the log WITHOUT the `ignorable: true` marker that the format migration
 *    chain requires for unknown types. The v0→v1 migration refuses unknown
 *    non-ignorable events outright, so every session that inherited one of
 *    these rows failed to load under dsh 0.1.5-rc.2.
 * 2. Declaring extra keys on `SessionEventMap` only widens OUR compile-time
 *    type; the host's format catalog knows nothing about them.
 *
 * The files (coverage ledger, notes) were always the source of truth and
 * remain so; nothing is lost by not mirroring. `mirrorEvent` is kept as a
 * no-op so callers (coverage.ts, notes.ts) and their tests stay unchanged —
 * removing the call sites is a mechanical cleanup for a future version.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * No-op since 0.12.5. Previously appended a log-only mirror event; see the
 * module header for why writing custom event types is forbidden. Best-effort
 * by definition — never throws, never writes.
 */
export function mirrorEvent(_exec: ToolRunContext, _type: 'strix/coverage' | 'strix/note', _data: unknown): void {
  /* intentionally empty: the session log must only carry host-known event types */
}
