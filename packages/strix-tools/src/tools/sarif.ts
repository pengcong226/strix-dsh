/**
 * SARIF 2.1.0 sidecar for `strix_report action=sarif` — a deterministic port
 * of the core semantics of Strix's report/sarif.py:
 *
 * - One rule per vulnerability class (`strix/<type>`), one rule per coverage
 *   risk area (`strix/coverage/<area>`); severities collapse to SARIF's three
 *   levels, with the raw label + CVSS vector preserved in
 *   `result.properties.strix` and a `security-severity` score for
 *   code-scanning ranking.
 * - Findings without a source location keep a meaningful anchor: the URL
 *   target rides in `logicalLocations`, and the physical location falls back
 *   to a synthetic anchor flagged via `properties.strix.synthetic_location`
 *   (never silently dropped).
 * - `code_locations` fixes become SARIF `fixes` (one-click suggestions).
 * - Coverage rides as non-failing results (`pass` / `open` /
 *   `notApplicable`); consumers that only want alerts filter `kind == "fail"`.
 * - Run completeness on `run.invocations`.
 *
 * Pure builders + one file writer. No LLM, no network, no Docker — safe in CI.
 * (Upstream's LLM dedupe judge and schema-validation step are out of scope.)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { workspaceDir } from '../lib/util.js'
import type { CoverageEntry } from './coverage.js'
import type { Finding } from './finding.js'

export const SARIF_VERSION = '2.1.0'
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
/** Fallback when package.json is unreadable (tests, exotic bundling). */
export const STRIX_DH_VERSION_FALLBACK = '0.8.0'
/**
 * Bundle version from the package manifest (dist/../package.json at
 * runtime, src/../../package.json under vitest) — never a hardcoded
 * constant that drifts from package.json.
 */
export function strixDhVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : STRIX_DH_VERSION_FALLBACK
  } catch {
    return STRIX_DH_VERSION_FALLBACK
  }
}
export const SARIF_FILENAME = 'findings.sarif'
/** Synthetic anchor for DAST findings that have no source file. */
export const SYNTHETIC_ANCHOR = 'SECURITY.md'

export function sarifPath(config: ConfigType, filename?: string): string {
  const name = (filename ?? SARIF_FILENAME).trim() || SARIF_FILENAME
  if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.endsWith('.sarif')) {
    throw new Error(`REJECTED: sarif file must be a plain filename ending in .sarif, got "${filename}".`)
  }
  return join(workspaceDir(config), name)
}

export type SarifLevel = 'error' | 'warning' | 'note'

/** SARIF has three levels; Strix's five severities collapse into them. */
export function severityLevel(severity: string): SarifLevel {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error'
    case 'medium':
    case 'low':
      return 'warning'
    default:
      return 'note'
  }
}

const SCORE_BY_SEVERITY: Record<string, string> = {
  critical: '9.0',
  high: '7.5',
  medium: '5.0',
  low: '2.5',
  info: '0.0',
}

/** Code-scanning ranking score (0.0–10.0 string); conservative label map. */
export function securitySeverity(severity: string): string {
  return SCORE_BY_SEVERITY[severity] ?? '0.0'
}

function slug(s: string): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return t || 'unknown'
}

export function findingRuleId(f: Finding): string {
  return `strix/${slug(f.vulnerability_type || 'other')}`
}

export function coverageRuleId(e: CoverageEntry): string {
  return `strix/coverage/${slug(e.risk_area || 'general')}`
}

interface SarifRule {
  id: string
  name: string
  shortDescription: { text: string }
  properties: { 'security-severity': string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObj = Record<string, any>

function buildFindingResult(f: Finding, ruleIndex: number): JsonObj {
  const level = severityLevel(f.severity)
  const result: JsonObj = {
    ruleId: findingRuleId(f),
    ruleIndex,
    level,
    kind: 'fail',
    message: { text: `${f.id} — ${f.title} (${f.target})` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: SYNTHETIC_ANCHOR },
          region: { startLine: 1 },
        },
      },
    ],
    logicalLocations: [{ name: f.target, kind: 'web' }],
    properties: {
      strix: {
        findingId: f.id,
        severity: f.severity,
        ...(f.cvss_vector ? { cvss: f.cvss_vector } : {}),
        ...(f.confidence ? { confidence: f.confidence } : {}),
        synthetic_location: true,
      },
    },
  }
  if (f.code_locations?.length) {
    result.fixes = [
      {
        description: { text: `Suggested fix for ${f.id}` },
        artifactChanges: f.code_locations.map((loc) => ({
          artifactLocation: { uri: loc.file },
          replacements: [
            {
              deletedRegion: { startLine: 1, startColumn: 1 },
              insertedContent: { text: loc.fix_after },
            },
          ],
        })),
      },
    ]
  }
  return result
}

function coverageKind(outcome: string): string {
  switch (outcome) {
    case 'clean':
    case 'finding':
      return 'pass'
    case 'needs_follow_up':
      return 'open'
    default:
      return 'notApplicable'
  }
}

function buildCoverageResult(e: CoverageEntry, ruleIndex: number): JsonObj {
  return {
    ruleId: coverageRuleId(e),
    ruleIndex,
    level: 'note',
    kind: coverageKind(e.outcome),
    message: {
      text:
        e.outcome === 'finding'
          ? `${e.id} ${e.surface} — ${e.risk_area}: finding filed (see the fail result).`
          : `${e.id} ${e.surface} — ${e.risk_area}: ${e.outcome}${e.evidence_note ? ` (${e.evidence_note})` : ''}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: SYNTHETIC_ANCHOR },
          region: { startLine: 1 },
        },
      },
    ],
    logicalLocations: [{ name: e.surface, kind: 'web' }],
  }
}

/** Build the full SARIF document from findings + coverage. Pure — unit-tested. */
export function buildSarifDocument(findings: Finding[], coverage: CoverageEntry[]): JsonObj {
  const rules: SarifRule[] = []
  const ruleIndex = new Map<string, number>()
  const useRule = (id: string, label: string, score: string): number => {
    let idx = ruleIndex.get(id)
    if (idx === undefined) {
      idx = rules.length
      ruleIndex.set(id, idx)
      rules.push({
        id,
        name: label,
        shortDescription: { text: label },
        properties: { 'security-severity': score },
      })
    }
    return idx
  }

  const results: JsonObj[] = []
  for (const f of findings) {
    const idx = useRule(findingRuleId(f), `StriX-DH ${f.vulnerability_type || 'other'}`, securitySeverity(f.severity))
    results.push(buildFindingResult(f, idx))
  }
  for (const e of coverage) {
    const idx = useRule(coverageRuleId(e), `Coverage: ${e.risk_area || 'general'}`, '0.0')
    results.push(buildCoverageResult(e, idx))
  }

  return {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: 'StriX-DH',
            version: strixDhVersion(),
            informationUri: 'https://github.com/deepseek-ai/deepseek-harness',
            rules,
          },
        },
        results,
        invocations: [{ executionSuccessful: true }],
      },
    ],
  }
}

/** Write the sidecar next to report.md. Returns the path + counts. */
export function writeSarifReport(
  config: ConfigType,
  findings: Finding[],
  coverage: CoverageEntry[],
  filename?: string,
): { path: string; rules: number; results: number } {
  const path = sarifPath(config, filename)
  const doc = buildSarifDocument(findings, coverage)
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8')
  return {
    path,
    rules: (doc.runs[0] as JsonObj).tool.driver.rules.length as number,
    results: (doc.runs[0] as JsonObj).results.length as number,
  }
}
