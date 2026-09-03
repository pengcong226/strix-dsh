/**
 * strix_recon — passive/active reconnaissance orchestration (Strix's
 * "recon & mapping first" phase): subfinder for subdomain enumeration, then
 * httpx for live-host probing with titles/status/tech. Output lands in
 * workspace/recon/<domain>/ and a structured summary is returned.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { checkBudget } from './budget.js'
import { findBinary, formatRunResult, runProcess, truncate, workspaceSub } from '../lib/util.js'

export function registerRecon(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_recon',
      description:
        'Map a domain\u2019s attack surface: passive subdomain enumeration (subfinder) then live-host probing ' +
        '(httpx with status/title/tech). Recon comes FIRST in the methodology — map before testing. Results ' +
        'saved to workspace/recon/<domain>/ and summarized. Only for authorized targets.',
      parameters: {
        domain: { type: 'string', required: true, description: 'Base domain, e.g. example.com (no scheme).' },
        skip_httpx: { type: 'boolean', description: 'Skip the live-host probing phase, only enumerate subdomains.' },
        timeout_ms: { type: 'number', description: 'Per-engine timeout. Default from config.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { domain: string; skip_httpx?: boolean; timeout_ms?: number }
        const gate = checkBudget(config, 'strix_recon')
        if (gate.over && config.budgetAction === 'block') return gate.message
        const domain = args.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        const timeoutMs = args.timeout_ms ?? config.reconTimeoutMs
        const outDir = workspaceSub(config, 'recon', domain)
        const report: string[] = [`Recon for ${domain} — output dir: ${outDir}`]
        if (gate.over) report.push(gate.message)

        const subfinder = findBinary(config, 'subfinder')
        if (!subfinder) {
          return 'subfinder not found. Install it (https://github.com/projectdiscovery/subfinder/releases) and set '
            + 'the binariesDir config to its folder, or add it to PATH.'
        }
        const subsFile = join(outDir, 'subs.txt')
        const subfinderRun = await runProcess(subfinder, ['-d', domain, '-silent'], { timeoutMs })
        const subdomains = [...new Set(subfinderRun.stdout.split('\n').map((l) => l.trim()).filter(Boolean))]
        writeFileSync(subsFile, subdomains.join('\n'), 'utf8')
        report.push(`[subfinder] ${subdomains.length} subdomain(s) → ${subsFile}`)
        if (subfinderRun.timedOut) report.push('[subfinder] timed out — partial results kept')

        if (args.skip_httpx || subdomains.length === 0) {
          report.push(`\nSubdomains:\n${truncate(subdomains.join('\n'), 15_000)}`)
          return report.join('\n')
        }

        const httpxBin = findBinary(config, 'httpx')
        if (!httpxBin) {
          return `Subdomains saved to ${subsFile}, but httpx was not found for live probing. Install it `
            + '(https://github.com/projectdiscovery/httpx/releases) and set binariesDir, or add it to PATH.'
        }
        const liveFile = join(outDir, 'live.txt')
        const httpxRun = await runProcess(httpxBin, ['-silent', '-title', '-status-code', '-tech-detect', '-o', liveFile], {
          timeoutMs,
        })
        // httpx -o writes the file itself; also show a bounded summary here.
        report.push(`[httpx] exit ${httpxRun.exitCode}${httpxRun.timedOut ? ' (timed out — partial)' : ''} → ${liveFile}`)
        report.push(`\nLive hosts:\n${truncate(httpxRun.stdout, 15_000)}`)
        return report.join('\n')
      },
    }),
  )
}
