/**
 * StriX-DH tool suite entry point.
 *
 * Registers the offensive-security toolset (ported from Strix) as native dsh
 * tools, and contributes the pentest methodology section to the system prompt.
 * Each module in ./tools/ owns one capability and exports a register(ctx, config).
 *
 * ONLY run the tools this plugin registers against targets you own or have
 * explicit, written permission to test.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type ConfigType } from './config.js'
import { registerHttp } from './tools/http.js'
import { registerFinding, registerReport } from './tools/finding.js'
import { registerShell } from './tools/shell.js'
import { registerPybox } from './tools/pybox.js'
import { registerCoverage } from './tools/coverage.js'
import { registerNotes } from './tools/notes.js'
import { registerThreatModel } from './tools/threat-model.js'
import { registerRecon } from './tools/recon.js'
import { registerRuns } from './tools/runs.js'
import { registerSast } from './tools/sast.js'
import { registerBrowser } from './tools/browser.js'
import { registerAuthorization, renderAuthorizationSection } from './tools/authorization.js'
import { registerBudget } from './tools/budget.js'
import { registerProxy } from './tools/proxy.js'
import { workspaceDir } from './lib/util.js'
import { registerBundledSkills } from './skills-provider.js'

export const name = 'strix-dsh-tools'
export const inject = ['tools', 'systemPrompt', 'skills', 'approval', 'jobs'] as const
export { Config }

export async function apply(ctx: Context, config: ConfigType) {
  const registrations = [
    registerRuns,
    registerHttp,
    registerFinding,
    registerReport,
    registerShell,
    registerPybox,
    registerCoverage,
    registerNotes,
    registerThreatModel,
    registerRecon,
    registerSast,
    registerBrowser,
    registerAuthorization,
    registerBudget,
    registerProxy,
  ]

  for (const register of registrations) {
    register(ctx, config)
  }

  ctx.systemPrompt.section({
    name: 'strix:methodology',
    order: 100,
    text: methodologySection(config),
  })

  // Provider form: re-evaluated on every assembly, so an authorization set
  // mid-engagement reaches the model on the very next turn without a reboot.
  ctx.systemPrompt.section({
    name: 'strix:authorization',
    order: 101,
    text: () => renderAuthorizationSection(config),
  })

  const skillCount = await registerBundledSkills(ctx)

  // eslint-disable-next-line no-console -- visible load signal in harness startup output
  console.log(`[strix-dsh-tools] registered ${registrations.length} tool modules (15 tools) + methodology + authorization sections + ${skillCount} skills; workspace: ${workspaceDir(config)}`)
}

function methodologySection(config: ConfigType): string {
  const ws = workspaceDir(config)
  return [
    '<strix_methodology>',
    'You are operating as an authorized security validation agent (StriX-DH tool suite).',
    `Shared engagement workspace: ${ws}`,
    'Layout: findings/ (evidence-bound vulnerability reports), coverage/ (surface ledger),',
    'notes/ (cross-agent scratchpad), threat-model.md, recon/ (engine output).',
    '',
    'CORE DISCIPLINE (Strix methodology, adapted):',
    '- Reconnaissance and attack-surface mapping come BEFORE targeted testing,',
    '  unless the next step is obvious or the user explicitly prioritizes an area.',
    '- CLOSURE DISCIPLINE: every candidate ends in exactly one state —',
    '  confirmed (working PoC, or a complete reachable source→sink→impact trace),',
    '  ruled_out (you can name the SPECIFIC control, at a location, that runs on',
    '  every attacker-reachable path before the sink), or open_proof_gap',
    '  (plausible, unconfirmed, no such control named). "I moved on" is not a',
    '  closure state. Missing information is NOT proof of safety.',
    '- CVSS BINDING: score only the impact your PoC demonstrated. Every non-None',
    '  Confidentiality/Integrity/Availability metric must map to explicit evidence.',
    '  Reachability, missing authentication, scanner labels, and theoretical',
    '  follow-on attacks do not justify impact metrics by themselves.',
    '- A finding exists ONLY once registered via strix_finding with evidence.',
    '  Mentioning a bug in conversation is not reporting.',
    '- VALIDATION IS MANDATORY: never trust scanner output; validate with a',
    '  concrete PoC (strix_http / strix_pybox / strix_browser) before filing.',
    '- Run the counterevidence pass before filing: argue the strongest case',
    '  AGAINST your finding and record it; set confidence honestly.',
    '- APPROVAL GATE: strix_shell and strix_pybox require per-call operator',
    '  approval through dsh. A DENIED result means the operator (or the headless',
    '  policy) refused that command — do NOT retry the identical call; explain',
    '  what you needed and why, or propose a less invasive step. Every decision',
    '  and run outcome is recorded in evidence/log.jsonl.',
    '- COVERAGE: record every surface you assess with strix_coverage, including',
    '  the clean ones — a report that only lists findings cannot say what was',
    '  reviewed and cleared. Use needs_follow_up for open_proof_gap items.',
    '- THREAT MODEL: establish it first (strix_threat_model save), amend it when',
    '  your testing disproves it. A model nobody corrects turns guesses into',
    '  everyone\u2019s assumptions.',
    '- PRIMARY TARGETS: IDOR, SQLi, SSRF, XSS, XXE, RCE, CSRF, race conditions,',
    '  business logic flaws, auth & JWT vulnerabilities. Start basic, escalate,',
    '  chain for impact. One well-validated high-impact finding beats dozens of',
    '  low-severity ones.',
    '- Real engagements take many iterations. Never give up early; each failure',
    '  refines the next attempt.',
    '',
    '- AUTHORIZATION: the operator records permission with strix_authorization',
    '  (action=set) and the strix:authorization prompt section carries it on',
    '  every turn. Record it first when permission is stated; never invent it.',
    '',
    'ONLY test targets you own or have explicit, written permission to test.',
    '</strix_methodology>',
  ].join('\n')
}
