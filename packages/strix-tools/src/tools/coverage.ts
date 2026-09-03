/**
 * strix_coverage — the shared surface ledger from Strix: every assessed
 * surface gets a row (including clean ones), so the final report can say what
 * was reviewed and cleared. Outcomes: clean | finding | needs_follow_up |
 * blocked | ruled_out. The ledger is shared and mutable: move an entry with
 * update() instead of recording a second row for the same surface.
 *
 * ruled_out is the triage closure for surfaces with no attacker-reachable
 * attack surface (e.g. static info-only sites with no login, no parameters,
 * no forms after 1–2 baseline GETs): record it once with the specific reason
 * named in evidence_note, then stop — do not open new batches over it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { mirrorEvent } from '../lib/session-mirror.js'
import { nextIdAmong, workspaceSub } from '../lib/util.js'

export const OUTCOMES = ['clean', 'finding', 'needs_follow_up', 'blocked', 'ruled_out'] as const

export interface CoverageEntry {
  id: string
  surface: string
  risk_area: string
  outcome: string
  evidence_note: string
  recorded_at: string
  updated_at?: string
}

function ledgerFile(config: ConfigType): string {
  return join(workspaceSub(config, 'coverage'), 'ledger.jsonl')
}

export function readLedger(config: ConfigType): CoverageEntry[] {
  const file = ledgerFile(config)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CoverageEntry)
}

export function writeLedger(config: ConfigType, entries: CoverageEntry[]): void {
  writeFileSync(ledgerFile(config), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

export function registerCoverage(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_coverage',
      description:
        'Shared attack-surface coverage ledger. Record EVERY surface you assess — including clean ones: a report ' +
        'that only lists findings cannot say what was reviewed and cleared. One row per surface+risk_area; ' +
        'correct an existing row with update (pass its id), never record a duplicate. Outcomes: clean | finding | ' +
        'needs_follow_up | blocked | ruled_out. needs_follow_up marks an open_proof_gap for later agents. ' +
        'ruled_out closes triage on surfaces with no attacker-reachable attack surface (static info-only site, ' +
        'no login, no parameters, no forms after baseline GETs) — name the specific reason in evidence_note, then stop.',
      parameters: {
        action: { type: 'string', required: true, description: 'record | update | list' },
        id: { type: 'string', description: 'Entry id (update).' },
        surface: { type: 'string', description: 'The surface assessed: a URL, endpoint, host:port, file, or code area (record).' },
        risk_area: { type: 'string', description: 'The vulnerability class or risk tested for: e.g. SQLi, IDOR, auth bypass (record).' },
        outcome: { type: 'string', description: 'clean | finding | needs_follow_up | blocked | ruled_out (record).' },
        evidence_note: { type: 'string', description: 'Short note: what was tested, what was observed, or why blocked/ruled out (record).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>, exec): Promise<string> {
        const args = raw as Record<string, unknown> & { action: string }
        const entries = readLedger(config)

        if (args.action === 'list') {
          if (entries.length === 0) return 'Coverage ledger is empty.'
          const followUps = entries.filter((e) => e.outcome === 'needs_follow_up').length
          const ruledOut = entries.filter((e) => e.outcome === 'ruled_out').length
          const lines = entries.map(
            (e) =>
              `${e.id} ${e.outcome.padEnd(15)} ${e.surface} — ${e.risk_area}${e.evidence_note ? ` (${e.evidence_note})` : ''}`,
          )
          return [
            `${entries.length} surface(s) recorded, ${followUps} needing follow-up${ruledOut ? `, ${ruledOut} ruled out by triage` : ''}.`,
            ...lines,
          ].join('\n')
        }

        if (args.action === 'record') {
          if (!args.surface || !args.risk_area || !args.outcome) {
            return 'REJECTED: surface, risk_area, and outcome are required to record.'
          }
          if (!OUTCOMES.includes(args.outcome as (typeof OUTCOMES)[number])) {
            return `REJECTED: outcome must be one of ${OUTCOMES.join(', ')}.`
          }
          const entry: CoverageEntry = {
            // Max-existing-id + 1: a ledger row removed or an entry edited by
            // hand must not make the next id collide with a live row.
            id: nextIdAmong(entries.map((e) => e.id), 'C-'),
            surface: String(args.surface),
            risk_area: String(args.risk_area),
            outcome: String(args.outcome),
            evidence_note: String(args.evidence_note ?? ''),
            recorded_at: new Date().toISOString(),
          }
          entries.push(entry)
          writeLedger(config, entries)
          mirrorEvent(exec, 'strix/coverage', {
            action: 'record',
            entry: { id: entry.id, surface: entry.surface, risk_area: entry.risk_area, outcome: entry.outcome, evidence_note: entry.evidence_note },
          })
          return `Recorded ${entry.id}: ${entry.surface} — ${entry.risk_area} → ${entry.outcome}.`
        }

        if (args.action === 'update') {
          const id = String(args.id ?? '')
          const entry = entries.find((e) => e.id === id)
          if (!entry) {
            return `Entry ${id} not found. Ledger:\n${entries.map((e) => `${e.id} ${e.surface}`).join('\n') || '(empty)'}`
          }
          if (args.surface !== undefined) entry.surface = String(args.surface)
          if (args.risk_area !== undefined) entry.risk_area = String(args.risk_area)
          if (args.outcome !== undefined) {
            if (!OUTCOMES.includes(args.outcome as (typeof OUTCOMES)[number])) {
              return `REJECTED: outcome must be one of ${OUTCOMES.join(', ')}.`
            }
            entry.outcome = String(args.outcome)
          }
          if (args.evidence_note !== undefined) entry.evidence_note = String(args.evidence_note)
          entry.updated_at = new Date().toISOString()
          writeLedger(config, entries)
          mirrorEvent(exec, 'strix/coverage', {
            action: 'update',
            entry: { id: entry.id, surface: entry.surface, risk_area: entry.risk_area, outcome: entry.outcome, evidence_note: entry.evidence_note },
          })
          return `Moved ${id}: ${entry.surface} — ${entry.risk_area} → ${entry.outcome}.`
        }

        return `Unknown action "${args.action}". Use record | update | list.`
      },
    }),
  )
}
