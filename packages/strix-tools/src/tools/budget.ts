/**
 * strix_budget — the engagement's LLM spend ledger.
 *
 * dsh's token-meter measures context pressure, not dollars, and no pricing
 * API exists in alpha.5 — so this ledger prices usage with operator-set
 * per-1K rates (defaults match the DeepSeek V3.2 official price) and tracks
 * cumulative spend in `workspace/budget.json`. This is explicit bookkeeping:
 * the agent reports its per-turn usage with `record`, heavy tools
 * (recon/sast) consult the ledger before running, and `status` shows the
 * remaining budget. When dsh exposes a usage subscription, record can be
 * fed automatically — the ledger format already supports that.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { workspaceDir } from '../lib/util.js'

export interface BudgetLedger {
  inputTokens: number
  outputTokens: number
  /** Cumulative USD priced with the config rates in effect at record time. */
  spentUsd: number
  records: number
  started_at: string
  updated_at: string
}

const FILE = 'budget.json'

export function budgetPath(config: ConfigType): string {
  return join(workspaceDir(config), FILE)
}

/** Read the ledger, or a zero ledger when none exists yet. */
export function readBudget(config: ConfigType): BudgetLedger {
  const path = budgetPath(config)
  if (!existsSync(path)) {
    const now = new Date().toISOString()
    return { inputTokens: 0, outputTokens: 0, spentUsd: 0, records: 0, started_at: now, updated_at: now }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BudgetLedger
  } catch {
    const now = new Date().toISOString()
    return { inputTokens: 0, outputTokens: 0, spentUsd: 0, records: 0, started_at: now, updated_at: now }
  }
}

function writeBudget(config: ConfigType, ledger: BudgetLedger): void {
  writeFileSync(budgetPath(config), JSON.stringify(ledger, null, 2), 'utf8')
}

/** Price one record with the current config rates. */
export function priceUsage(config: ConfigType, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * config.budgetInputPer1k + (outputTokens / 1000) * config.budgetOutputPer1k
}

/** Format a USD amount to 4 decimals for ledger display. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`
}

export type BudgetGate =
  | { over: false }
  | { over: true; message: string }

/**
 * Consult the ledger before a heavy operation. Returns `{over:false}` when
 * no cap is set or spend is within budget. When over budget, `warn` yields a
 * warning to prepend (execution proceeds); `block` yields a refusal.
 */
export function checkBudget(config: ConfigType, toolName: string): BudgetGate {
  if (config.budgetLimitUsd <= 0) return { over: false }
  const ledger = readBudget(config)
  if (ledger.spentUsd < config.budgetLimitUsd) return { over: false }
  const status = `spent ${formatUsd(ledger.spentUsd)} of ${formatUsd(config.budgetLimitUsd)} cap `
    + `(${ledger.inputTokens} in / ${ledger.outputTokens} out tokens across ${ledger.records} records)`
  if (config.budgetAction === 'block') {
    return {
      over: true,
      message:
        `BUDGET EXCEEDED: ${toolName} refused — ${status}. Raise budgetLimitUsd, reset the ledger `
        + '(strix_budget action=reset), or switch budgetAction to warn. Nothing was executed.',
    }
  }
  return {
    over: true,
    message:
      `BUDGET WARNING: ${toolName} proceeds, but ${status}. Record usage honestly and consider stopping.`,
  }
}

export function registerBudget(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_budget',
      description:
        'Engagement LLM spend ledger: record per-turn token usage (priced with the configured per-1K rates), '
        + 'check remaining budget with status, or reset the ledger. Heavy tools (recon/sast) consult this ledger '
        + 'and warn or refuse once the cap is exceeded. Report usage honestly — the ledger is only as good as '
        + 'its records.',
      parameters: {
        action: { type: 'string', required: true, description: 'record | status | reset' },
        input_tokens: { type: 'number', description: 'Input tokens consumed this turn (record).' },
        output_tokens: { type: 'number', description: 'Output tokens produced this turn (record).' },
        note: { type: 'string', description: 'What the spend was for, e.g. "recon planning turn" (record).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { action: string; input_tokens?: number; output_tokens?: number; note?: string }

        if (args.action === 'status') {
          const ledger = readBudget(config)
          const cap = config.budgetLimitUsd <= 0
            ? 'no cap set (budgetLimitUsd=0)'
            : `${formatUsd(config.budgetLimitUsd)} cap, ${formatUsd(Math.max(0, config.budgetLimitUsd - ledger.spentUsd))} remaining`
          return [
            `Budget: spent ${formatUsd(ledger.spentUsd)} — ${cap}.`,
            `Tokens: ${ledger.inputTokens} in / ${ledger.outputTokens} out across ${ledger.records} records.`,
            `Rates: ${formatUsd(config.budgetInputPer1k)}/1K in, ${formatUsd(config.budgetOutputPer1k)}/1K out (mode: ${config.budgetAction}).`,
          ].join('\n')
        }

        if (args.action === 'record') {
          const input = Math.max(0, Math.floor(args.input_tokens ?? 0))
          const output = Math.max(0, Math.floor(args.output_tokens ?? 0))
          if (input === 0 && output === 0) return 'REJECTED: input_tokens or output_tokens (positive) is required for record.'
          const ledger = readBudget(config)
          ledger.inputTokens += input
          ledger.outputTokens += output
          ledger.spentUsd += priceUsage(config, input, output)
          ledger.records += 1
          ledger.updated_at = new Date().toISOString()
          writeBudget(config, ledger)
          const over = checkBudget(config, 'strix_budget')
          const line = `Recorded +${input} in / +${output} out → total ${formatUsd(ledger.spentUsd)}`
            + (args.note ? ` (${args.note})` : '') + '.'
          return over.over ? `${line}\n${over.message}` : line
        }

        if (args.action === 'reset') {
          const now = new Date().toISOString()
          writeBudget(config, { inputTokens: 0, outputTokens: 0, spentUsd: 0, records: 0, started_at: now, updated_at: now })
          return 'Budget ledger reset to zero. Past spend is discarded — the operator owns that decision.'
        }

        return `Unknown action "${args.action}". Use record | status | reset.`
      },
    }),
  )
}
