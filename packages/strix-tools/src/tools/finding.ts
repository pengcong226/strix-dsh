/**
 * strix_finding / strix_report — the evidence-bound reporting pipeline ported
 * from Strix: a vulnerability exists ONLY once registered with concrete
 * evidence; CVSS impact metrics must map to demonstrated PoC results;
 * counterevidence and confidence are first-class fields; updates supersede
 * re-filing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { listTrackedShellJobs } from '../lib/jobs.js'
import { nextIdAmong, nextSequentialId, safeId, safeWorkspacePath, workspaceDir, workspaceSub, writeExclusive, writeFileAtomic } from '../lib/util.js'
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

/**
 * A structured, tamper-evident pointer from a finding to a workspace
 * artifact (saved response, screenshot, pybox run dir, recon output).
 * `sha256` and `registered_at` are computed/set by the PLUGIN at
 * registration time — a model-claimed hash would attest nothing, so the
 * model only ever supplies artifact/source/note.
 */
export interface EvidenceRef {
  /** Workspace-relative artifact path, e.g. "responses/req-001.json". */
  artifact: string
  /** Which strix tool produced the artifact (strix_http, strix_browser, ...). */
  source: string
  /** ISO timestamp set by the plugin when the ref was registered. */
  registered_at: string
  /** sha256 of the artifact file at registration time. */
  sha256: string
  /** One-line claim this artifact supports. */
  note?: string
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
  /** Structured, hash-stamped pointers to workspace artifacts backing the evidence. */
  evidence_refs?: EvidenceRef[]
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
  const out: Finding[] = []
  for (const f of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    // Fail-soft: one corrupt file must not take down read-only callers
    // (notably strix_runs, which lists the whole engagement through here).
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Finding)
    } catch {
      /* skip the corrupt file; the rest of the registry still reads */
    }
  }
  return out
}

/**
 * Next finding id. Derived from the highest existing id (not the count), so
 * archiving or deleting a middle finding can never make a new id collide
 * with — and silently overwrite — a live one. Exported for regression tests.
 */
function nextId(config: ConfigType): string {
  return nextSequentialId(findingsDir(config), 'F-')
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
 * Distinguishing detail of a target beyond its endpoint key: query param
 * names/values and path segments after the first, tokenized. Two findings
 * on the same endpoint are the same finding only when these intersect (or
 * both are empty). Pure.
 */
function restTokens(target: string): Set<string> {
  const rest = norm(target).slice(norm(endpointKey(target)).length)
  return new Set(rest.split(/[^a-z0-9]+/).filter((w) => w.length > 0))
}

/**
 * Deterministic duplicate check (no LLM) over registered findings, ported
 * from the identity half of Strix's report/dedupe.py:
 *
 * - dependency_cve: same CVE + package (+ ecosystem when both carry it) is a
 *   duplicate — unless both carry different manifest paths (same flaw in two
 *   manifests is two findings).
 * - others: same vulnerability_type + same endpoint key + overlapping
 *   target DETAIL (query params / deeper path segments) is a duplicate.
 *   Different types, different endpoints, or disjoint details are NOT
 *   duplicates (e.g. SQLi in the `q` param vs SQLi in the `sort` param of
 *   the same /search endpoint are two findings).
 *
 *   Regression note: the previous check overlapped words from title+target
 *   against title+target+description — but on the same endpoint the URL
 *   structure words (scheme, host, first segment) are shared by
 *   construction, so the overlap was ALWAYS true and every second
 *   same-endpoint same-type finding was silently swallowed as a duplicate.
 *   The signal now lives in the detail tokens past the endpoint prefix.
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
  let manifestMismatch: { id: string; manifest: string } | null = null

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
      if (manifest && !hay.includes(manifest.toLowerCase())) {
        // Candidate names a manifest the existing text never mentions — THIS
        // finding is distinct (mirrors _distinct_manifest_paths: two
        // manifests, two findings). Remember it for the reason text but keep
        // scanning: a later finding may still be a real duplicate, and an
        // early `return not-duplicate` here would short-circuit that.
        manifestMismatch = { id: f.id, manifest }
        continue
      }
      return { duplicate: true, existing_id: f.id, reason: `same CVE ${candidate.cve} + package ${candidate.package_name} as ${f.id}.` }
    }

    if (cType !== fType) continue
    const cTarget = String(candidate.target ?? '')
    if (!cTarget.trim()) continue
    if (endpointKey(cTarget) !== endpointKey(f.target)) continue
    const cRest = restTokens(cTarget)
    const fRest = restTokens(String(f.target ?? ''))
    // Same endpoint + both targets carry no distinguishing detail → same
    // place, same type, nothing to tell them apart → duplicate. Otherwise
    // the details must actually intersect (same param / same deeper segment).
    const isDuplicate =
      (cRest.size === 0 && fRest.size === 0)
      || [...cRest].some((w) => fRest.has(w))
    if (isDuplicate) {
      return { duplicate: true, existing_id: f.id, reason: `same type (${cType}) + same endpoint (${endpointKey(cTarget)}) + overlapping target detail (params/segments) as ${f.id}.` }
    }
  }
  if (manifestMismatch) {
    return {
      duplicate: false,
      reason: `same CVE/package as ${manifestMismatch.id} but different manifest context (${manifestMismatch.manifest}); file separately.`,
    }
  }
  return { duplicate: false, reason: 'no registered finding shares type + endpoint + target detail.' }
}

export function validateFinding(args: Record<string, unknown>, strict: boolean): string | null {
  // Trim check: a whitespace-only evidence string is no evidence, and the
  // truthiness check `!args.evidence` alone let it slip past strict mode.
  if (strict && !String(args.evidence ?? '').trim()) {
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
  if (args.confidence && !CONFIDENCES.includes(args.confidence as (typeof CONFIDENCES)[number])) {
    return `REJECTED: confidence must be one of ${CONFIDENCES.join(', ')}`
  }
  if (args.cvss_vector !== undefined) {
    const cvssError = validateCvssVector(String(args.cvss_vector))
    if (cvssError) return cvssError
  }
  return null
}

/**
 * CVSS v3.1 vector-string syntax check: "CVSS:3.1/" prefix, KEY:VALUE
 * parts with known metric keys, single-letter values, and all eight base
 * metrics present. Syntax only — the mapping of metrics to demonstrated
 * PoC results stays a prompt discipline (the model must justify AV/AC/…
 * from its evidence, not from a calculator). Pure — unit-tested.
 */
const CVSS31_KEYS = new Set([
  'AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A',
  'E', 'RL', 'RC', 'CR', 'IR', 'AR',
  'MAV', 'MAC', 'MPR', 'MUI', 'MS', 'MC', 'MI', 'MA',
])
const CVSS31_BASE_REQUIRED = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']

export function validateCvssVector(v: string): string | null {
  const PREFIX = 'CVSS:3.1/'
  if (!v.startsWith(PREFIX)) {
    return `REJECTED: cvss_vector must be a CVSS v3.1 vector string starting with "${PREFIX}" (got "${v.slice(0, 40)}"). Omit the field if you cannot justify a vector.`
  }
  const parts = v.slice(PREFIX.length).split('/')
  const seen = new Set<string>()
  for (const part of parts) {
    const i = part.indexOf(':')
    if (i <= 0 || i === part.length - 1) {
      return `REJECTED: cvss_vector part "${part}" is not KEY:VALUE.`
    }
    const key = part.slice(0, i)
    const value = part.slice(i + 1)
    if (!CVSS31_KEYS.has(key)) {
      return `REJECTED: cvss_vector metric "${key}" is not a CVSS v3.1 metric key.`
    }
    if (!/^[A-Z]$/.test(value)) {
      return `REJECTED: cvss_vector value "${value}" for ${key} is not a single uppercase letter.`
    }
    seen.add(key)
  }
  const missing = CVSS31_BASE_REQUIRED.filter((k) => !seen.has(k))
  if (missing.length > 0) {
    return `REJECTED: cvss_vector is missing base metric(s): ${missing.join(', ')}. A v3.1 vector must carry all eight.`
  }
  return null
}

/**
 * Normalize model-supplied evidence_refs into EvidenceRef records: the
 * artifact path must resolve INSIDE the workspace (safeWorkspacePath) and
 * the file must EXIST — a ref to a missing file is a typo or a fabrication,
 * and fails closed like every other finding guard. sha256 + registered_at
 * are stamped here by the plugin, never taken from the caller. Returns the
 * refs plus a rejection string when any entry is invalid (the whole
 * create/update is refused — one bad ref must not slip into the ledger).
 */
export function normalizeEvidenceRefs(
  config: ConfigType,
  raw: unknown,
): { refs: EvidenceRef[]; error: string | null } {
  if (raw === undefined) return { refs: [], error: null }
  if (!Array.isArray(raw)) {
    return { refs: [], error: 'REJECTED: evidence_refs must be an array of {artifact, source, note?} objects.' }
  }
  const refs: EvidenceRef[] = []
  for (const entry of raw) {
    const e = entry as { artifact?: unknown; source?: unknown; note?: unknown }
    const artifact = typeof e.artifact === 'string' ? e.artifact.trim() : ''
    const source = typeof e.source === 'string' ? e.source.trim() : ''
    if (!artifact || !source) {
      return { refs: [], error: 'REJECTED: every evidence_ref needs a non-empty artifact path and a source tool name.' }
    }
    const resolved = safeWorkspacePath(workspaceDir(config), artifact)
    if (!resolved) {
      return { refs: [], error: `REJECTED: evidence_ref artifact "${artifact}" does not resolve inside the engagement workspace.` }
    }
    if (!existsSync(resolved)) {
      return { refs: [], error: `REJECTED: evidence_ref artifact "${artifact}" does not exist in the workspace — capture the evidence first (e.g. strix_http save_to, strix_browser screenshot), then reference it.` }
    }
    let sha256: string
    try {
      sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex')
    } catch (err) {
      return { refs: [], error: `REJECTED: evidence_ref artifact "${artifact}" could not be read for hashing (${err instanceof Error ? err.message : String(err)}).` }
    }
    const note = typeof e.note === 'string' ? e.note.trim() : ''
    refs.push({
      artifact,
      source,
      registered_at: new Date().toISOString(),
      sha256,
      ...(note ? { note } : {}),
    })
  }
  return { refs, error: null }
}

/**
 * Recompute each ref's artifact hash at report time and flag drift — an
 * artifact that changed after registration weakens the finding's
 * tamper-evidence and the report must say so instead of silently vouching
 * for the registration-time hash. Missing files are flagged too.
 */
export function evidenceRefDrift(config: ConfigType, refs: EvidenceRef[] | undefined): string[] {
  const lines: string[] = []
  for (const ref of refs ?? []) {
    const resolved = safeWorkspacePath(workspaceDir(config), ref.artifact)
    let current: string | null = null
    if (resolved && existsSync(resolved)) {
      try {
        current = createHash('sha256').update(readFileSync(resolved)).digest('hex')
      } catch {
        current = null
      }
    }
    if (current === null) {
      lines.push(`⚠ ${ref.artifact}: artifact missing at report time (registered sha256:${ref.sha256.slice(0, 12)}…)`)
    } else if (current !== ref.sha256) {
      lines.push(`⚠ ${ref.artifact}: artifact CHANGED since registration (was sha256:${ref.sha256.slice(0, 12)}…, now sha256:${current.slice(0, 12)}…)`)
    }
  }
  return lines
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
        evidence_refs: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'create/update: [{artifact, source, note?}] structured pointers to workspace artifacts backing the evidence '
            + '(e.g. {artifact:"responses/req-001.json", source:"strix_http", note:"time-based blind SQL response pair"}). '
            + 'The artifact must already exist inside the workspace — the plugin hashes it at registration and the report '
            + 're-verifies the hash, so tampered or missing artifacts are flagged.',
        },
        cvss_vector: { type: 'string', description: 'CVSS v3.1 vector string, only metrics backed by evidence.' },
        counterevidence: { type: 'string', description: 'The strongest case AGAINST this finding, and why it does not hold.' },
        confidence: { type: 'string', description: 'high | medium | low — honest assessment; static-only trace is at best medium.' },
        poc_script: { type: 'string', description: 'Path to a saved PoC script (workspace-relative).' },
        remediation: { type: 'string', description: 'How to fix it.' },
        code_locations: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'White-box inline fix: array of {file, fix_before, fix_after}.',
        },
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
          const { refs: evidenceRefs, error: refsError } = normalizeEvidenceRefs(config, args.evidence_refs)
          if (refsError) return refsError
          const draft = {
            title: String(args.title),
            vulnerability_type: String(args.vulnerability_type ?? 'other'),
            severity: String(args.severity),
            target: String(args.target),
            description: String(args.description ?? ''),
            evidence: String(args.evidence ?? ''),
            ...(evidenceRefs.length ? { evidence_refs: evidenceRefs } : {}),
            poc_script: args.poc_script ? String(args.poc_script) : undefined,
            cvss_vector: args.cvss_vector ? String(args.cvss_vector) : undefined,
            counterevidence: args.counterevidence ? String(args.counterevidence) : undefined,
            confidence: args.confidence ? String(args.confidence) : undefined,
            remediation: args.remediation ? String(args.remediation) : undefined,
            code_locations: args.code_locations as Finding['code_locations'],
            fix_pr_body: args.fix_pr_body ? String(args.fix_pr_body) : undefined,
            created_at: new Date().toISOString(),
          }
          // Allocate the id, then claim the file with O_EXCL. If another
          // creator took the same id between the scan and the write, re-scan
          // and retry rather than overwriting them.
          for (let attempt = 0; attempt < 20; attempt++) {
            const finding: Finding = { id: nextId(config), ...draft }
            if (writeExclusive(join(dir, `${finding.id}.json`), JSON.stringify(finding, null, 2))) {
              return `Registered ${finding.id} [${finding.severity}] ${finding.title} — ${finding.target}.`
            }
          }
          return 'REJECTED: could not allocate a free finding id after 20 attempts (concurrent writers on this workspace). Retry once.'
        }

        if (args.action === 'update') {
          const id = String(args.id ?? '')
          if (!safeId(id)) return `REJECTED: bad finding id "${id}".`
          const file = join(dir, `${id}.json`)
          if (!existsSync(file)) return `Finding ${id} not found.`
          const existing = JSON.parse(readFileSync(file, 'utf8')) as Finding
          // Enum guards on the fields being CHANGED (create already validates
          // the whole object; update must not be the back door for garbage —
          // e.g. severity "SortaCritical" slipping into the ledger and the
          // report's severity counts).
          if (args.severity !== undefined && !SEVERITIES.includes(args.severity as (typeof SEVERITIES)[number])) {
            return `REJECTED: severity must be one of ${SEVERITIES.join(', ')}.`
          }
          if (args.vulnerability_type !== undefined && !VULN_TYPES.includes(args.vulnerability_type as (typeof VULN_TYPES)[number])) {
            return `REJECTED: vulnerability_type must be one of ${VULN_TYPES.join(', ')}.`
          }
          if (args.confidence !== undefined && !CONFIDENCES.includes(args.confidence as (typeof CONFIDENCES)[number])) {
            return `REJECTED: confidence must be one of ${CONFIDENCES.join(', ')}.`
          }
          if (args.cvss_vector !== undefined) {
            const cvssError = validateCvssVector(String(args.cvss_vector))
            if (cvssError) return cvssError
          }
          const { refs: updatedRefs, error: refsError } = normalizeEvidenceRefs(config, args.evidence_refs)
          if (refsError) return refsError
          // Strict mode also covers updates: a confirmed finding must not be
          // quietly downgraded to evidence-less. Explicitly passing an empty
          // evidence is a downgrade; not passing it at all is fine.
          if (config.strictEvidence && args.evidence !== undefined && !String(args.evidence).trim()) {
            return 'REJECTED: strict mode forbids emptying the evidence of a registered finding. '
              + 'If the PoC no longer reproduces, update the evidence to state that and lower the severity/confidence instead.'
          }
          // Blank title/target would corrupt the registry: an empty target
          // also drops the finding out of every future dedupe comparison.
          if (args.title !== undefined && !String(args.title).trim()) {
            return 'REJECTED: title cannot be blanked. Pass a meaningful title or omit the field.'
          }
          if (args.target !== undefined && !String(args.target).trim()) {
            return 'REJECTED: target cannot be blanked — dedupe and the report rely on it. Omit the field to keep the current value.'
          }
          const mutable = ['title', 'vulnerability_type', 'severity', 'target', 'description', 'evidence', 'cvss_vector', 'counterevidence', 'confidence', 'poc_script', 'remediation', 'code_locations', 'fix_pr_body'] as const
          for (const key of mutable) {
            if (args[key] !== undefined) (existing as unknown as Record<string, unknown>)[key] = args[key]
          }
          // evidence_refs replaces as a whole (normalized + hash-stamped
          // above); an empty array clears them, matching update semantics.
          if (args.evidence_refs !== undefined) {
            if (updatedRefs.length > 0) existing.evidence_refs = updatedRefs
            else delete existing.evidence_refs
          }
          existing.updated_at = new Date().toISOString()
          existing.update_history = [
            ...(existing.update_history ?? []),
            `${new Date().toISOString()}: ${String(args.update_reason ?? '(no reason given)')}`,
          ]
          // Atomic rewrite: readers never see a torn finding. Concurrent
          // updates to the SAME finding are still last-writer-wins (with both
          // reasons preserved only in the winner's history) — re-get before
          // editing when another agent may be writing.
          await writeFileAtomic(file, JSON.stringify(existing, null, 2))
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

        return `REJECTED: unknown action "${args.action}". Use create | update | list | get | dedupe-check.`
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
 * Marker heading of the finish close-section in report.md. finish refuses to
 * append a second one, and report regeneration preserves the existing one.
 */
export const CLOSE_MARKER = '## Engagement Close (finish)'

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

/**
 * Convergence pass at engagement close (roadmap phase 3): the caller's live
 * strix-shell jobs get a bounded wait to settle, stragglers are killed with a
 * stated reason, and the outcome is reported verbatim — close must never
 * silently claim convergence it did not perform.
 *
 * The registry fences access by CALLER: `list(caller)` returns only the
 * caller's own (and unowned) jobs, and `wait`/`kill` throw "belongs to
 * another session" for anything else. Calling these without a caller made
 * convergence a silent no-op (list() returned only unowned jobs while every
 * strix-shell job is owned) — the caller is therefore threaded through from
 * the tool execution context, and jobs this process started but the caller
 * cannot see (owned by OTHER agents, e.g. operator children) are reported
 * honestly via the plugin's own bookkeeping instead of being claimed
 * converged. Registry failures degrade to a noted skip rather than blocking
 * the close.
 */
export async function convergeJobsAtFinish(
  ctx: Context,
  caller: { id?: string } | undefined,
  waitBudgetMs: number,
  tracked: Array<{ id: string; label: string; ownerAgentId?: string }> = listTrackedShellJobs(),
): Promise<string[]> {
  type LiveJob = { id: string; label: string }
  const snapshot = (): LiveJob[] => {
    const jobs = ctx.jobs.list(caller as never) as Array<{ id: string; kind: string; status: string; label: string }>
    return jobs
      .filter((j) => j.kind === 'strix-shell' && (j.status === 'running' || j.status === 'stopping'))
      .map((j) => ({ id: j.id, label: j.label }))
  }
  let live: LiveJob[]
  try {
    live = snapshot()
  } catch {
    return ['(job registry unavailable — convergence skipped; unknown strix-shell jobs may still be running)']
  }
  const visibleIds = new Set(live.map((j) => j.id))
  const foreign = tracked.filter((t) => !visibleIds.has(t.id))
  if (live.length === 0 && foreign.length === 0) return []
  const deadline = Date.now() + Math.max(0, waitBudgetMs)
  for (const j of live) {
    try {
      await ctx.jobs.wait(j.id as never, Math.max(100, deadline - Date.now()), caller as never)
    } catch {
      /* a wait that errors falls through to the kill pass below */
    }
  }
  let still: LiveJob[]
  try {
    still = snapshot()
  } catch {
    still = live
  }
  const lines = [
    `Jobs at close: ${live.length} of this caller's strix-shell job(s) live — ${live.length - still.length} settled within ${waitBudgetMs}ms, ${still.length} killed.`,
  ]
  for (const j of still) {
    try {
      ctx.jobs.kill(j.id as never, caller as never, 'engagement finish convergence')
      lines.push(`- killed: ${j.label}`)
    } catch {
      lines.push(`- kill FAILED for: ${j.label} (verify no container is still running)`)
    }
  }
  for (const t of foreign) {
    lines.push(
      `- NOT convergable: "${t.label}" (job ${t.id}) is owned by another agent (${t.ownerAgentId ?? 'unknown'}) — the registry fences cross-agent kills by design. Ask its owner or the operator to stop it; do not treat the engagement as fully closed while it runs.`,
    )
  }
  return lines
}

export function registerReport(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_report',
      description:
        'Generate the engagement report (workspace/report.md) from registered findings and the coverage ledger: '
        + 'executive summary, per-finding sections with evidence and hash-stamped evidence_refs, reviewed-and-clean surfaces, and methodology note. '
        + 'action=sarif instead emits a SARIF 2.1.0 sidecar (workspace/findings.sarif) for CI code-scanning upload. '
        + 'action=finish closes the engagement with the four required executive sections — root/orchestrator only '
        + '(operator children report back via send_message instead). Close is a real convergence: YOUR live '
        + 'strix-shell jobs are settled or killed (the jobs registry fences access by caller, so jobs other agents '
        + 'started are reported as not-convergable with their owners named — stop them before treating the close '
        + 'as final), remaining needs_follow_up/blocked surfaces are listed honestly in the close section, '
        + 'a frozen report-final.md copy is written, and a stale SARIF sidecar is refreshed.',
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
      async execute(raw: Record<string, unknown>, exec?: { agent?: { id?: string } }): Promise<string> {
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
          if (!existsSync(reportPath)) {
            return 'REJECTED: no report.md yet — run action=report first, then finish appends the closing sections.'
          }
          const previous = readFileSync(reportPath, 'utf8')
          // Idempotent close: a second finish must not stack another Close
          // section — amend report.md by hand instead.
          if (previous.includes(CLOSE_MARKER)) {
            return 'REJECTED: this engagement is already closed (report.md has an Engagement Close section). '
              + 'Amend report.md directly if the close needs changes — finish appends exactly once.'
          }
          // Convergence (phase 3): settle or kill the caller's live jobs, and
          // account for honestly-open work — a close that hides loose ends is
          // not a close. The caller threads through so the registry's
          // owner-fence sees this agent's own jobs (no-caller was a no-op).
          const convergence = await convergeJobsAtFinish(ctx, exec?.agent, config.finishJobWaitMs)
          const ledger = readLedger(config)
          const needsFollowUp = ledger.filter((e) => e.outcome === 'needs_follow_up')
          const blocked = ledger.filter((e) => e.outcome === 'blocked')
          const looseEndLines = [
            `${needsFollowUp.length} needs_follow_up and ${blocked.length} blocked surface(s) remain open at close:`,
            ...needsFollowUp.slice(0, 10).map((e) => `- needs_follow_up: ${e.surface} (${e.risk_area})${e.evidence_note ? ` — ${e.evidence_note}` : ''}`),
            ...(needsFollowUp.length > 10 ? [`- …and ${needsFollowUp.length - 10} more (see coverage ledger)`] : []),
            ...blocked.slice(0, 10).map((e) => `- blocked: ${e.surface} (${e.risk_area})${e.evidence_note ? ` — ${e.evidence_note}` : ''}`),
            ...(blocked.length > 10 ? [`- …and ${blocked.length - 10} more (see coverage ledger)`] : []),
          ]
          const closing = [
            '',
            '---',
            '',
            CLOSE_MARKER,
            '',
            `Closed: ${new Date().toISOString()}`,
            '',
            '### Convergence',
            '',
            ...(convergence.length > 0 ? convergence : ['No live strix-shell jobs at close.']),
            '',
            '### Loose Ends (honestly open)',
            '',
            ...looseEndLines,
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
          writeFileSync(reportPath, `${previous}\n${closing}`, 'utf8')
          // Freeze: the closed report gets a stable final copy, and a stale
          // SARIF sidecar is refreshed so the delivered pair is consistent.
          const freezeNotes: string[] = []
          const finalPath = join(workspaceDir(config), 'report-final.md')
          try {
            copyFileSync(reportPath, finalPath)
            freezeNotes.push(`Frozen final copy: ${finalPath}`)
          } catch (err) {
            freezeNotes.push(`WARNING: could not write the frozen copy ${finalPath} (${err instanceof Error ? err.message : String(err)}) — report.md is still the closed record.`)
          }
          const sarifTarget = args.sarif_file
            ? String(args.sarif_file)
            : (existsSync(join(workspaceDir(config), 'findings.sarif')) ? 'findings.sarif' : undefined)
          if (sarifTarget) {
            try {
              const written = writeSarifReport(config, findings, ledger, sarifTarget)
              freezeNotes.push(`SARIF refreshed: ${written.path} (${written.results} results)`)
            } catch (err) {
              freezeNotes.push(`WARNING: SARIF refresh failed (${err instanceof Error ? err.message : String(err)}) — the sidecar may predate the close.`)
            }
          }
          const presentHint = ' Present report-final.md (and findings.sarif when generated) with the present tool '
            + 'so the operator receives durable file references.'
          return `Engagement closed: four executive sections appended to ${reportPath} (${findings.length} findings). `
            + `Convergence: ${convergence.length > 0 ? convergence[0] : 'no live jobs.'} `
            + `Loose ends: ${needsFollowUp.length} needs_follow_up, ${blocked.length} blocked. `
            + `${freezeNotes.join(' ')}${presentHint}`
        }
        if (args.action !== undefined && args.action !== 'report') {
          return `Unknown action "${args.action}". Use report | sarif | finish.`
        }
        let coverageLines: string[] = []
        let ruledOutCount = 0
        // Shared fail-soft reader: a torn ledger line degrades to "skipped",
        // never to a crashed report.
        const coverageEntries = readLedger(config)
        ruledOutCount = coverageEntries.filter((e) => e.outcome === 'ruled_out').length
        coverageLines = coverageEntries
          .map((e) => `- ${e.surface} — ${e.risk_area}: ${e.outcome}${e.evidence_note ? ` (${e.evidence_note})` : ''}`)

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
          )
          // Optional fields are pushed conditionally instead of as '' slots:
          // '' is the blank-separator marker in this array, so using it for
          // "nothing here" is what made the report lose its paragraph breaks.
          if (f.confidence) out.push(`- Confidence: ${f.confidence}`)
          out.push(
            '',
            f.description,
            '',
            '**Evidence (PoC):**',
            '',
            '```',
            f.evidence,
            '```',
          )
          const refs = f.evidence_refs ?? []
          if (refs.length > 0) {
            out.push('', '**Evidence artifacts (hash-stamped at registration):**', '')
            for (const ref of refs) {
              out.push(`- \`${ref.artifact}\` (${ref.source}, sha256:${ref.sha256.slice(0, 12)}…)${ref.note ? ` — ${ref.note}` : ''}`)
            }
            // Re-verify at report time: a drifted or missing artifact
            // weakens the finding and the report must say so.
            for (const drift of evidenceRefDrift(config, f.evidence_refs)) {
              out.push(`- ${drift}`)
            }
          }
          if (f.poc_script) out.push('', `PoC script: ${f.poc_script}`)
          if (f.counterevidence) out.push('', `**Counterevidence considered:** ${f.counterevidence}`)
          if (f.remediation) out.push('', `**Remediation:** ${f.remediation}`)
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
        // Join as-is: entries are whole blocks and the '' entries are the
        // blank separator lines. Filtering them out (a previous version did
        // `out.filter((l) => l !== '')`) collapses every paragraph break, so
        // a list swallows the following description as a lazy continuation
        // and the `---` rule becomes a setext H2.
        // A report regenerated AFTER finish keeps the existing Close section:
        // without this, report→finish→report silently un-closes the engagement.
        let preservedClose = ''
        if (existsSync(reportPath)) {
          const previous = readFileSync(reportPath, 'utf8')
          const at = previous.indexOf(CLOSE_MARKER)
          if (at !== -1) preservedClose = `\n${previous.slice(at).trimEnd()}\n`
        }
        await writeFileAtomic(reportPath, `${out.join('\n')}\n${preservedClose}`)
        return `Report written to ${reportPath} (${findings.length} findings, ${coverageLines.length} coverage entries).`
      },
    }),
  )
}
