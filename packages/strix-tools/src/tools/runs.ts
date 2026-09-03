/**
 * strix_runs — engagement overview: summarizes everything the suite has
 * produced in the shared workspace (findings, coverage ledger, notes,
 * threat model, report, recon output, pybox runs) so an agent can orient
 * itself at any point ("what already exists?").
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { workspaceDir } from '../lib/util.js'
import { formatUsd, readBudget } from './budget.js'
import { listFindings } from './finding.js'

export function registerRuns(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_runs',
      description:
        'Engagement overview: list what already exists in the shared workspace — findings (with per-finding '
        + 'severity/type/target lines so children see filed reports without a second call), coverage entries, notes, '
        + 'threat model, generated report, recon outputs, pybox runs, and the budget ledger status. Call this first '
        + 'when joining an engagement so you build on prior work instead of redoing it.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(): Promise<string> {
        const ws = workspaceDir(config)
        const lines: string[] = [`Engagement workspace: ${ws}`]

        // Filed reports (agents_graph parity: a parent that wants to act on a
        // child's work reads filed report ids, not prose — so every finding
        // gets one line with severity/type/target).
        const findings = listFindings(config)
        if (findings.length === 0) {
          lines.push('findings: none')
        } else {
          lines.push(`findings: ${findings.length} registered`)
          for (const f of findings) {
            lines.push(`  - ${f.id} [${f.severity}] (${f.vulnerability_type}) ${f.title} — ${f.target}`)
          }
        }

        const ledger = join(ws, 'coverage', 'ledger.jsonl')
        if (existsSync(ledger)) {
          const n = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim()).length
          lines.push(`coverage: ${n} surface(s) recorded`)
        } else {
          lines.push('coverage: empty')
        }

        const notesDir = join(ws, 'notes')
        const notes = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith('.json')) : []
        lines.push(`notes: ${notes.length}`)

        lines.push(`threat-model: ${existsSync(join(ws, 'threat-model.md')) ? 'present' : 'not established'}`)
        lines.push(`report: ${existsSync(join(ws, 'report.md')) ? join(ws, 'report.md') : 'not generated'}`)

        const reconDir = join(ws, 'recon')
        if (existsSync(reconDir)) {
          const domains = readdirSync(reconDir)
          lines.push(`recon: ${domains.length ? domains.join(', ') : 'no domains scanned'}`)
        } else {
          lines.push('recon: none')
        }

        const pyboxDir = join(ws, 'pybox')
        const runs = existsSync(pyboxDir) ? readdirSync(pyboxDir) : []
        lines.push(`pybox runs: ${runs.length}`)

        const responsesDir = join(ws, 'responses')
        const responses = existsSync(responsesDir) ? readdirSync(responsesDir) : []
        lines.push(`saved responses: ${responses.length}`)

        // Budget visibility: the ledger only moves when someone records, so
        // surface its state here — an empty ledger on a live engagement is a
        // signal to start recording, not proof of zero spend.
        const budget = readBudget(config)
        lines.push(
          budget.records === 0
            ? 'budget: no records yet — call strix_budget action=record with your per-turn tokens.'
            : `budget: spent ${formatUsd(budget.spentUsd)} across ${budget.records} records.`,
        )

        return lines.join('\n')
      },
    }),
  )
}
