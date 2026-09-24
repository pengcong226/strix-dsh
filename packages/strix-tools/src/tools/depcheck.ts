/**
 * strix_depcheck — dependency vulnerability lookup (the "vulnerability
 * database" for AI tooling, backlog A-2): OSV.dev as the primary source,
 * CISA KEV as the exploited-in-the-wild uplift, EPSS for priority ordering.
 *
 * Chain per package: OSV querybatch (package+version → vuln ids) → vulns/{id}
 * detail (summary/severity/CVE aliases) → KEV cache lookup → EPSS score.
 * Results sort KEV-hit first, then EPSS desc, and carry the exact fields
 * `strix_finding create vulnerability_type=dependency_cve` needs
 * (package_name/cve/manifest_path flow into dedupe-check identity).
 *
 * All three sources are keyless. KEV (~1MB, 1694 entries) is cached at
 * workspace/vulndb/kev.json with a 24h TTL (action=kev-refresh forces a
 * refetch); OSV/EPSS are queried live per call (small payloads). Enrichment
 * (detail + EPSS) runs through a 6-lane pool under one depcheckTimeoutMs
 * deadline (default 120s): rows claimed after the deadline degrade to
 * vuln-id-only instead of blocking the tool call unbounded.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { checkBudget } from './budget.js'
import { workspaceSub } from '../lib/util.js'

const OSV_BATCH = 'https://api.osv.dev/v1/querybatch'
const OSV_VULN = 'https://api.osv.dev/v1/vulns/'
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
const EPSS_URL = 'https://api.first.org/data/v1/epss'
const KEV_TTL_MS = 24 * 3600 * 1000
const FETCH_TIMEOUT_MS = 20_000
/** Concurrent detail/EPSS fetches inside one check (each still 20s-capped). */
const ENRICH_CONCURRENCY = 6

export interface DepPackage {
  ecosystem: string
  name: string
  version: string
}

export interface DepFinding {
  package: string
  ecosystem: string
  version: string
  vuln_id: string
  cve: string | null
  summary: string
  severity: string | null
  kev_hit: boolean
  epss: number | null
  fixed_in: string[]
}

function vulndbDir(config: ConfigType): string {
  return workspaceSub(config, 'vulndb')
}

function kevFile(config: ConfigType): string {
  return join(vulndbDir(config), 'kev.json')
}

interface KevEntry {
  cveID: string
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the KEV cache when fresh; null when missing/stale/corrupt.
 *
 * Two call shapes (previous behaviour kept, dead branch removed):
 * - `nowMs === undefined` (callers that just want a lookup): a stale cache is
 *   still returned — a slightly old "exploited in the wild" list beats none,
 *   and `kevCacheFresh` is how a caller asks whether a refresh is due.
 * - `nowMs` given (kevCacheFresh): staleness returns null, i.e. NOT fresh.
 *
 * Pure-ish (fs read) — unit-tested.
 */
export function readKevCache(config: ConfigType, nowMs?: number): Set<string> | null {
  const file = kevFile(config)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { fetched_at: string; cves: string[] }
    const fetchedAt = Date.parse(raw.fetched_at)
    if (Number.isNaN(fetchedAt)) return null
    if (nowMs !== undefined && nowMs - fetchedAt > KEV_TTL_MS) return null
    return new Set(Array.isArray(raw.cves) ? raw.cves : [])
  } catch {
    return null
  }
}

export function kevCacheFresh(config: ConfigType): boolean {
  return readKevCache(config, Date.now()) !== null
}

/** Fetch the KEV catalog and persist {fetched_at, cves}. Returns the CVE set. */
export async function refreshKevCache(config: ConfigType): Promise<{ count: number; path: string }> {
  const data = (await fetchJson(KEV_URL)) as { vulnerabilities?: KevEntry[] }
  const cves = [...new Set((data.vulnerabilities ?? []).map((v) => v.cveID).filter(Boolean))]
  mkdirSync(vulndbDir(config), { recursive: true })
  const path = kevFile(config)
  writeFileSync(path, JSON.stringify({ fetched_at: new Date().toISOString(), cves }, null, 2), 'utf8')
  return { count: cves.length, path }
}

/** Extract CVE aliases + first fixed version from an OSV vuln record. Pure. */
export function parseOsvVuln(vuln: Record<string, unknown>): { cve: string | null; summary: string; severity: string | null; fixed_in: string[] } {
  const aliases = Array.isArray(vuln.aliases) ? (vuln.aliases as unknown[]).map(String) : []
  const cve = aliases.find((a) => /^CVE-\d{4}-\d+$/i.test(a)) ?? null
  const summary = String((vuln.summary as string) ?? (vuln.details as string) ?? '').slice(0, 500)
  let severity: string | null = null
  if (Array.isArray(vuln.severity)) {
    const cvss = (vuln.severity as Array<Record<string, string>>).find((s) => s.type === 'CVSS_V3')
    severity = cvss?.score?.trim() || null
  }
  const fixed_in: string[] = []
  const affected = Array.isArray(vuln.affected) ? (vuln.affected as Array<Record<string, unknown>>) : []
  for (const aff of affected) {
    const ranges = Array.isArray(aff.ranges) ? (aff.ranges as Array<Record<string, unknown>>) : []
    for (const r of ranges) {
      const events = Array.isArray(r.events) ? (r.events as Array<Record<string, string>>) : []
      for (const e of events) {
        if (e.fixed && !fixed_in.includes(e.fixed)) fixed_in.push(e.fixed)
      }
    }
  }
  return { cve, summary, severity, fixed_in }
}

/** Sort: KEV hits first, then EPSS desc, then vuln id. Pure — unit-tested. */
export function sortDepFindings(rows: DepFinding[]): DepFinding[] {
  return [...rows].sort((a, b) => {
    if (a.kev_hit !== b.kev_hit) return a.kev_hit ? -1 : 1
    const ea = a.epss ?? -1
    const eb = b.epss ?? -1
    if (ea !== eb) return eb - ea
    return a.vuln_id.localeCompare(b.vuln_id)
  })
}

/**
 * Run async work items through a fixed-size worker pool. Pure scheduler —
 * unit-tested with fake items; `runItem` rejections settle the item as null
 * instead of rejecting the whole batch (enrichment is best-effort).
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  runItem: (item: T) => Promise<unknown>,
): Promise<Array<{ item: T; ok: boolean }>> {
  const outcomes: Array<{ item: T; ok: boolean }> = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      if (i >= items.length) return
      next += 1
      try {
        await runItem(items[i]!)
        outcomes[i] = { item: items[i]!, ok: true }
      } catch {
        outcomes[i] = { item: items[i]!, ok: false }
      }
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: lanes }, () => worker()))
  return outcomes
}

export function formatDepFinding(f: DepFinding): string {
  const tags = [
    f.kev_hit ? 'KEV-HIT' : null,
    f.epss !== null ? `epss=${f.epss.toFixed(3)}` : null,
    f.cve,
    f.severity ? `cvss=${f.severity}` : null,
    f.fixed_in.length ? `fixed=${f.fixed_in.join(',')}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return `- ${f.package}@${f.version} [${f.ecosystem}] ${f.vuln_id}: ${f.summary}${tags ? ` (${tags})` : ''}`
}

export function registerDepcheck(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_depcheck',
      description:
        'Dependency vulnerability lookup (the AI-tooling vulnerability database): package+version → CVEs via '
        + 'OSV.dev (keyless, minute-fresh), uplifted by the CISA KEV exploited-in-the-wild catalog (cached 24h '
        + 'in workspace/vulndb/), ordered by EPSS exploit-probability scores. Results carry the exact fields '
        + 'for strix_finding create vulnerability_type=dependency_cve (file only after validating reachability — '
        + 'a vulnerable dependency is a lead until you prove the code path). Metadata queries only, no attack traffic.',
      parameters: {
        action: { type: 'string', required: true, description: 'check | kev-refresh | status' },
        packages: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'check: [{ecosystem, name, version}] — ecosystem e.g. npm, PyPI, Go, Maven.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { action: string; packages?: DepPackage[] }

        if (args.action === 'status') {
          const file = kevFile(config)
          if (!existsSync(file)) {
            return 'vulndb: KEV cache missing — run action=kev-refresh once (downloads ~1MB from CISA). OSV/EPSS are queried live per check.'
          }
          try {
            const rawCache = JSON.parse(readFileSync(file, 'utf8')) as { fetched_at: string; cves: string[] }
            const ageH = Math.round((Date.now() - Date.parse(rawCache.fetched_at)) / 3600000)
            return `vulndb: KEV cache ${rawCache.cves.length} CVEs, fetched ${rawCache.fetched_at} (~${ageH}h ago${ageH > 24 ? ', STALE — run kev-refresh' : ''}). OSV/EPSS live per check.`
          } catch {
            return 'vulndb: KEV cache corrupt — run action=kev-refresh.'
          }
        }

        if (args.action === 'kev-refresh') {
          try {
            const { count, path } = await refreshKevCache(config)
            return `KEV cache refreshed: ${count} CVEs → ${path}.`
          } catch (e) {
            return `KEV refresh failed: ${e instanceof Error ? e.message : String(e)}. Old cache (if any) still in place.`
          }
        }

        if (args.action === 'check') {
          const pkgs = Array.isArray(args.packages) ? args.packages : []
          if (pkgs.length === 0) return 'REJECTED: packages (at least one {ecosystem, name, version}) is required for check.'
          if (pkgs.length > 50) return 'REJECTED: at most 50 packages per check (OSV batch limits).'
          for (const p of pkgs) {
            // Null/non-object elements crash the optional chain below —
            // reject them as malformed input instead.
            if (!p || typeof p !== 'object') {
              return 'REJECTED: every packages entry must be an object {ecosystem, name, version}.'
            }
            if (!p.ecosystem?.trim() || !p.name?.trim() || !p.version?.trim()) {
              return 'REJECTED: every package needs ecosystem, name, and version.'
            }
          }
          // A 50-package check fans out to 1+N+M network calls — heavy like
          // recon/sast, so the same budget gate applies (warn or block).
          const gate = checkBudget(config, 'strix_depcheck')
          if (gate.over && config.budgetAction === 'block') return gate.message
          const warnPrefix = gate.over ? gate.message + '\n' : ''

          let batch: { results?: Array<{ vulns?: Array<{ id: string }> }> }
          try {
            batch = (await fetchJson(OSV_BATCH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                queries: pkgs.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })),
              }),
            })) as typeof batch
          } catch (e) {
            return `OSV query failed: ${e instanceof Error ? e.message : String(e)}. Retry later — nothing was filed.`
          }

          // KEV: fresh cache preferred, stale cache as fallback, empty set as last resort.
          let kev: Set<string> = readKevCache(config, Date.now()) ?? new Set<string>()
          if (kev.size === 0) {
            try {
              await refreshKevCache(config)
              kev = readKevCache(config, Date.now()) ?? readKevCache(config) ?? new Set<string>()
            } catch {
              kev = readKevCache(config) ?? new Set<string>()
            }
          }

          // Enrichment (OSV detail + EPSS per vuln) runs through a bounded
          // pool under one overall deadline. The previous loop awaited each
          // fetch serially with no ceiling: a 50-package check × several vulns
          // each × 20s per-fetch timeout could park the tool call for many
          // minutes — the only unbounded tool in the suite.
          const deadline = Date.now() + config.depcheckTimeoutMs
          const expired = (): boolean => Date.now() > deadline
          const rows: DepFinding[] = []
          const results = batch.results ?? []
          const work: Array<() => DepFinding> = []
          for (let i = 0; i < pkgs.length; i++) {
            const pkg = pkgs[i]!
            const vulns = results[i]?.vulns ?? []
            for (const v of vulns) {
              work.push(() => {
                // The row lands at claim time, whatever the budget. The
                // pre-fix code gated the push on !expired() while the comment
                // promised "degrades to vuln-id-only (still listed)": rows
                // claimed after the deadline silently VANISHED (30 vulns → 12
                // listed), and the runItem then enriched rows[last] — another
                // worker's row — duplicating detail fetches to no effect.
                const row: DepFinding = {
                  package: pkg.name,
                  ecosystem: pkg.ecosystem,
                  version: pkg.version,
                  vuln_id: v.id,
                  cve: null,
                  summary: v.id,
                  severity: null,
                  kev_hit: false,
                  epss: null,
                  fixed_in: [],
                }
                rows.push(row)
                return row
              })
            }
          }
          // Phase 1 (bounded pool): fetch OSV detail + EPSS for each vuln,
          // mutating the pool-returned row in place. Items claimed after the
          // deadline keep their vuln-id-only row (already pushed above) and
          // skip enrichment — the report counts and lists them via the
          // degrade note instead of hiding them.
          await runPool(work, ENRICH_CONCURRENCY, async (claim) => {
            const row = claim()
            if (expired()) return
            if (row.vuln_id === undefined) return
            try {
              const detail = (await fetchJson(`${OSV_VULN}${encodeURIComponent(row.vuln_id)}`)) as Record<string, unknown>
              const parsed = parseOsvVuln(detail)
              row.cve = parsed.cve
              row.summary = parsed.summary || row.vuln_id
              row.severity = parsed.severity
              row.fixed_in = parsed.fixed_in
              row.kev_hit = parsed.cve ? kev.has(parsed.cve.toUpperCase()) : false
              if (parsed.cve && !expired()) {
                try {
                  const ej = (await fetchJson(`${EPSS_URL}?cve=${encodeURIComponent(parsed.cve)}`)) as {
                    data?: Array<{ epss?: string }>
                  }
                  const score = parseFloat(ej.data?.[0]?.epss ?? '')
                  row.epss = Number.isFinite(score) ? score : null
                } catch {
                  row.epss = null
                }
              }
            } catch {
              /* detail unavailable: the row keeps vuln-id-only shape */
            }
          })

          if (rows.length === 0) {
            return `${warnPrefix}${pkgs.length} package(s) checked against OSV: no known vulns. (Absence here is not proof of safety — unindexed or brand-new flaws miss every DB.)`
          }
          const sorted = sortDepFindings(rows)
          const degraded = rows.filter((r) => r.summary === r.vuln_id && r.severity === null).length
          const degradeNote = degraded > 0
            ? `\n[enrichment budget: ${degraded} row(s) listed as vuln-id only — the ${Math.round(config.depcheckTimeoutMs / 1000)}s depcheckTimeoutMs budget ran out or OSV detail was unavailable; re-run check on the specific package for full detail]`
            : ''
          return [
            `${warnPrefix}${sorted.length} known vuln(s) in ${pkgs.length} package(s) (KEV-hit first, then EPSS):${degradeNote}`,
            ...sorted.map(formatDepFinding),
            'Next: prove reachability before filing — a vulnerable dependency is a lead. File confirmed ones with strix_finding create vulnerability_type=dependency_cve (dedupe-check keys on CVE + package).',
          ].join('\n')
        }

        return `REJECTED: unknown action "${args.action}". Use check | kev-refresh | status.`
      },
    }),
  )
}
