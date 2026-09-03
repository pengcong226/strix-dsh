/**
 * strix_finding / strix_report — the evidence-bound reporting pipeline ported
 * from Strix: a vulnerability exists ONLY once registered with concrete
 * evidence; CVSS impact metrics must map to demonstrated PoC results;
 * counterevidence and confidence are first-class fields; updates supersede
 * re-filing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { safeId, workspaceDir, workspaceSub } from '../lib/util.js'
import { maskTestAccount, readAuthorization } from './authorization.js'
import { readLedger } from './coverage.js'
import { writeSarifReport } from './sarif.js'

export const VULN_TYPES = [
  'idor', 'sqli', 'ssrf', 'xss', 'xxe', 'rce', 'csrf',
  'race_condition', 'business_logic', 'auth_jwt', 'dependency_cve', 'other',
] as const
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export const CONFIDENCES = ['high', 'medium', 'low'] as const

export interface CodeLocation {
  file: string
  fix_before: string
  fix_after: string
}

export interface Finding {
  id: string
  title: string
  vulnerability_type: string
  severity: string
  target: string
  description: string
  /** Required: the concrete proof — request/response pairs, PoC output, screenshots paths. */
  evidence: string
  poc_script?: string
  cvss_vector?: string
  counterevidence?: string
  confidence?: string
  remediation?: string
  /** White-box: inline fix locations (fix derived once, at report time). */
  code_locations?: CodeLocation[]
  fix_pr_body?: string
  created_at: string
  updated_at?: string
  update_history?: string[]
}

function findingsDir(config: ConfigType): string {
  return workspaceSub(config, 'findings')
}

export function listFindings(config: ConfigType): Finding[] {
  const dir = findingsDir(config)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Finding)
}

function nextId(config: ConfigType): string {
  return `F-${String(listFindings(config).length + 1).padStart(3, '0')}`
}

function severityCounts(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  return counts
}

export interface DedupeCandidate {
  title?: string
  vulnerability_type?: string
  target?: string
  description?: string
  /** dependency_cve only: package name + CVE + ecosystem + manifest path. */
  package_name?: string
  cve?: string
  package_ecosystem?: string
  manifest_path?: string
}

export interface DedupeVerdict {
  duplicate: boolean
  existing_id?: string
  reason: string
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
}

/** Endpoint-ish prefix: scheme://host + first path segment, for same-component checks. */
function endpointKey(target: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(target.trim())
  if (!m) return norm(target)
  const firstSeg = (m[2] ?? '').split('/').filter(Boolean)[0]
  return norm(`${m[1]}${firstSeg ? `/${firstSeg}` : ''}`)
}

/**
 * Deterministic duplicate check (no LLM) over registered findings, ported
 * from the identity half of Strix's report/dedupe.py:
 *
 * - dependency_cve: same CVE + package (+ ecosystem when both carry it) is a
 *   duplicate — unless both carry different manifest paths (same flaw in two
 *   manifests is two findings).
 * - others: same vulnerability_type + same endpoint key + overlapping target
 *   text is a duplicate. Different types, different endpoints, or disjoint
 *   targets are NOT duplicates (e.g. SQLi in /login vs /search).
 *
 * Pure — unit-tested. The LLM-judge half (same root cause argued from prose)
 * stays a model task: callers pass ambiguous pairs here first and only file
 * when this says "not duplicate", or ask the model to argue it.
 */
export function checkDuplicate(
  candidate: DedupeCandidate,
  existing: Finding[],
  excludeId?: string,
): DedupeVerdict {
  const cType = norm(candidate.vulnerability_type || 'other')

  for (const f of existing) {
    if (excludeId && f.id === excludeId) continue
    const fType = norm(f.vulnerability_type || 'other')

    if (cType === 'dependency_cve' || fType === 'dependency_cve') {
      if (cType !== fType) continue
      const cve = norm(candidate.cve)
      const pkg = norm(candidate.package_name)
      if (!cve || !pkg) continue
      const hay = `${f.title} ${f.description} ${f.target} ${f.evidence}`.toLowerCase()
      if (!hay.includes(cve.toLowerCase()) || !hay.includes(pkg)) continue
      const eco = norm(candidate.package_ecosystem)
      if (eco && !hay.includes(eco)) continue
      const manifest = String(candidate.manifest_path ?? '').trim()
      if (manifest && hay.includes(manifest.toLowerCase()) === false && manifest !== '') {
        // Candidate names a manifest the existing text never mentions — treat
        // as distinct (mirrors _distinct_manifest_paths: two manifests, two
        // findings). Only when BOTH sides would otherwise match.
        return { duplicate: false, reason: `same CVE/package but different manifest context (${manifest}); file separately.` }
      }
      return { duplicate: true, existing_id: f.id, reason: `same CVE ${candidate.cve} + package ${candidate.package_name} as ${f.id}.` }
    }

    if (cType !== fType) continue
    const cTarget = String(candidate.target ?? '')
    if (!cTarget.trim()) continue
    if (endpointKey(cTarget) !== endpointKey(f.target)) continue
    const cWords = new Set(norm(`${candidate.title} ${cTarget}`).split(/[^a-z0-9]+/).filter((w) => w.length > 2))
    const fText = norm(`${f.title} ${f.target} ${f.description}`)
    const overlap = [...cWords].some((w) => fText.includes(w))
    if (overlap) {
      return { duplicate: true, existing_id: f.id, reason: `same type (${cType}) + same endpoint (${endpointKey(cTarget)}) + overlapping target text as ${f.id}.` }
    }
  }
  return { duplicate: false, reason: 'no registered finding shares type + endpoint + target text.' }
}

export function validateFinding(args: Record<string, unknown>, strict: boolean): string | null {
  if (strict && !args.evidence) {
    return 'REJECTED: no evidence. A finding without a demonstrated PoC (request/response pair, exploit output, '
      + 'or a complete reachable trace) is not a finding — it is at best an open_proof_gap. Record it in '
      + 'strix_coverage with needs_follow_up instead, or come back with concrete evidence.'
  }
  if (args.severity && !SEVERITIES.includes(args.severity as (typeof SEVERITIES)[number])) {
    return `REJECTED: severity must be one of ${SEVERITIES.join(', ')}`
  }
  if (args.vulnerability_type && !VULN_TYPES.includes(args.vulnerability_type as (typeof VULN_TYPES)[number])) {
    return `REJECTED: vulnerability_type must be one of ${VULN_TYPES.join(', ')}`
  }
  return null
}

export function registerFinding(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_finding',
      description:
        'Register, list, get, or update a vulnerability finding. A finding exists ONLY once registered here '
        + 'with concrete evidence (CVSS impact metrics must map to demonstrated PoC results). Use update to '
        + 'revise an existing finding (e.g. PoC built later, impact raised, evidence weakened) instead of '
        + 're-filing. Dependency/supply-chain CVEs use vulnerability_type=dependency_cve. '
        + 'dedupe-check judges a candidate against registered findings (deterministic: same type + endpoint + '
        + 'target text, or same CVE + package) — file only when it says not-duplicate.',
      parameters: {
        action: { type: 'string', required: true, description: 'create | update | list | get | dedupe-check' },
        id: { type: 'string', description: 'Finding id (update/get).' },
        title: { type: 'string', description: 'Short descriptive title (create).' },
        vulnerability_type: {
          type: 'string',
          description: `One of: ${VULN_TYPES.join(', ')} (create).`,
        },
        severity: { type: 'string', description: `info | low | medium | high | critical (create).` },
        target: { type: 'string', description: 'Affected target (URL, host, or code path).' },
        description: { type: 'string', description: 'What the weakness is and why it matters.' },
        evidence: {
          type: 'string',
          description:
            'REQUIRED for create under strict mode: the concrete proof — full request/response, PoC output, '
            + 'or the demonstrated impact. This is the field that makes it a finding.',
        },
        cvss_vector: { type: 'string', description: 'CVSS v3.1 vector string, only metrics backed by evidence.' },
        counterevidence: { type: 'string', description: 'The strongest case AGAINST this finding, and why it does not hold.' },
        confidence: { type: 'string', description: 'high | medium | low — honest assessment; static-only trace is at best medium.' },
        poc_script: { type: 'string', description: 'Path to a saved PoC script (workspace-relative).' },
        remediation: { type: 'string', description: 'How to fix it.' },
        code_locations: { type: 'object', additionalProperties: true, description: 'White-box inline fix: array of {file, fix_before, fix_after}.' },
        fix_pr_body: { type: 'string', description: 'White-box: PR description for the inline fix.' },
        update_reason: { type: 'string', description: 'Why this finding is being updated (update action).' },
        package_name: { type: 'string', description: 'dedupe-check (dependency_cve): package name.' },
        cve: { type: 'string', description: 'dedupe-check (dependency_cve): CVE id.' },
        package_ecosystem: { type: 'string', description: 'dedupe-check (dependency_cve): ecosystem, e.g. npm.' },
        manifest_path: { type: 'string', description: 'dedupe-check (dependency_cve): manifest path; a different path means a different finding.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as Record<string, unknown> & { action: string }
        const dir = findingsDir(config)

        if (args.action === 'list') {
          const all = listFindings(config)
          if (all.length === 0) return 'No findings registered yet.'
          const counts = severityCounts(all)
          const lines = all.map(
            (f) => `${f.id} [${f.severity}] (${f.vulnerability_type}) ${f.title} — ${f.target}`,
          )
          return [
            `${all.length} finding(s): ${Object.entries(counts).map(([s, n]) => `${s}=${n}`).join(', ')}`,
            ...lines,
          ].join('\n')
        }

        if (args.action === 'get') {
          const id = String(args.id ?? '')
          if (!safeId(id)) return `REJECTED: bad finding id "${id}".`
          const file = join(dir, `${id}.json`)
          if (!existsSync(file)) return `Finding ${id} not found.`
          return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 2)
        }

        if (args.action === 'create') {
          const rejection = validateFinding(args, config.strictEvidence)
          if (rejection) return rejection
          if (!args.title) return 'REJECTED: title is required.'
          if (!args.severity) return 'REJECTED: severity is required.'
          if (!args.target) return 'REJECTED: target is required.'
          const finding: Finding = {
            id: nextId(config),
            title: String(args.title),
            vulnerability_type: String(args.vulnerability_type ?? 'other'),
            severity: String(args.severity),
            target: String(args.target),
            description: String(args.description ?? ''),
            evidence: String(args.evidence ?? ''),
            poc_script: args.poc_script ? String(args.poc_script) : undefined,
            cvss_vector: args.cvss_vector ? String(args.cvss_vector) : undefined,
            counterevidence: args.counterevidence ? String(args.counterevidence) : undefined,
            confidence: args.confidence ? String(args.confidence) : undefined,
            remediation: args.remediation ? String(args.remediation) : undefined,
            code_locations: args.code_locations as Finding['code_locations'],
            fix_pr_body: args.fix_pr_body ? String(args.fix_pr_body) : undefined,
            created_at: new Date().toISOString(),
          }
          writeFileSync(join(dir, `${finding.id}.json`), JSON.stringify(finding, null, 2), 'utf8')
          return `Registered ${finding.id} [${finding.severity}] ${finding.title} — ${finding.target}.`
        }

        if (args.action === 'update') {
          const id = String(args.id ?? '')
          if (!safeId(id)) return `REJECTED: bad finding id "${id}".`
          const file = join(dir, `${id}.json`)
          if (!existsSync(file)) return `Finding ${id} not found.`
          const existing = JSON.parse(readFileSync(file, 'utf8')) as Finding
          const mutable = ['title', 'vulnerability_type', 'severity', 'target', 'description', 'evidence', 'cvss_vector', 'counterevidence', 'confidence', 'poc_script', 'remediation', 'code_locations', 'fix_pr_body'] as const
          for (const key of mutable) {
            if (args[key] !== undefined) (existing as unknown as Record<string, unknown>)[key] = args[key]
          }
          existing.updated_at = new Date().toISOString()
          existing.update_history = [
            ...(existing.update_history ?? []),
            `${new Date().toISOString()}: ${String(args.update_reason ?? '(no reason given)')}`,
          ]
          writeFileSync(file, JSON.stringify(existing, null, 2), 'utf8')
          return `Updated ${id}. Reason recorded: ${String(args.update_reason ?? '(no reason given)')}`
        }

        if (args.action === 'dedupe-check') {
          const verdict = checkDuplicate(
            {
              title: args.title !== undefined ? String(args.title) : undefined,
              vulnerability_type: args.vulnerability_type !== undefined ? String(args.vulnerability_type) : undefined,
              target: args.target !== undefined ? String(args.target) : undefined,
              description: args.description !== undefined ? String(args.description) : undefined,
              package_name: args.package_name !== undefined ? String(args.package_name) : undefined,
              cve: args.cve !== undefined ? String(args.cve) : undefined,
              package_ecosystem: args.package_ecosystem !== undefined ? String(args.package_ecosystem) : undefined,
              manifest_path: args.manifest_path !== undefined ? String(args.manifest_path) : undefined,
            },
            listFindings(config),
            args.id !== undefined ? String(args.id) : undefined,
          )
          return verdict.duplicate
            ? `DUPLICATE of ${verdict.existing_id}: ${verdict.reason} Use update on ${verdict.existing_id} instead of filing.`
            : `NOT A DUPLICATE: ${verdict.reason} Safe to file with create.`
        }

        return `Unknown action "${args.action}". Use create | update | list | get | dedupe-check.`
      },
    }),
  )
}

/**
 * Masked authorization summary for reports: targets + grant facts travel in
 * the clear; test-account passwords NEVER do. Pure — unit-tested.
 */
export function authorizationSummary(config: ConfigType): string[] {
  const auth = readAuthorization(config)
  if (!auth) return ['Authorization: none recorded for this engagement.']
  const lines = [
    'Authorization (operator-recorded attestation):',
    `- Targets: ${auth.targets.join(', ')}`,
    `- Granted by: ${auth.granted_by}`,
  ]
  if (auth.scope_ref) lines.push(`- Scope reference: ${auth.scope_ref}`)
  if (auth.valid_until) lines.push(`- Valid until: ${auth.valid_until}`)
  if (auth.notes) lines.push(`- Constraints: ${auth.notes}`)
  const pre = auth.pre_approved_post_paths ?? []
  if (pre.length > 0) lines.push(`- Pre-approved POST paths: ${pre.length} (${pre.map((e) => e.path).join(', ')})`)
  const accounts = auth.test_accounts ?? []
  if (accounts.length > 0) {
    lines.push(`- Test accounts (passwords masked): ${accounts.map(maskTestAccount).join(' | ')}`)
  }
  return lines
}

/**
 * Validate the four required finish sections. Pure — unit-tested.
 * Returns the missing field names (empty = complete).
 */
export function missingFinishSections(args: Record<string, unknown>): string[] {
  const missing: string[] = []
  for (const key of ['executive_summary', 'methodology', 'technical_analysis', 'recommendations'] as const) {
    if (!String(args[key] ?? '').trim()) missing.push(key)
  }
  return missing
}

export function registerReport(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_report',
      description:
        'Generate the engagement report (workspace/report.md) from registered findings and the coverage ledger: '
        + 'executive summary, per-finding sections with evidence, reviewed-and-clean surfaces, and methodology note. '
        + 'action=sarif instead emits a SARIF 2.1.0 sidecar (workspace/findings.sarif) for CI code-scanning upload. '
        + 'action=finish closes the engagement with the four required executive sections — root/orchestrator only '
        + '(operator children report back via send_message instead).',
      parameters: {
        action: { type: 'string', description: 'report (default) | sarif | finish.' },
        engagement_title: { type: 'string', description: 'Report title. Default "Security Assessment Report".' },
        scope_summary: { type: 'string', description: 'One-paragraph scope and authorization summary.' },
        sarif_file: { type: 'string', description: 'sarif: sidecar filename in the workspace (default findings.sarif).' },
        caller_role: { type: 'string', description: 'finish: "root" (orchestrator closing the engagement) or "operator" (child — refused).' },
        executive_summary: { type: 'string', description: 'finish (required): what was tested, what was found, bottom line.' },
        methodology: { type: 'string', description: 'finish (required): how it was tested (recon → validation → PoC).' },
        technical_analysis: { type: 'string', description: 'finish (required): root causes per finding.' },
        recommendations: { type: 'string', description: 'finish (required): prioritized fixes.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as {
          action?: string; engagement_title?: string; scope_summary?: string; sarif_file?: string
          caller_role?: string; executive_summary?: string; methodology?: string
          technical_analysis?: string; recommendations?: string
        }
        const findings = listFindings(config)

        if ((args.action ?? 'report') === 'sarif') {
          let written: { path: string; rules: number; results: number }
          try {
            written = writeSarifReport(config, findings, readLedger(config), args.sarif_file)
          } catch (e) {
            return String((e as Error)?.message ?? e)
          }
          return `SARIF 2.1.0 sidecar written to ${written.path} (${written.rules} rules, ${written.results} results: `
            + `${findings.length} findings, ${written.results - findings.length} coverage). Upload with `
            + `github/codeql-action/upload-sarif or filter kind == "fail" for alerts only.`
        }
        if (args.action === 'finish') {
          // Root-guard (ported from Strix finish_scan): only the orchestrator
          // closes an engagement. dsh's ToolRunContext carries no parent-agent
          // field, so the guard is an explicit caller_role declaration —
          // fail-closed: anything but "root" is refused.
          if (args.caller_role !== 'root') {
            return 'REFUSED: finish closes the whole engagement and is root/orchestrator-only. '
              + 'If you are an operator child, report back to your parent with send_message instead '
              + '(your findings are already filed via strix_finding; the orchestrator closes).'
          }
          const missing = missingFinishSections(args)
          if (missing.length > 0) {
            return `REJECTED: finish requires all four executive sections; missing: ${missing.join(', ')}.`
          }
          const reportPath = join(workspaceDir(config), 'report.md')
          const closing = [
            '',
            '---',
            '',
            '## Engagement Close (finish)',
            '',
            `Closed: ${new Date().toISOString()}`,
            '',
            '### Executive Summary',
            '',
            String(args.executive_summary),
            '',
            '### Methodology',
            '',
            String(args.methodology),
            '',
            '### Technical Analysis',
            '',
            String(args.technical_analysis),
            '',
            '### Recommendations',
            '',
            String(args.recommendations),
          ].join('\n')
          if (!existsSync(reportPath)) {
            return 'REJECTED: no report.md yet — run action=report first, then finish appends the closing sections.'
          }
          writeFileSync(reportPath, `${readFileSync(reportPath, 'utf8')}\n${closing}`, 'utf8')
          return `Engagement closed: four executive sections appended to ${reportPath} (${findings.length} findings).`
        }
        if (args.action !== undefined && args.action !== 'report') {
          return `Unknown action "${args.action}". Use report | sarif | finish.`
        }
        let coverageLines: string[] = []
        let ruledOutCount = 0
        const coverageFile = join(workspaceSub(config, 'coverage'), 'ledger.jsonl')
        if (existsSync(coverageFile)) {
          const parsed = readFileSync(coverageFile, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as Record<string, string>)
          ruledOutCount = parsed.filter((e) => e.outcome === 'ruled_out').length
          coverageLines = parsed
            .map((e) => `- ${e.surface} — ${e.risk_area}: ${e.outcome}${e.evidence_note ? ` (${e.evidence_note})` : ''}`)
        }

        const counts = severityCounts(findings)
        const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'
        const title = args.engagement_title ?? 'Security Assessment Report'
        const out: string[] = [
          `# ${title}`,
          '',
          `Generated: ${new Date().toISOString()}`,
          `Workspace: ${workspaceDir(config)}`,
          '',
          '## Scope & Authorization',
          '',
          args.scope_summary ?? '(not provided)',
          '',
          ...authorizationSummary(config),
          '',
          '## Executive Summary',
          '',
          `${findings.length} finding(s) registered: ${summary}.`,
          '',
          '## Findings',
          '',
        ]
        if (findings.length === 0) {
          out.push('_No findings registered._')
        }
        for (const f of findings) {
          out.push(
            `### ${f.id} — ${f.title}`,
            '',
            `- Severity: **${f.severity}**${f.cvss_vector ? ` (CVSS: ${f.cvss_vector})` : ''}`,
            `- Type: ${f.vulnerability_type}`,
            `- Target: ${f.target}`,
            f.confidence ? `- Confidence: ${f.confidence}` : '',
            '',
            f.description,
            '',
            '**Evidence (PoC):**',
            '',
            '```',
            f.evidence,
            '```',
            f.poc_script ? `PoC script: ${f.poc_script}` : '',
            f.counterevidence ? `\n**Counterevidence considered:** ${f.counterevidence}` : '',
            f.remediation ? `\n**Remediation:** ${f.remediation}` : '',
          )
          if (f.code_locations?.length) {
            out.push('', '**Proposed fix (inline, derived at report time):**', '')
            for (const loc of f.code_locations) {
              out.push(`\`${loc.file}\`:`, '', '```diff', `- ${loc.fix_before}`, `+ ${loc.fix_after}`, '```')
            }
          }
          if (f.fix_pr_body) out.push('', '**PR description:**', '', f.fix_pr_body)
          out.push('', '---', '')
        }
        out.push('## Coverage Ledger (assessed surfaces, including clean ones)', '', ...(coverageLines.length ? coverageLines : ['_No coverage entries._']))
        if (ruledOutCount > 0) {
          out.push('', `_Triage note: ${ruledOutCount} surface(s) ruled out (no attacker-reachable attack surface) — see ruled_out rows above._`)
        }
        out.push('', '## Methodology', '', 'Reconnaissance/mapping first, automated scanning with multiple engines, targeted validation with concrete PoCs, counterevidence passes, evidence-bound severity scoring (StriX-DH, adapted from the Strix methodology).')

        const reportPath = join(workspaceDir(config), 'report.md')
        writeFileSync(reportPath, out.filter((l) => l !== '').join('\n'), 'utf8')
        return `Report written to ${reportPath} (${findings.length} findings, ${coverageLines.length} coverage entries).`
      },
    }),
  )
}
