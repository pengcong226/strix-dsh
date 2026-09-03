/**
 * Human-in-the-loop approval gate for execution-class tools (strix_shell,
 * strix_pybox). Every command or script ask goes through dsh's
 * ApprovalService before its container runs; only an explicit
 * 'allowed-once' executes — 'rejected', 'cancelled', and 'unavailable' all
 * fail closed, mirroring dsh's own fail-closed rule for 'unavailable'.
 *
 * The ApprovalService itself appends the durable 'approval/asked' +
 * 'approval/decided' audit pair to the session log. On top of that we keep
 * an operator-facing JSONL ledger at <workspace>/evidence/log.jsonl so the
 * decision trail and run results survive independent of any session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Side-effect type import: pulls in the Context `approval` augmentation.
import type {} from '@deepseek-ai/dsh-user-approval'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { truncate, workspaceDir } from './util.js'

export type GateDecision =
  | { granted: true }
  | { granted: false; message: string; outcome: string }

/** One JSONL record in <workspace>/evidence/log.jsonl. */
export interface EvidenceEntry {
  ts: string
  kind: 'decision' | 'result'
  tool: string
  outcome?: string
  callId?: string
  command?: string
  exitCode?: number | null
  durationMs?: number
  runDir?: string
}

function denied(outcome: string, tool: string, detail?: string): GateDecision {
  const why = detail ? ` (${detail})` : ''
  return {
    granted: false,
    outcome,
    message:
      `DENIED: ${tool} was not approved by the operator (outcome: ${outcome})${why}. `
      + 'Nothing was executed. If this work should proceed, the operator can approve the pending '
      + "request in the dsh UI (approval policy 'ask'), or set the plugin's approvalGate config to 'off' "
      + 'for fully autonomous runs they accept responsibility for.',
  }
}

/**
 * Test whether an approval summary matches one of the operator's
 * pre-approved patterns. Invalid regexes never match (fail-closed).
 * Pure — unit-tested.
 */
export function matchesAutoAllow(patterns: string[], summary: string): boolean {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(summary)) return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * An approval text split in two: `display` is what the operator reads (and
 * what lands in the evidence ledger) — bounded, hash-stamped when truncated
 * so a shortened view is never mistaken for the whole; `match` is the FULL
 * text that pre-approved patterns match against. Never match patterns
 * against a truncated string: a `^prefix` pattern would otherwise grant on
 * an invisible suffix. Pure — unit-tested.
 */
export interface ApprovalSummary {
  display: string
  match: string
}

export function splitApprovalSummary(full: string, maxDisplayChars = 400): ApprovalSummary {
  const digest = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 12)
  if (full.length <= maxDisplayChars) return { display: full, match: full }
  return {
    display: `${truncate(full, maxDisplayChars)} [full ${full.length} chars, sha256:${digest}]`,
    match: full,
  }
}

/**
 * Build the gate used by registerShell/registerPybox. Closing over ctx and
 * config keeps tool bodies free of approval plumbing.
 */
export function createApprovalGate(ctx: Context, config: ConfigType) {
  return async function requestRunApproval(
    exec: ToolRunContext,
    summary: string | ApprovalSummary,
  ): Promise<GateDecision> {
    const display = typeof summary === 'string' ? summary : summary.display
    // Pre-approved patterns ALWAYS match the full text, never the display
    // truncation (see splitApprovalSummary).
    const match = typeof summary === 'string' ? summary : summary.match
    if (config.approvalGate === 'off') {
      logEvidence(config, {
        ts: new Date().toISOString(),
        kind: 'decision',
        tool: exec.name,
        outcome: 'gate-off',
        callId: exec.callId,
        command: truncate(display, 200),
      })
      return { granted: true }
    }

    if (matchesAutoAllow(config.approvalAutoAllow ?? [], match)) {
      logEvidence(config, {
        ts: new Date().toISOString(),
        kind: 'decision',
        tool: exec.name,
        outcome: 'auto-allowed',
        callId: exec.callId,
        command: truncate(display, 200),
      })
      return { granted: true }
    }

    if (!exec.agent) {
      return denied('unavailable', exec.name, 'no agent identity on the tool execution context')
    }

    let outcome: string
    try {
      outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: display,
        signal: exec.signal,
      })
    } catch (err) {
      logEvidence(config, {
        ts: new Date().toISOString(),
        kind: 'decision',
        tool: exec.name,
        outcome: 'unavailable',
        callId: exec.callId,
        command: truncate(display, 200),
      })
      return denied('unavailable', exec.name, err instanceof Error ? err.message : String(err))
    }

    logEvidence(config, {
      ts: new Date().toISOString(),
      kind: 'decision',
      tool: exec.name,
      outcome,
      callId: exec.callId,
      command: truncate(display, 200),
    })

    if (outcome === 'allowed-once') return { granted: true }
    return denied(outcome, exec.name)
  }
}

/**
 * Append one record to <workspace>/evidence/log.jsonl. Best-effort: the
 * ledger must never block or break a tool run, so write failures are swallowed.
 */
export function logEvidence(config: ConfigType, entry: EvidenceEntry): void {
  try {
    const dir = join(workspaceDir(config), 'evidence')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* evidence ledger is advisory; never block execution */
  }
}
