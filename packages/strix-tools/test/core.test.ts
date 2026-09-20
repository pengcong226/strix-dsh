/**
 * Unit tests for the pure, filesystem-light core of StriX-DH tools:
 * raw-request parsing, finding validation, ledger round-trips, and the
 * bounded-output helper. No Docker, no network, no LLM — safe in CI.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConfigType } from '../src/config.js'
import { nextIdAmong, nextSequentialId, runProcess, clampTimeoutMs, safeId, safeWorkspacePath, truncate, writeExclusive, writeFileAtomic } from '../src/lib/util.js'
import { registerBundledSkills } from '../src/skills-provider.js'
import { registerNotes } from '../src/tools/notes.js'
import { checkExtraArgs, SEMGREP_BLOCKED_EXTRA_FLAGS, semgrepTargetAllowed } from '../src/tools/sast.js'
import { createApprovalGate, matchesAutoAllow, splitApprovalSummary } from '../src/lib/approval.js'
import { methodologySection } from '../src/index.js'
import { formatDepFinding, parseOsvVuln, readKevCache, runPool, sortDepFindings } from '../src/tools/depcheck.js'
import { parseRawRequest, evaluatePostPolicy, sendHttpRequest, STATE_CHANGING_METHODS, normalizePathKey } from '../src/tools/http.js'
import { SEVERITIES, VULN_TYPES, authorizationSummary, checkDuplicate, CLOSE_MARKER, evidenceRefDrift, listFindings, missingFinishSections, normalizeEvidenceRefs, registerFinding, registerReport, validateCvssVector, validateFinding } from '../src/tools/finding.js'
import { OUTCOMES, readLedger, registerCoverage, writeLedger } from '../src/tools/coverage.js'
import { authorizationPath, isAuthorizationExpired, maskTestAccount, matchesPreApprovedPost, readAuthorization, registerAuthorization, renderAuthorizationSection, targetCoveredByAuth } from '../src/tools/authorization.js'
import { claimPostCount, postCountsPath, readPostCounts } from '../src/tools/http.js'
import { budgetPath, checkBudget, formatUsd, priceUsage, readBudget, registerBudget } from '../src/tools/budget.js'
import { strixDhVersion } from '../src/tools/sarif.js'
import { validPipPackages, registerPybox } from '../src/tools/pybox.js'
import { buildBackgroundDockerArgs, jobLabel } from '../src/lib/jobs.js'
import { registerThreatModel } from '../src/tools/threat-model.js'
import { createSprayGuardHandler, registerBrowser, type GuardedRoute } from '../src/tools/browser.js'
import { mirrorEvent } from '../src/lib/session-mirror.js'
import { filterFlows, formatFlow, dockerPsLineMatchesPort, pidOwnedByDockerCli, procCmdlineIsDockerCli, proxyImageKey, readFlows, stopSidecarWith, tasklistRowIsDockerCli } from '../src/tools/proxy.js'
import { registerShell } from '../src/tools/shell.js'
import { buildHttpxArgs, isSafeDomain } from '../src/tools/recon.js'
import {
  SARIF_FILENAME,
  buildSarifDocument,
  coverageRuleId,
  findingRuleId,
  sarifPath,
  securitySeverity,
  severityLevel,
  writeSarifReport,
} from '../src/tools/sarif.js'

/** A scratch config rooted at a fresh temp dir so tests never touch the real workspace. */
function scratchConfig(): ConfigType {
  return {
    workspaceDir: mkdtempSync(join(tmpdir(), 'strix-test-')),
    httpTimeoutMs: 1000,
    httpMaxBodyChars: 200,
    httpMaxBodyBytes: 2_000_000,
    httpPostCapPerPath: 5,
    shellImage: 'python:3.12-slim',
    shellAllowedImages: [],
    approvalAutoAllow: [],
    shellNetwork: false,
    shellTimeoutMs: 1000,
    pyboxImage: 'python:3.12-slim',
    pyboxExtraPackages: [],
    pyboxNetwork: false,
    pyboxTimeoutMs: 1000,
    binariesDir: '',
    reconTimeoutMs: 1000,
    nucleiRateLimit: 50,
    sastNucleiImage: 'projectdiscovery/nuclei:latest',
    sastSemgrepImage: 'returntocorp/semgrep:latest',
    sastNetwork: true,
    sastExtraMountRoots: [],
    depcheckTimeoutMs: 5_000,
    finishJobWaitMs: 200,
    proxyImage: 'mitmproxy/mitmproxy:latest',
    browserHeadless: true,
    browserEnforcePostPolicy: true,
    strictEvidence: true,
    approvalGate: 'off',
    budgetLimitUsd: 0,
    budgetInputPer1k: 0.0001,
    budgetOutputPer1k: 0.0002,
    budgetAction: 'warn',
  }
}

describe('parseRawRequest', () => {
  it('parses a full raw request with host header, method, headers, and body', () => {
    const parsed = parseRawRequest(
      'POST /login HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n\r\n{"u":"a"}',
    )
    expect(parsed.method).toBe('POST')
    expect(parsed.url).toBe('http://example.com/login')
    expect(parsed.headers['content-type']).toBe('application/json')
    expect(parsed.body).toBe('{"u":"a"}')
  })

  it('accepts an absolute URL in the request line without a Host header', () => {
    const parsed = parseRawRequest('GET https://example.com/x?q=1 HTTP/1.1\nAccept: */*\n\n')
    expect(parsed.method).toBe('GET')
    expect(parsed.url).toBe('https://example.com/x?q=1')
  })

  it('leaves url undefined when there is no host and no absolute URL', () => {
    const parsed = parseRawRequest('GET /only-path HTTP/1.1\nX-A: b\n\n')
    expect(parsed.url).toBeUndefined()
    expect(parsed.method).toBe('GET')
    expect(parsed.headers['x-a']).toBe('b')
  })

  it('skips malformed header lines without a colon', () => {
    const parsed = parseRawRequest('GET / HTTP/1.1\nHost: example.com\nnot-a-header\n\n')
    expect(parsed.url).toBe('http://example.com/')
    expect(Object.keys(parsed.headers)).toHaveLength(0)
  })
})

describe('validateFinding', () => {
  it('rejects evidence-less findings under strict mode', () => {
    const rejection = validateFinding({ severity: 'high', vulnerability_type: 'sqli' }, true)
    expect(rejection).toMatch(/^REJECTED: no evidence/)
  })

  it('passes evidence-less findings when strict mode is off', () => {
    expect(validateFinding({ severity: 'high', vulnerability_type: 'sqli' }, false)).toBeNull()
  })

  it('rejects unknown severity and vulnerability_type values', () => {
    expect(validateFinding({ evidence: 'poc', severity: 'nope' }, true)).toMatch(/severity/)
    expect(validateFinding({ evidence: 'poc', vulnerability_type: 'nope' }, true)).toMatch(/vulnerability_type/)
  })

  it('accepts a well-formed filing', () => {
    expect(
      validateFinding({ evidence: 'HTTP 200 + response body', severity: 'high', vulnerability_type: 'sqli' }, true),
    ).toBeNull()
  })
})

describe('vocabulary constants', () => {
  it('covers the ten primary classes from the methodology section', () => {
    for (const t of ['idor', 'sqli', 'ssrf', 'xss', 'xxe', 'rce', 'csrf', 'race_condition', 'business_logic', 'auth_jwt']) {
      expect(VULN_TYPES).toContain(t)
    }
  })

  it('uses the standard five severities', () => {
    expect([...SEVERITIES]).toEqual(['info', 'low', 'medium', 'high', 'critical'])
  })
})

describe('coverage ledger round-trip', () => {
  it('writes and re-reads entries losslessly', () => {
    const config = scratchConfig()
    writeLedger(config, [
      { id: 'C-001', surface: 'https://example.com/', risk_area: 'SQLi', outcome: 'clean', evidence_note: '', recorded_at: 't0' },
      { id: 'C-002', surface: 'https://example.com/login', risk_area: 'auth bypass', outcome: 'needs_follow_up', evidence_note: 'pending', recorded_at: 't1' },
    ])
    const entries = readLedger(config)
    expect(entries).toHaveLength(2)
    expect(entries[1]?.outcome).toBe('needs_follow_up')
    // Raw file must be JSONL: one object per line.
    const lines = readFileSync(join(config.workspaceDir, 'coverage', 'ledger.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').id).toBe('C-001')
  })

  it('returns an empty list when no ledger exists yet', () => {
    expect(readLedger(scratchConfig())).toEqual([])
  })

  it('accepts ruled_out as a triage closure outcome', () => {
    expect(OUTCOMES).toContain('ruled_out')
    const config = scratchConfig()
    writeLedger(config, [
      { id: 'C-001', surface: 'https://static.example.com/', risk_area: 'fingerprint', outcome: 'ruled_out', evidence_note: 'no login / no params / static CMS page', recorded_at: 't0' },
    ])
    const entries = readLedger(config)
    expect(entries[0]?.outcome).toBe('ruled_out')
    expect(entries[0]?.evidence_note).toContain('no login')
  })

  it('update appends a version row and never swallows concurrent records (P0 regression)', async () => {
    const config = scratchConfig()
    const regs: unknown[] = []
    registerCoverage({ tools: { register: (d: unknown) => regs.push(d) } } as never, config)
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    await tool.execute({ action: 'record', surface: 'a.example.com', risk_area: 'xss', outcome: 'clean' }, {})
    await tool.execute({ action: 'record', surface: 'b.example.com', risk_area: 'xss', outcome: 'clean' }, {})
    // A concurrent agent appends C-003 directly — the exact race the old
    // full-file rewrite lost (read snapshot → rewrite swallowed the row).
    appendFileSync(
      join(config.workspaceDir, 'coverage', 'ledger.jsonl'),
      JSON.stringify({ id: 'C-003', surface: 'c.example.com', risk_area: 'xss', outcome: 'clean', recorded_at: 't' }) + '\n',
      'utf8',
    )
    const res = await tool.execute({ action: 'update', id: 'C-001', outcome: 'ruled_out' }, {})
    expect(res).toMatch(/^Moved C-001/)
    const entries = readLedger(config)
    expect(entries.map((e) => e.id).sort()).toEqual(['C-001', 'C-002', 'C-003'])
    const c1 = entries.find((e) => e.id === 'C-001')
    expect(c1?.outcome).toBe('ruled_out')
    expect(c1?.updated_at).toBeTruthy()
    // The raw file keeps the full version history (audit trail).
    const raw = readFileSync(join(config.workspaceDir, 'coverage', 'ledger.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(4)
  })
})

describe('findings store', () => {
  it('returns an empty list when no findings exist yet', () => {
    expect(listFindings(scratchConfig())).toEqual([])
  })

  it('reads back a filed finding with its fields', () => {
    const config = scratchConfig()
    mkdirSync(join(config.workspaceDir, 'findings'), { recursive: true })
    writeFileSync(
      join(config.workspaceDir, 'findings', 'F-001.json'),
      JSON.stringify({
        id: 'F-001', title: 'SQLi', vulnerability_type: 'sqli', severity: 'high',
        target: 'https://example.com/', description: 'd', evidence: 'e', created_at: 't0',
      }),
      'utf8',
    )
    const all = listFindings(config)
    expect(all).toHaveLength(1)
    expect(all[0]?.target).toBe('https://example.com/')
  })
})

describe('dedupe-check', () => {
  const registered = [
    {
      id: 'F-001', title: 'SQLi in login username', vulnerability_type: 'sqli',
      severity: 'high', target: 'https://example.com/login', description: 'username unsanitized',
      evidence: 'SELECT 1 → 1', created_at: 't0',
    },
    {
      id: 'F-002', title: 'lodash CVE-2021-23337 code exec', vulnerability_type: 'dependency_cve',
      severity: 'high', target: 'package.json lodash CVE-2021-23337 npm', description: 'lodash command injection via template',
      evidence: 'npm audit', created_at: 't1',
    },
    {
      id: 'F-003', title: 'SQLi in search q param', vulnerability_type: 'sqli',
      severity: 'high', target: 'https://example.com/search?q=x', description: 'q unsanitized',
      evidence: 'SELECT 1 → 1', created_at: 't2',
    },
  ]

  it('flags same type + endpoint + same target (both bare) as duplicate', () => {
    const v = checkDuplicate(
      { title: 'login SQL injection', vulnerability_type: 'sqli', target: 'https://example.com/login' },
      registered,
    )
    expect(v.duplicate).toBe(true)
    expect(v.existing_id).toBe('F-001')
  })

  it('flags the same param on the same endpoint as duplicate (re-file with a different value)', () => {
    const v = checkDuplicate(
      { title: 'search SQL injection again', vulnerability_type: 'sqli', target: 'https://example.com/search?q=other' },
      registered,
    )
    expect(v.duplicate).toBe(true)
    expect(v.existing_id).toBe('F-003')
  })

  it('P0 regression: clears a DIFFERENT param on the same endpoint (q vs sort)', () => {
    // The old word-overlap check matched URL structure words (scheme, host,
    // first segment) that every same-endpoint target shares — this pair was
    // ALWAYS flagged duplicate and the second real finding was silently
    // swallowed.
    const v = checkDuplicate(
      { title: 'SQL injection in sort parameter', vulnerability_type: 'sqli', target: 'https://example.com/search?sort=price' },
      registered,
    )
    expect(v.duplicate).toBe(false)
  })

  it('treats bare-vs-detailed targets as ambiguous (not duplicate)', () => {
    // Existing filed bare, candidate adds param detail — could be a re-file
    // with more detail OR a distinct param-specific finding. Fail toward
    // filing: the pipeline tolerates a double-file, not a silent swallow.
    const v = checkDuplicate(
      { title: 'login SQL injection', vulnerability_type: 'sqli', target: 'https://example.com/login?user=x' },
      registered,
    )
    expect(v.duplicate).toBe(false)
  })

  it('clears different endpoints with the same type', () => {
    const v = checkDuplicate(
      { title: 'search SQL injection', vulnerability_type: 'sqli', target: 'https://example.com/other?q=x' },
      registered,
    )
    expect(v.duplicate).toBe(false)
  })

  it('clears different types on the same endpoint', () => {
    const v = checkDuplicate(
      { title: 'login XSS', vulnerability_type: 'xss', target: 'https://example.com/login' },
      registered,
    )
    expect(v.duplicate).toBe(false)
  })

  it('flags same CVE + package as duplicate, honors excludeId', () => {
    const cand = { vulnerability_type: 'dependency_cve', package_name: 'lodash', cve: 'CVE-2021-23337', package_ecosystem: 'npm' }
    const dup = checkDuplicate(cand, registered)
    expect(dup.duplicate).toBe(true)
    expect(dup.existing_id).toBe('F-002')
    const self = checkDuplicate(cand, registered, 'F-002')
    expect(self.duplicate).toBe(false)
  })

  it('clears a different CVE on the same package', () => {
    const v = checkDuplicate(
      { vulnerability_type: 'dependency_cve', package_name: 'lodash', cve: 'CVE-2020-8203' },
      registered,
    )
    expect(v.duplicate).toBe(false)
  })

describe('finish sections', () => {
  const full = {
    executive_summary: 's', methodology: 'm', technical_analysis: 't', recommendations: 'r',
  }

  it('accepts four non-empty sections', () => {
    expect(missingFinishSections(full)).toEqual([])
  })

  it('names each missing or blank section', () => {
    expect(missingFinishSections({})).toEqual(
      ['executive_summary', 'methodology', 'technical_analysis', 'recommendations'],
    )
    expect(missingFinishSections({ ...full, methodology: '  ' })).toEqual(['methodology'])
  })
})

  it('treats a different manifest path as a separate finding', () => {
    const v = checkDuplicate(
      {
        vulnerability_type: 'dependency_cve', package_name: 'lodash', cve: 'CVE-2021-23337',
        manifest_path: 'frontend/package.json',
      },
      registered,
    )
    expect(v.duplicate).toBe(false)
    expect(v.reason).toMatch(/manifest/)
  })
})

describe('path guards', () => {
  it('accepts plain ids and filenames', () => {
    expect(safeId('F-001')).toBe(true)
    expect(safeId('baseline-index.html')).toBe(true)
    expect(safeId('default')).toBe(true)
  })

  it('rejects traversal, separators, absolute and dotfile ids', () => {
    expect(safeId('../evil')).toBe(false)
    expect(safeId('..\\evil')).toBe(false)
    expect(safeId('a/b')).toBe(false)
    expect(safeId('a\\b')).toBe(false)
    expect(safeId('/abs')).toBe(false)
    expect(safeId('.hidden')).toBe(false)
    expect(safeId('..')).toBe(false)
    expect(safeId('')).toBe(false)
    expect(safeId('x'.repeat(129))).toBe(false)
  })

  it('resolves inside-base paths and refuses escape', () => {
    const base = scratchConfig().workspaceDir
    expect(safeWorkspacePath(base, 'responses/a.html')).toContain('responses')
    expect(safeWorkspacePath(base, '../evil')).toBeNull()
    expect(safeWorkspacePath(base, 'sub/../../evil')).toBeNull()
    expect(safeWorkspacePath(base, '/abs/path')).toBeNull()
    expect(safeWorkspacePath(base, '')).toBeNull()
  })
})

describe('sast extra_args guard', () => {
  it('passes benign flags', () => {
    expect(checkExtraArgs([])).toBeNull()
    expect(checkExtraArgs(['-timeout', '10'])).toBeNull()
  })

  it('passes normal pentest operation: templates, output formats, proxy', () => {
    expect(checkExtraArgs(['-t', 'cves/', '-o', 'out.json', '-jsonl', '-proxy', 'http://localhost:8080'])).toBeNull()
    expect(checkExtraArgs(['-tid', 'CVE-2021-1', '-et', 'dns'])).toBeNull()
  })

  it('blocks retarget/rate-limit/config-update flags', () => {
    for (const flag of ['-u', '-target', '-l', '-rl', '-rate-limit', '-c', '-concurrency', '-config', '-update', '-uncover']) {
      expect(checkExtraArgs([flag])).toMatch(/REJECTED/)
    }
  })

  it('matches case-insensitively', () => {
    expect(checkExtraArgs(['-RL'])).toMatch(/REJECTED/)
  })

  it('normalizes =value and --long forms before matching', () => {
    for (const flag of ['-rl=100', '--rate-limit=50', '-u=http://evil.test', '--target=x', '--config=y', '-c=5']) {
      expect(checkExtraArgs([flag])).toMatch(/REJECTED/)
    }
  })

  it('blocks attached short value forms', () => {
    expect(checkExtraArgs(['-rl100'])).toMatch(/REJECTED/)
    expect(checkExtraArgs(['-c5'])).toMatch(/REJECTED/)
  })

  it('uses a separate table for semgrep: -l/--lang allowed, remote/upload blocked', () => {
    expect(checkExtraArgs(['-l', 'python'], SEMGREP_BLOCKED_EXTRA_FLAGS)).toBeNull()
    expect(checkExtraArgs(['--lang', 'python'], SEMGREP_BLOCKED_EXTRA_FLAGS)).toBeNull()
    expect(checkExtraArgs(['--include', '*.py'], SEMGREP_BLOCKED_EXTRA_FLAGS)).toBeNull()
    for (const flag of ['--remote', '--metrics', '--upload', '--gitlab', '--config=p/auto']) {
      expect(checkExtraArgs([flag], SEMGREP_BLOCKED_EXTRA_FLAGS)).toMatch(/REJECTED/)
    }
  })
})

describe('approval auto-allow', () => {
  it('matches operator patterns against the approval summary', () => {
    expect(matchesAutoAllow(['^strix_shell: run "echo'], 'strix_shell: run "echo hi" in img (network: on)')).toBe(true)
    expect(matchesAutoAllow(['^strix_shell: run "echo'], 'strix_shell: run "rm -rf /" in img (network: on)')).toBe(false)
  })

  it('is empty-deny by default and skips invalid regexes', () => {
    expect(matchesAutoAllow([], 'anything')).toBe(false)
    expect(matchesAutoAllow(['([invalid'], '([invalid')).toBe(false)
  })

  it('matches patterns against the FULL text, never the display truncation', () => {
    // A prefix pattern must not grant when the payload hides past the cut.
    const evil = `strix_shell: run "echo hi${' '.repeat(900)}; rm -rf /" in img`
    const { display, match } = splitApprovalSummary(evil, 400)
    expect(match).toBe(evil)
    expect(display.length).toBeLessThan(evil.length)
    expect(display).toMatch(/sha256:[0-9a-f]{12}/)
    expect(matchesAutoAllow(['^strix_shell: run "echo'], match)).toBe(true)
    expect(matchesAutoAllow(['^strix_shell: run "echo'], display)).toBe(true)
    // ...but a pattern anchored to the hidden suffix only matches full text.
    expect(matchesAutoAllow(['rm -rf /'], match)).toBe(true)
    expect(matchesAutoAllow(['rm -rf /'], display)).toBe(false)
  })

  it('passes short summaries through unsplit', () => {
    const { display, match } = splitApprovalSummary('strix_shell: run "echo hi"')
    expect(display).toBe('strix_shell: run "echo hi"')
    expect(match).toBe('strix_shell: run "echo hi"')
  })
})

describe('depcheck pure helpers', () => {
  it('extracts CVE alias, CVSS_V3 severity, and fixed versions', () => {
    const parsed = parseOsvVuln({
      aliases: ['GHSA-29mw-wpgm-hmr9', 'CVE-2021-23337'],
      summary: 'ReDoS in lodash',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
      affected: [{ ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
    })
    expect(parsed.cve).toBe('CVE-2021-23337')
    expect(parsed.severity).toContain('CVSS:3.1')
    expect(parsed.fixed_in).toEqual(['4.17.21'])
  })

  it('tolerates minimal records without severity or ranges', () => {
    const parsed = parseOsvVuln({ id: 'GHSA-x' })
    expect(parsed.cve).toBeNull()
    expect(parsed.severity).toBeNull()
    expect(parsed.fixed_in).toEqual([])
  })

  it('sorts KEV hits first, then EPSS desc, then vuln id', () => {
    const mk = (vuln_id: string, kev_hit: boolean, epss: number | null) => ({
      package: 'p', ecosystem: 'npm', version: '1', vuln_id, cve: null,
      summary: 's', severity: null, kev_hit, epss, fixed_in: [],
    })
    const sorted = sortDepFindings([
      mk('GHSA-b', false, 0.9),
      mk('GHSA-a', false, null),
      mk('GHSA-c', true, 0.1),
    ])
    expect(sorted.map((r) => r.vuln_id)).toEqual(['GHSA-c', 'GHSA-b', 'GHSA-a'])
  })

  it('formats one finding line with tags', () => {
    const line = formatDepFinding({
      package: 'lodash', ecosystem: 'npm', version: '4.17.20', vuln_id: 'GHSA-29mw-wpgm-hmr9',
      cve: 'CVE-2021-23337', summary: 'ReDoS', severity: null, kev_hit: true, epss: 0.5, fixed_in: ['4.17.21'],
    })
    expect(line).toContain('lodash@4.17.20')
    expect(line).toContain('KEV-HIT')
    expect(line).toContain('fixed=4.17.21')
  })

  it('runPool runs every item once and settles rejections as not-ok', async () => {
    const ran: number[] = []
    const outcomes = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      ran.push(n)
      if (n === 4) throw new Error('boom')
    })
    expect(ran.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(outcomes.filter((o) => o.ok)).toHaveLength(6)
    expect(outcomes.find((o) => o.item === 4)?.ok).toBe(false)
  })

  it('runPool caps concurrency at the lane count', async () => {
    let inFlight = 0
    let peak = 0
    await runPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('runPool handles an empty item list without starting lanes', async () => {
    const outcomes = await runPool([] as number[], 4, async () => { throw new Error('must not run') })
    expect(outcomes).toEqual([])
  })
})

describe('methodology autonomy discipline', () => {
  it('keeps the Strix-derived no-question rule with dsh turn semantics', () => {
    const text = methodologySection(scratchConfig())
    expect(text).toContain('AUTONOMY')
    expect(text).toContain('YOUR TURN ENDS THE MOMENT YOU REPLY WITH PLAIN')
    expect(text).toContain('NEVER end a turn with a question')
    expect(text).toContain('EVERY')
    expect(text).toContain('tool call while work remains')
    expect(text).toContain('(1) use issued test')
    expect(text).toContain('strix_authorization')
    expect(text).toContain('not via')
  })

  it('carries the approval-or-act tree and turn-close template', () => {
    const text = methodologySection(scratchConfig())
    expect(text).toContain('APPROVAL-OR-ACT DECISION TREE')
    expect(text).toContain('pre_approved_post_paths')
    expect(text).toContain('USE IT WITHOUT ASKING')
    expect(text).toContain('TURN-CLOSE TEMPLATE')
    expect(text).toContain('never')
    expect(text).toContain('bare text')
  })

  it('carries triage, blocked-second-path, and engagement-isolation discipline', () => {
    const text = methodologySection(scratchConfig())
    expect(text).toContain('TRIAGE')
    expect(text).toContain('ruled_out')
    expect(text).toContain('BLOCKED SECOND PATH')
    expect(text).toContain('ENGAGEMENT ISOLATION')
    expect(text).toContain('one target set, one workspace')
  })
})

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 100)).toBe('hello')
  })

  it('marks long text with the shown/total counts', () => {
    const out = truncate('x'.repeat(50), 10)
    expect(out).toContain('showing 10 of 50')
    expect(out.length).toBeLessThan(50 + 120)
  })
})

describe('authorization attestation', () => {
  it('renders the passive-only reminder when nothing is recorded', () => {
    const text = renderAuthorizationSection(scratchConfig())
    expect(text).toContain('No authorization attestation recorded')
    expect(text).toContain('passive reconnaissance')
  })

  it('round-trips set/get and renders the short factual version', () => {
    const config = scratchConfig()
    expect(readAuthorization(config)).toBeNull()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        scope_ref: 'TEST-1',
        recorded_at: 't0',
      }),
      'utf8',
    )
    const auth = readAuthorization(config)
    expect(auth?.targets).toEqual(['https://example.com'])
    const text = renderAuthorizationSection(config)
    expect(text).toContain('Targets: https://example.com')
    expect(text).toContain('Granted by: test harness')
    expect(text).toContain('Scope reference: TEST-1')
  })

  it('returns null on a corrupt attestation file instead of throwing', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), '{not json', 'utf8')
    expect(readAuthorization(config)).toBeNull()
    // Corrupt file still renders the safe fallback, never attacker text.
    expect(renderAuthorizationSection(config)).toContain('No authorization attestation recorded')
  })

  it('adds the refusal-avoidance passage only while authorized', () => {
    const config = scratchConfig()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        recorded_at: 't0',
      }),
      'utf8',
    )
    const text = renderAuthorizationSection(config)
    expect(text).toContain('Targets: https://example.com')
    expect(text).toContain('do not')
    expect(text).toContain('self-classify it as unauthorized')
    expect(text).toContain('continue with the most useful in-scope validation step')
    expect(text).toContain('Stay inside these targets')
  })

  it('replaces the passage with an expiry warning once valid_until passes', () => {
    const config = scratchConfig()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        valid_until: '2020-01-01T00:00:00.000Z',
        recorded_at: 't0',
      }),
      'utf8',
    )
    const text = renderAuthorizationSection(config)
    expect(text).toContain('EXPIRED')
    expect(text).toContain('passive reconnaissance')
    expect(text).not.toContain('most useful in-scope validation step')
  })

  it('matches pre-approved POST paths exactly, honoring expiry', () => {
    const auth = {
      targets: ['https://example.com'],
      granted_by: 'test',
      recorded_at: 't0',
      pre_approved_post_paths: [
        { path: '/oas/forgetPassword', body: 'username-existence-probe' },
        { path: '/api/echo', body: '*' },
      ],
    }
    expect(matchesPreApprovedPost(auth, '/oas/forgetPassword', 'username-existence-probe')).toBe(true)
    expect(matchesPreApprovedPost(auth, '/api/echo', 'anything-at-all')).toBe(true)
    expect(matchesPreApprovedPost(auth, '/oas/forgetPassword', 'different-body')).toBe(false)
    expect(matchesPreApprovedPost(auth, '/other/path', 'username-existence-probe')).toBe(false)
    expect(matchesPreApprovedPost(null, '/oas/forgetPassword', 'username-existence-probe')).toBe(false)
    expect(matchesPreApprovedPost({ targets: [], granted_by: 'x', recorded_at: 't0' }, '/a', 'b')).toBe(false)
    const expired = { ...auth, valid_until: '2020-01-01T00:00:00.000Z' }
    expect(matchesPreApprovedPost(expired, '/oas/forgetPassword', 'username-existence-probe')).toBe(false)
  })

  it('requires an EXACT body match — substrings never clear', () => {
    const auth = {
      targets: ['https://example.com'],
      granted_by: 'test',
      recorded_at: 't0',
      pre_approved_post_paths: [{ path: '/p', body: 'ok' }],
    }
    expect(matchesPreApprovedPost(auth, '/p', 'ok')).toBe(true)
    expect(matchesPreApprovedPost(auth, '/p', 'ok + injected payload')).toBe(false)
    expect(matchesPreApprovedPost(auth, '/p', '')).toBe(false)
  })

  it('checks target coverage against a live attestation', () => {    const auth = { targets: ['https://example.com'], granted_by: 'test', recorded_at: 't0' }
    expect(targetCoveredByAuth(auth, 'https://example.com/login')).toBe(true)
    expect(targetCoveredByAuth(auth, 'https://sub.example.com/x')).toBe(true)
    expect(targetCoveredByAuth(auth, 'example.com')).toBe(true)
    expect(targetCoveredByAuth(auth, 'https://other.test/')).toBe(false)
    expect(targetCoveredByAuth(auth, '')).toBe(false)
    expect(targetCoveredByAuth(null, 'https://example.com/')).toBe(false)
    expect(targetCoveredByAuth({ ...auth, valid_until: '2020-01-01T00:00:00.000Z' }, 'https://example.com/')).toBe(false)
  })

  it('host-boundary coverage: example.com never covers notexample.com (regression)', () => {
    const auth = { targets: ['example.com'], granted_by: 'test', recorded_at: 't0' }
    // The old bidirectional substring matched these — recon/sast then sent
    // active probing traffic at a different organization's domain.
    expect(targetCoveredByAuth(auth, 'notexample.com')).toBe(false)
    expect(targetCoveredByAuth(auth, 'https://notexample.com/')).toBe(false)
    expect(targetCoveredByAuth(auth, 'https://sub.notexample.com/x')).toBe(false)
    expect(targetCoveredByAuth({ targets: ['sub.example.com'], granted_by: 't', recorded_at: 't0' }, 'notsub.example.com')).toBe(false)
    // Subdomains in both directions still covered (unchanged semantics).
    expect(targetCoveredByAuth(auth, 'https://deep.sub.example.com/x')).toBe(true)
    expect(targetCoveredByAuth({ targets: ['sub.example.com'], granted_by: 't', recorded_at: 't0' }, 'https://example.com/')).toBe(true)
  })

  it('port semantics: portless scope covers any port; port-pinned scope covers only that port', () => {
    const any = { targets: ['example.com'], granted_by: 't', recorded_at: 't0' }
    expect(targetCoveredByAuth(any, 'https://example.com:8080/x')).toBe(true)
    const pinned = { targets: ['example.com:8080'], granted_by: 't', recorded_at: 't0' }
    expect(targetCoveredByAuth(pinned, 'https://example.com:8080/x')).toBe(true)
    expect(targetCoveredByAuth(pinned, 'https://example.com/')).toBe(false)
    expect(targetCoveredByAuth(pinned, 'https://example.com:9090/x')).toBe(false)
  })

  it('set keeps prior lists when omitted and reports dropped malformed entries', async () => {
    const config = scratchConfig()
    const captured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerAuthorization({ tools: { register: (t) => { captured[t.name] = t } } } as never, config)
    const tool = captured.strix_authorization!
    await tool.execute({
      action: 'set', targets: ['https://example.com'], granted_by: 'op',
      pre_approved_post_paths: [{ path: '/a', body: 'b' }],
    }, {})
    // Omitted lists are inherited; malformed entries are dropped AND counted.
    const out = await tool.execute({
      action: 'set', targets: ['https://example.com'], granted_by: 'op',
      pre_approved_post_paths: [{ path: '/c' }, { path: '/d', body: 'e' }],
      test_accounts: [{ label: 'x' }, { label: 's1', username: 'u1' }],
    }, {}) as string
    expect(out).toContain('2 malformed')
    const stored = readAuthorization(config)!
    expect(stored.pre_approved_post_paths).toEqual([{ path: '/d', body: 'e' }])
    expect(stored.test_accounts).toEqual([{ label: 's1', username: 'u1' }])
    // Omitted lists are inherited from the previous attestation.
    await tool.execute({ action: 'set', targets: ['https://example.com'], granted_by: 'op' }, {})
    const inherited = readAuthorization(config)!
    expect(inherited.pre_approved_post_paths).toEqual([{ path: '/d', body: 'e' }])
    expect(inherited.test_accounts).toEqual([{ label: 's1', username: 'u1' }])
  })

  it('renders pre-approved POST paths into the prompt section', () => {
    const config = scratchConfig()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        pre_approved_post_paths: [{ path: '/oas/forgetPassword', body: 'username-existence-probe' }],
        recorded_at: 't0',
      }),
      'utf8',
    )
    expect(renderAuthorizationSection(config)).toContain('Pre-approved POST paths (1)')
  })

  it('treats missing or unparsable expiry as non-expiring', () => {
    expect(isAuthorizationExpired({ targets: [], granted_by: 'x', recorded_at: 't0' })).toBe(false)
    expect(isAuthorizationExpired({ targets: [], granted_by: 'x', recorded_at: 't0', valid_until: 'not-a-date' })).toBe(false)
    expect(
      isAuthorizationExpired(
        { targets: [], granted_by: 'x', recorded_at: 't0', valid_until: '2030-01-01T00:00:00.000Z' },
        Date.parse('2026-01-01T00:00:00.000Z'),
      ),
    ).toBe(false)
    expect(
      isAuthorizationExpired(
        { targets: [], granted_by: 'x', recorded_at: 't0', valid_until: '2020-01-01T00:00:00.000Z' },
        Date.parse('2026-01-01T00:00:00.000Z'),
      ),
    ).toBe(true)
  })

  it('masks test-account passwords in prompt-facing output', () => {
    const masked = maskTestAccount({ label: 'student-1', username: 's001', password: 's3cret!', login_url: 'https://uis.example.com/login' })
    expect(masked).toContain('student-1')
    expect(masked).toContain('s001')
    expect(masked).toContain('https://uis.example.com/login')
    expect(masked).toContain('***')
    expect(masked).not.toContain('s3cret!')
    const noPw = maskTestAccount({ label: 'auditor', username: 'audit01' })
    expect(noPw).toContain('not stored')
  })

  it('renders masked test accounts into the prompt section, never passwords', () => {
    const config = scratchConfig()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        test_accounts: [{ label: 'student-1', username: 's001', password: 's3cret!' }],
        recorded_at: 't0',
      }),
      'utf8',
    )
    const text = renderAuthorizationSection(config)
    expect(text).toContain('Test accounts (1')
    expect(text).toContain('s001')
    expect(text).not.toContain('s3cret!')
  })
})

describe('http POST per-path counter', () => {
  it('starts empty and increments per path', () => {
    const config = scratchConfig()
    expect(readPostCounts(config)).toEqual({})
    expect(claimPostCount(config, '/oas/forgetPassword', 5).count).toBe(1)
    expect(claimPostCount(config, '/oas/forgetPassword', 5).count).toBe(2)
    expect(claimPostCount(config, '/other', 5).count).toBe(1)
    expect(readPostCounts(config)).toEqual({ '/oas/forgetPassword': 2, '/other': 1 })
    // Persisted as an append-only JSONL ledger: one {ts, path} line per send.
    const lines = readFileSync(postCountsPath(config), 'utf8').split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { ts?: string; path?: string }
      expect(typeof parsed.ts).toBe('string')
      expect(typeof parsed.path).toBe('string')
    }
  })

  it('returns empty on missing or corrupt files instead of throwing', () => {
    expect(readPostCounts(scratchConfig())).toEqual({})
    const config = scratchConfig()
    writeFileSync(postCountsPath(config), '{not json\n{"path":"/x"}\n', 'utf8')
    // The torn line is skipped, the rest of the ledger still counts — a
    // corrupt ledger must not silently disable the spray cap.
    expect(readPostCounts(config)).toEqual({ '/x': 1 })
  })

  it('merges the pre-0.12 JSON ledger without resetting the budget', () => {
    const config = scratchConfig()
    writeFileSync(join(config.workspaceDir, 'http-post-counts.json'), JSON.stringify({ '/oas/forgetPassword': 5 }))
    // At the cap already: an upgrade must not hand the model a fresh budget.
    expect(readPostCounts(config)).toEqual({ '/oas/forgetPassword': 5 })
    expect(claimPostCount(config, '/oas/forgetPassword', 0).count).toBe(6)
  })

  it('does not lose counts when two writers append concurrently', () => {
    const config = scratchConfig()
    // The old read→mutate→rewrite implementation had each writer read the
    // same total and both write old+1. Appending is order-independent.
    for (let i = 0; i < 7; i++) claimPostCount(config, '/api/reset', 0)
    expect(readPostCounts(config)['/api/reset']).toBe(7)
  })

  it('enforces a HARD cap: at most cap valid claims exist per path (claim-then-check regression)', () => {
    const config = scratchConfig()
    // cap=3: the first three claims are granted, the fourth is refused.
    // The previous check-then-bump order let concurrent racers both read
    // `seen < cap` and both proceed — the cap was soft. Claim-then-check
    // voids any claim that lands beyond the cap.
    expect(claimPostCount(config, '/login', 3)).toEqual({ granted: true, count: 1 })
    expect(claimPostCount(config, '/login', 3)).toEqual({ granted: true, count: 2 })
    expect(claimPostCount(config, '/login', 3)).toEqual({ granted: true, count: 3 })
    const over = claimPostCount(config, '/login', 3)
    expect(over.granted).toBe(false)
    // A refused claim is VOIDED in the ledger: the valid total stays at cap,
    // not cap + refused-attempts.
    expect(readPostCounts(config)['/login']).toBe(3)
    // cap=0 means unlimited — claims always granted, never voided.
    expect(claimPostCount(config, '/login', 0).granted).toBe(true)
    expect(readPostCounts(config)['/login']).toBe(4)
  })

  it('void lines cancel exactly one claim and are skipped by the tally', () => {
    const config = scratchConfig()
    claimPostCount(config, '/x', 5)
    claimPostCount(config, '/x', 5)
    // A void line (as written by a refused over-cap claim) subtracts one.
    appendFileSync(postCountsPath(config), JSON.stringify({ ts: 't', path: '/x', void: true }) + '\n', 'utf8')
    // readPostCounts also folds the LEGACY json file — absent here, so the
    // tally comes from the JSONL ledger alone: 2 claims − 1 void = 1.
    expect(readPostCounts(config)['/x']).toBe(1)
    // And the next claim sees the voided total (2 − 1 + 1 = 2).
    expect(claimPostCount(config, '/x', 5).count).toBe(2)
  })

  it('exposes the configured per-path cap default', () => {
    expect(scratchConfig().httpPostCapPerPath).toBe(5)
  })
})

describe('report authorization summary', () => {
  it('states none-recorded when no attestation exists', () => {
    expect(authorizationSummary(scratchConfig())).toEqual([
      'Authorization: none recorded for this engagement.',
    ])
  })

  it('summarizes scope facts with masked test accounts', () => {
    const config = scratchConfig()
    writeFileSync(
      authorizationPath(config),
      JSON.stringify({
        targets: ['https://example.com'],
        granted_by: 'test harness',
        scope_ref: 'SRC-1',
        pre_approved_post_paths: [{ path: '/a', body: 'x' }],
        test_accounts: [{ label: 's1', username: 'u1', password: 'pw-secret' }],
        recorded_at: 't0',
      }),
      'utf8',
    )
    const lines = authorizationSummary(config)
    expect(lines.join('\n')).toContain('Targets: https://example.com')
    expect(lines.join('\n')).toContain('SRC-1')
    expect(lines.join('\n')).toContain('Pre-approved POST paths: 1 (/a)')
    expect(lines.join('\n')).toContain('u1')
    expect(lines.join('\n')).not.toContain('pw-secret')
  })
})

describe('budget ledger', () => {  it('prices usage with the configured per-1K rates', () => {
    const config = scratchConfig()
    // 1000 in + 1000 out at 0.0001/0.0002 → 0.0003.
    expect(priceUsage(config, 1000, 1000)).toBeCloseTo(0.0003, 8)
    expect(priceUsage(config, 0, 0)).toBe(0)
  })

  it('starts from a zero ledger and accumulates records', () => {
    const config = scratchConfig()
    const zero = readBudget(config)
    expect(zero.spentUsd).toBe(0)
    expect(zero.records).toBe(0)
    writeFileSync(
      budgetPath(config),
      JSON.stringify({ inputTokens: 1000, outputTokens: 1000, spentUsd: 0.0003, records: 1, started_at: 't0', updated_at: 't0' }),
      'utf8',
    )
    const ledger = readBudget(config)
    expect(ledger.inputTokens).toBe(1000)
    expect(ledger.spentUsd).toBeCloseTo(0.0003, 8)
  })

  it('returns a zero ledger on a corrupt file instead of throwing', () => {
    const config = scratchConfig()
    writeFileSync(budgetPath(config), '{not json', 'utf8')
    expect(readBudget(config).spentUsd).toBe(0)
  })

  it('is disabled when the cap is zero', () => {
    expect(checkBudget(scratchConfig(), 'strix_recon')).toEqual({ over: false })
  })

  it('warns but allows when over budget in warn mode', () => {
    const config = { ...scratchConfig(), budgetLimitUsd: 0.0001, budgetAction: 'warn' as const }
    writeFileSync(
      budgetPath(config),
      JSON.stringify({ inputTokens: 100000, outputTokens: 0, spentUsd: 0.027, records: 1, started_at: 't0', updated_at: 't0' }),
      'utf8',
    )
    const gate = checkBudget(config, 'strix_sast')
    expect(gate.over).toBe(true)
    if (gate.over) expect(gate.message).toMatch(/BUDGET WARNING/)
  })

  it('refuses when over budget in block mode', () => {
    const config = { ...scratchConfig(), budgetLimitUsd: 0.0001, budgetAction: 'block' as const }
    writeFileSync(
      budgetPath(config),
      JSON.stringify({ inputTokens: 100000, outputTokens: 0, spentUsd: 0.027, records: 1, started_at: 't0', updated_at: 't0' }),
      'utf8',
    )
    const gate = checkBudget(config, 'strix_recon')
    expect(gate.over).toBe(true)
    if (gate.over) expect(gate.message).toMatch(/BUDGET EXCEEDED/)
  })

  it('formats USD to four decimals', () => {
    expect(formatUsd(0.00067)).toBe('$0.0007')
    expect(formatUsd(1.5)).toBe('$1.5000')
  })
})

describe('background shell producer', () => {
  const baseSpec = {
    command: 'echo hi',
    image: 'python:3.12-slim',
    network: true,
    timeoutMs: 60000,
    cidFile: '/tmp/strix-test.cid',
  }

  it('builds docker run argv with workspace mount and workdir', () => {
    const args = buildBackgroundDockerArgs('/ws', baseSpec)
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-v'])
    expect(args).toContain('/ws:/workspace')
    expect(args).toContain('/workspace')
    expect(args.slice(-3)).toEqual(['bash', '-c', 'echo hi'])
    expect(args).not.toContain('--network')
    // The daemon-side container is bound via --cidfile so timeout/cancel
    // can `rm -f` it (killing the CLI never stops the container).
    expect(args).toContain('--cidfile')
    expect(args[args.indexOf('--cidfile') + 1]).toBe('/tmp/strix-test.cid')
  })

  it('adds --network none and custom workdir when requested', () => {
    const args = buildBackgroundDockerArgs('/ws', { ...baseSpec, network: false, workdir: '/workspace/pybox/x' })
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('/workspace/pybox/x')
  })

  it('truncates long commands to an 80-char label', () => {
    expect(jobLabel('echo hi')).toBe('echo hi')
    const long = 'x'.repeat(100)
    const label = jobLabel(long)
    expect(label.length).toBe(81)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('session mirror', () => {
  const fakeExec = (agent?: unknown) => ({ agent } as never)

  // Since 0.12.5 mirrorEvent is a deliberate no-op: appending custom event
  // types (strix/coverage, strix/note) without the ignorable marker makes
  // sessions unloadable under the dsh format-migration chain (the desktop
  // "history failed to load: gateway/internal" incident). These tests pin
  // the no-op contract: whatever the runtime shape, nothing is ever written.

  it('never appends, even with a live session available', () => {
    const calls: Array<{ type: string; data: unknown }> = []
    const exec = fakeExec({
      id: 'x',
      session: {
        append: (type: string, data: unknown) => {
          calls.push({ type, data })
        },
      },
    })
    expect(() => mirrorEvent(exec, 'strix/coverage', { action: 'record' })).not.toThrow()
    expect(() => mirrorEvent(exec, 'strix/note', { action: 'create', note: { id: 'N-001' } })).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('does nothing when there is no agent', () => {
    expect(() => mirrorEvent(fakeExec(undefined), 'strix/coverage', { action: 'record' })).not.toThrow()
  })

  it('does nothing when the agent has no session', () => {
    expect(() => mirrorEvent(fakeExec({ id: 'x' }), 'strix/note', { action: 'create' })).not.toThrow()
  })

  it('swallows append failures instead of breaking the tool call', () => {
    const exec = fakeExec({
      id: 'x',
      session: {
        append: () => {
          throw new Error('outside an open turn')
        },
      },
    })
    expect(() => mirrorEvent(exec, 'strix/coverage', { action: 'record' })).not.toThrow()
  })
})

describe('proxy flow queries', () => {
  const sample = [
    { id: 'F-1', ts: 't', method: 'GET', url: 'http://example.com/', status: 200, req_bytes: 100, rsp_bytes: 500 },
    { id: 'F-2', ts: 't', method: 'POST', url: 'http://example.com/login', status: 302, req_bytes: 200, rsp_bytes: 50 },
    { id: 'F-3', ts: 't', method: 'GET', url: 'http://other.test/x', status: 404, req_bytes: 90, rsp_bytes: 30 },
  ]

  it('reads JSONL flows and skips corrupt lines', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'proxy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'flows.jsonl'),
      [...sample.map((s) => JSON.stringify(s)), '{broken', JSON.stringify({ no_id: 1 })].join('\n'),
      'utf8',
    )
    const flows = readFlows(config)
    expect(flows).toHaveLength(3)
    expect(flows[0]?.id).toBe('F-1')
  })

  it('returns empty when no capture exists', () => {
    expect(readFlows(scratchConfig())).toEqual([])
  })

  it('filters over method/url/status case-insensitively', () => {
    expect(filterFlows(sample, 'login')).toHaveLength(1)
    expect(filterFlows(sample, 'GET')).toHaveLength(2)
    expect(filterFlows(sample, '404')).toHaveLength(1)
    expect(filterFlows(sample, 'nope')).toHaveLength(0)
  })

  it('formats one flow line with sizes', () => {
    expect(formatFlow(sample[0]!)).toBe('F-1 GET 200 http://example.com/ (req 100B / rsp 500B)')
  })

  it('accepts only a docker CLI pid for the stop path (tasklist CSV)', () => {
    const csv = '"docker.exe","1234","Console","1","10,000 K"\r\n"node.exe","5678","Console","1","50,000 K"'
    expect(tasklistRowIsDockerCli(csv, 1234)).toBe(true)
    expect(tasklistRowIsDockerCli(csv, 5678)).toBe(false)
    expect(tasklistRowIsDockerCli(csv, 9999)).toBe(false)
    expect(tasklistRowIsDockerCli('"DOCKER.EXE","1234","Console","1","10,000 K"', 1234)).toBe(true)
  })

  it('accepts only a docker CLI cmdline (/proc)', () => {
    expect(procCmdlineIsDockerCli('docker\0run\0--rm\0')).toBe(true)
    expect(procCmdlineIsDockerCli('/usr/bin/docker\0run\0')).toBe(true)
    expect(procCmdlineIsDockerCli('node\0dsh\0')).toBe(false)
    expect(procCmdlineIsDockerCli('')).toBe(false)
  })

  it('matches docker ps publish rows on both 0.0.0.0 and [::] spellings', () => {
    const image = 'mitmproxy/mitmproxy'
    expect(dockerPsLineMatchesPort('abc123 0.0.0.0:8080->8080/tcp mitmproxy/mitmproxy:latest', 8080, image)).toBe(true)
    expect(dockerPsLineMatchesPort('abc123 [::]:8080->8080/tcp mitmproxy/mitmproxy:latest', 8080, image)).toBe(true)
    expect(dockerPsLineMatchesPort('abc123 0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp mitmproxy/mitmproxy', 8080, image)).toBe(true)
    // Wrong port, wrong image, or a substring of another port must not match.
    expect(dockerPsLineMatchesPort('abc123 0.0.0.0:8081->8080/tcp mitmproxy/mitmproxy:latest', 8080, image)).toBe(false)
    expect(dockerPsLineMatchesPort('abc123 0.0.0.0:8080->8080/tcp nginx:latest', 8080, image)).toBe(false)
    expect(dockerPsLineMatchesPort('abc123 0.0.0.0:18080->8080/tcp mitmproxy/mitmproxy:latest', 8080, image)).toBe(false)
    expect(dockerPsLineMatchesPort('', 8080, image)).toBe(false)
  })

  it('pid ownership check fails closed on bad pids', async () => {
    await expect(pidOwnedByDockerCli(-1)).resolves.toBe(false)
    await expect(pidOwnedByDockerCli(0)).resolves.toBe(false)
    await expect(pidOwnedByDockerCli(Number.NaN)).resolves.toBe(false)
    // A pid that cannot exist on any host must never verify.
    await expect(pidOwnedByDockerCli(2_147_483_647)).resolves.toBe(false)
  })
})

describe('recon httpx argv', () => {
  it('passes the subdomain list explicitly via -l (no stdin channel exists)', () => {
    const argv = buildHttpxArgs('/ws/recon/example.com/subs.txt', '/ws/recon/example.com/live.txt')
    expect(argv).toContain('-l')
    expect(argv[argv.indexOf('-l') + 1]).toBe('/ws/recon/example.com/subs.txt')
    expect(argv).toContain('/ws/recon/example.com/live.txt')
  })

  it('accepts plain domains and rejects traversal/ports/whitespace', () => {
    expect(isSafeDomain('example.com')).toBe(true)
    expect(isSafeDomain('sub.example.com')).toBe(true)
    for (const bad of ['', '..', '../evil', 'a/b', 'a\\b', 'example.com:8080', 'exa mple.com', '-lead.com', 'trail-.com', '.lead.com', 'trail.com.', 'a'.repeat(254)]) {
      expect(isSafeDomain(bad)).toBe(false)
    }
  })
})

describe('semgrep target confinement', () => {
  it('allows the workspace and listed roots, rejects everything else', () => {
    const config = scratchConfig()
    const ws = config.workspaceDir
    expect(semgrepTargetAllowed(config, join(ws, 'src'))).toBe(true)
    expect(semgrepTargetAllowed(config, ws)).toBe(true)
    expect(semgrepTargetAllowed(config, join(ws, '..', 'other'))).toBe(false)
    expect(semgrepTargetAllowed(config, 'C:\\Windows')).toBe(false)
    // Listed roots open exactly one more tree; the workspace itself stays open.
    const sibling = join(ws, '..', 'sibling-root')
    expect(semgrepTargetAllowed(config, sibling)).toBe(false)
    const withRoot = { ...config, sastExtraMountRoots: [sibling] }
    expect(semgrepTargetAllowed(withRoot, join(sibling, 'proj'))).toBe(true)
    expect(semgrepTargetAllowed(withRoot, join(ws, 'elsewhere'))).toBe(true)
  })
})

describe('shared POST policy', () => {
  const authDoc = {
    targets: ['https://example.com'],
    granted_by: 'test',
    recorded_at: 't0',
    pre_approved_post_paths: [{ path: '/ok', body: 'ping' }],
  }

  it('clears pre-approved paths with a clearance note', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const verdict = evaluatePostPolicy(config, 'https://example.com/ok', 'ping')
    expect(verdict.proceed).toBe(true)
    if (verdict.proceed) expect(verdict.note).toContain('pre-approved POST /ok')
  })

  it('refuses over-cap paths and proceeds unattested without a note', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const capped = { ...config, httpPostCapPerPath: 1 }
    const first = evaluatePostPolicy(capped, 'https://example.com/login', 'a=1')
    expect(first.proceed).toBe(true)
    const second = evaluatePostPolicy(capped, 'https://example.com/login', 'a=2')
    expect(second.proceed).toBe(false)
    if (!second.proceed) expect(second.rejection).toMatch(/REJECTED: per-path state-changing cap/)
    const bare = evaluatePostPolicy(scratchConfig(), 'https://example.com/login', 'a=1')
    expect(bare).toEqual({ proceed: true, note: '' })
  })

  it('guards PUT/PATCH/DELETE like POST, sharing one per-path budget', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    // Pre-approval entries match exact path+body on any guarded verb.
    const cleared = evaluatePostPolicy(config, 'https://example.com/ok', 'ping', 'PUT')
    expect(cleared.proceed).toBe(true)
    if (cleared.proceed) expect(cleared.note).toContain('pre-approved PUT /ok')
    // ...while a PUT and a POST to the same path draw one shared budget.
    const capped = { ...config, httpPostCapPerPath: 1 }
    expect(evaluatePostPolicy(capped, 'https://example.com/item', 'x=1', 'PUT').proceed).toBe(true)
    const over = evaluatePostPolicy(capped, 'https://example.com/item', 'x=2', 'DELETE')
    expect(over.proceed).toBe(false)
    // Reads stay uncounted.
    expect(evaluatePostPolicy(capped, 'https://example.com/item', '', 'GET')).toEqual({ proceed: true, note: '' })
    expect(STATE_CHANGING_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE'])
  })

  it('derives the proxy image match key from config', () => {
    expect(proxyImageKey(scratchConfig())).toBe('mitmproxy/mitmproxy')
    expect(proxyImageKey({ ...scratchConfig(), proxyImage: 'custom/proxy:2.0' })).toBe('custom/proxy')
  })

  it('refuses writes to hosts outside the recorded attestation targets', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const verdict = evaluatePostPolicy(config, 'https://other.test/login', 'a=1')
    expect(verdict.proceed).toBe(false)
    if (!verdict.proceed) expect(verdict.rejection).toMatch(/outside the recorded authorization targets/)
    // Pre-approval never clears an out-of-scope host either.
    const smuggled = evaluatePostPolicy(config, 'https://other.test/ok', 'ping')
    expect(smuggled.proceed).toBe(false)
    // Reads to any host stay free (only writes are bounded).
    expect(evaluatePostPolicy(config, 'https://other.test/login', '', 'GET')).toEqual({ proceed: true, note: '' })
  })

  it('shares one budget across path spellings (variant-bypass regression)', () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const capped = { ...config, httpPostCapPerPath: 1 }
    expect(evaluatePostPolicy(capped, 'https://example.com/login', 'a=1').proceed).toBe(true)
    // Trailing slash, duplicate slash, and matrix params used to each open a
    // FRESH budget — rotating the spelling bypassed the cap entirely.
    expect(evaluatePostPolicy(capped, 'https://example.com/login/', 'a=1').proceed).toBe(false)
    expect(evaluatePostPolicy(capped, 'https://example.com/login//', 'a=1').proceed).toBe(false)
    expect(evaluatePostPolicy(capped, 'https://example.com/login;a=1', 'a=1').proceed).toBe(false)
    expect(evaluatePostPolicy(capped, 'https://example.com/LOGIN', 'a=1').proceed).toBe(false)
  })

  it('normalizes path keys: matrix params, duplicate slashes, trailing slash, case', () => {
    expect(normalizePathKey('/login')).toBe('/login')
    expect(normalizePathKey('/login/')).toBe('/login')
    expect(normalizePathKey('/login//')).toBe('/login')
    expect(normalizePathKey('/login;a=1')).toBe('/login')
    expect(normalizePathKey('/LOGIN')).toBe('/login')
    expect(normalizePathKey('/a//b/')).toBe('/a/b')
    expect(normalizePathKey('/')).toBe('/')
  })

  describe('proxy stop decision (ghost-container regression)', () => {
    it('stops the container even when the CLI kill succeeded', async () => {
      const calls: string[] = []
      const out = await stopSidecarWith({ pid: 1, port: 8080 }, {
        killCli: async () => { calls.push('kill'); return true },
        findContainer: async () => { calls.push('find'); return 'abc' },
        dockerStop: (id) => { calls.push(`stop:${id}`); return true },
      })
      // The old code short-circuited after a successful kill: the daemon-side
      // container kept listening and capturing while stop reported success.
      expect(out.stopped).toBe(true)
      expect(calls).toEqual(['kill', 'find', 'stop:abc'])
    })

    it('fails when the container exists but docker stop fails', async () => {
      const out = await stopSidecarWith({ pid: 1, port: 8080 }, {
        killCli: async () => true,
        findContainer: async () => 'abc',
        dockerStop: () => false,
      })
      expect(out.stopped).toBe(false)
    })

    it('succeeds with a cli kill alone when no container is found', async () => {
      const out = await stopSidecarWith({ pid: 1, port: 8080 }, {
        killCli: async () => true,
        findContainer: async () => null,
        dockerStop: () => { throw new Error('unreachable') },
      })
      expect(out.stopped).toBe(true)
    })

    it('prefers the recorded container id and skips the port scan', async () => {
      const out = await stopSidecarWith({ pid: 1, container: 'xyz', port: 8080 }, {
        killCli: async () => false,
        findContainer: async () => { throw new Error('should not be called') },
        dockerStop: (id) => id === 'xyz',
      })
      expect(out.stopped).toBe(true)
    })
  })

  it('strix_shell rejects dash-prefixed and whitespace images before anything runs', async () => {
    const config = scratchConfig()
    const regs: unknown[] = []
    registerShell({ tools: { register: (d: unknown) => regs.push(d) } } as never, config)
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    // A `-`-prefixed image lands in the image slot of `docker run` and is
    // parsed as a FLAG (--privileged); under a prefix auto-allow pattern the
    // command text matches while the smuggled flag never gets a human look.
    const r1 = await tool.execute({ command: 'echo hi', image: '--privileged evil' }, { name: 'strix_shell', callId: 't1' })
    expect(r1).toMatch(/REJECTED: bad image name/)
    const r2 = await tool.execute({ command: 'echo hi', image: 'kal i:latest' }, { name: 'strix_shell', callId: 't2' })
    expect(r2).toMatch(/REJECTED: bad image name/)
    // An empty image falls back to the configured default instead of ''.
    const r3 = await tool.execute({ command: 'echo hi', image: '' }, { name: 'strix_shell', callId: 't3' })
    expect(r3).not.toMatch(/REJECTED: bad image name/)
  })
})

describe('browser spray-guard (automated, no human)', () => {
  const fakeRoute = (
    method: string,
    url: string,
    body: string | null,
    calls: string[],
    opts?: { throwOnUrl?: boolean },
  ): GuardedRoute => ({
    request: () => ({
      method: () => method,
      url: () => {
        if (opts?.throwOnUrl) throw new Error('boom')
        return url
      },
      postData: () => body,
    }),
    continue: async () => { calls.push('continue') },
    abort: async () => { calls.push('abort') },
  })
  const authDoc = {
    targets: ['https://example.com'],
    granted_by: 'test',
    recorded_at: 't0',
    pre_approved_post_paths: [{ path: '/ok', body: 'ping' }],
  }

  it('lets reads through untouched (no ledger touch, no notes)', async () => {
    const config = scratchConfig()
    const notes: string[] = []
    const calls: string[] = []
    await createSprayGuardHandler(config, notes)(fakeRoute('GET', 'https://example.com/', null, calls))
    expect(calls).toEqual(['continue'])
    expect(notes).toHaveLength(0)
  })

  it('clears pre-approved writes with an audit note and counts the rest', async () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const notes: string[] = []
    const calls: string[] = []
    const handle = createSprayGuardHandler(config, notes)
    await handle(fakeRoute('POST', 'https://example.com/ok', 'ping', calls))
    await handle(fakeRoute('POST', 'https://example.com/form', 'a=1', calls))
    expect(calls).toEqual(['continue', 'continue'])
    expect(notes.join('\n')).toContain('pre-approved POST /ok')
    expect(notes.join('\n')).toContain('non-preapproved POST /form')
  })

  it('aborts over-cap writes before they leave', async () => {
    const config = scratchConfig()
    writeFileSync(authorizationPath(config), JSON.stringify(authDoc), 'utf8')
    const capped = { ...config, httpPostCapPerPath: 1 }
    const notes: string[] = []
    const calls: string[] = []
    const handle = createSprayGuardHandler(capped, notes)
    await handle(fakeRoute('POST', 'https://example.com/form', 'a=1', calls))
    await handle(fakeRoute('POST', 'https://example.com/form', 'a=2', calls))
    expect(calls).toEqual(['continue', 'abort'])
    expect(notes.join('\n')).toMatch(/REJECTED: per-path state-changing cap/)
  })

  it('blocks fail-closed when the guard itself errors', async () => {
    const config = scratchConfig()
    const notes: string[] = []
    const calls: string[] = []
    await createSprayGuardHandler(config, notes)(fakeRoute('POST', 'https://example.com/x', '', calls, { throwOnUrl: true }))
    expect(calls).toEqual(['abort'])
    expect(notes.join('\n')).toMatch(/fail-closed/)
  })
})

describe('sarif sidecar', () => {
  const finding = {
    id: 'F-001',
    title: 'SQLi in username',
    vulnerability_type: 'sqli',
    severity: 'high',
    target: 'http://example.com/index.php',
    description: 'd',
    evidence: 'SELECT 1 → 1',
    created_at: 't0',
  }
  const coverageEntries = [
    { id: 'C-001', surface: 'http://example.com/', risk_area: 'SQLi', outcome: 'finding', evidence_note: '', recorded_at: 't0' },
    { id: 'C-002', surface: 'http://example.com/about', risk_area: 'XSS', outcome: 'clean', evidence_note: '', recorded_at: 't1' },
    { id: 'C-003', surface: 'http://example.com/admin', risk_area: 'auth bypass', outcome: 'needs_follow_up', evidence_note: 'pending', recorded_at: 't2' },
  ]

  it('collapses five severities into three SARIF levels with scores', () => {
    expect(severityLevel('critical')).toBe('error')
    expect(severityLevel('high')).toBe('error')
    expect(severityLevel('medium')).toBe('warning')
    expect(severityLevel('low')).toBe('warning')
    expect(severityLevel('info')).toBe('note')
    expect(severityLevel('???')).toBe('note')
    expect(securitySeverity('critical')).toBe('9.0')
    expect(securitySeverity('high')).toBe('7.5')
    expect(securitySeverity('info')).toBe('0.0')
  })

  it('keys rules on vulnerability class and coverage area', () => {
    expect(findingRuleId(finding)).toBe('strix/sqli')
    expect(coverageRuleId(coverageEntries[1]!)).toBe('strix/coverage/xss')
  })

  it('builds a 2.1.0 document with fail findings and non-failing coverage', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = buildSarifDocument([finding], coverageEntries) as any
    expect(doc.version).toBe('2.1.0')
    expect(doc.runs).toHaveLength(1)
    const run = doc.runs[0]
    // 1 finding rule + 3 coverage rules.
    expect(run.tool.driver.rules).toHaveLength(4)
    // 1 fail + 3 coverage results.
    expect(run.results).toHaveLength(4)
    const fail = run.results[0]
    expect(fail.kind).toBe('fail')
    expect(fail.level).toBe('error')
    expect(fail.ruleId).toBe('strix/sqli')
    expect(fail.properties.strix.findingId).toBe('F-001')
    expect(fail.properties.strix.synthetic_location).toBe(true)
    expect(fail.logicalLocations[0].name).toBe('http://example.com/index.php')
    const kinds = run.results.slice(1).map((r: { kind: string }) => r.kind)
    expect(kinds).toEqual(['pass', 'pass', 'open'])
    expect(run.invocations[0].executionSuccessful).toBe(true)
  })

  it('emits fixes for code_locations', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = buildSarifDocument(
      [{ ...finding, code_locations: [{ file: 'app.py', fix_before: 'q = f(x)', fix_after: 'q = g(x)' }] }],
      [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any
    const fixes = doc.runs[0].results[0].fixes
    expect(fixes).toHaveLength(1)
    expect(fixes[0].artifactChanges[0].artifactLocation.uri).toBe('app.py')
  })

  it('writes the sidecar next to report.md and rejects bad filenames', () => {
    const config = scratchConfig()
    const written = writeSarifReport(config, [finding], [])
    expect(written.path).toBe(sarifPath(config))
    expect(written.path.endsWith(SARIF_FILENAME)).toBe(true)
    expect(written.rules).toBe(1)
    expect(written.results).toBe(1)
    const onDisk = JSON.parse(readFileSync(written.path, 'utf8'))
    expect(onDisk.version).toBe('2.1.0')
    expect(() => writeSarifReport(config, [], [], '../evil.sarif')).toThrow(/REJECTED/)
    expect(() => writeSarifReport(config, [], [], 'x.json')).toThrow(/REJECTED/)
  })
})

describe('id allocation (regression: archived/deleted entries must not collide)', () => {
  it('takes max+1, never count+1', () => {
    expect(nextIdAmong([], 'F-')).toBe('F-001')
    expect(nextIdAmong(['F-001', 'F-002'], 'F-')).toBe('F-003')
    // The regression: F-003 was archived out of the workspace. count+1 would
    // hand back F-003 and overwrite the live F-003; max+1 must give F-004.
    expect(nextIdAmong(['F-001', 'F-002', 'F-004', 'F-005'], 'F-')).toBe('F-006')
    expect(nextIdAmong(['F-009', 'F-010'], 'F-')).toBe('F-011')
  })

  it('ignores unrelated filenames in the directory', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'findings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'F-001.json'), '{}')
    writeFileSync(join(dir, 'report.md'), 'not an id')
    expect(nextSequentialId(dir, 'F-')).toBe('F-002')
  })

  it('does not collide after a middle finding is removed from disk', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'findings')
    mkdirSync(dir, { recursive: true })
    for (const id of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005']) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: `orig ${id}` }))
    }
    rmSync(join(dir, 'F-003.json'))
    const next = nextSequentialId(dir, 'F-')
    expect(next).toBe('F-006')
    expect(existsSync(join(dir, `${next}.json`))).toBe(false)
  })

  it('writeExclusive claims the slot and refuses to clobber', () => {
    const config = scratchConfig()
    const file = join(config.workspaceDir, 'claim.json')
    expect(writeExclusive(file, '{"id":"first"}')).toBe(true)
    expect(writeExclusive(file, '{"id":"second"}')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe('first')
  })

  it('strix_notes reuses no live id after a delete', async () => {    const config = scratchConfig()
    const captured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerNotes({ tools: { register: (t) => { captured[t.name] = t } } } as never, config)
    const notes = captured.strix_notes!
    for (const t of ['a', 'b', 'c', 'd']) {
      await notes.execute({ action: 'create', title: t, body: 'x' }, {})
    }
    await notes.execute({ action: 'delete', id: 'N-002' }, {})
    const out = await notes.execute({ action: 'create', title: 'e', body: 'x' }, {})
    expect(out).toContain('N-005')
    const list = await notes.execute({ action: 'list' }, {})
    expect(list).toContain('N-004')
    expect(list).not.toContain('N-002')
  })

  it('strix_notes rejects bad ids, missing notes, and blank fields', async () => {
    const config = scratchConfig()
    const captured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerNotes({ tools: { register: (t) => { captured[t.name] = t } } } as never, config)
    const notes = captured.strix_notes!
    await expect(notes.execute({ action: 'get', id: '../../evil' }, {})).resolves.toMatch(/REJECTED/)
    await expect(notes.execute({ action: 'get', id: 'N-404' }, {})).resolves.toContain('not found')
    await expect(notes.execute({ action: 'update', id: 'N-404', body: 'x' }, {})).resolves.toContain('not found')
    await expect(notes.execute({ action: 'delete', id: 'N-404' }, {})).resolves.toContain('not found')
    await expect(notes.execute({ action: 'create', title: '   ', body: 'x' }, {})).resolves.toMatch(/REJECTED/)
    await expect(notes.execute({ action: 'create', title: 't' }, {})).resolves.toMatch(/REJECTED/)
  })
})

describe('report rendering (regression: blank separator lines must survive)', () => {
  it('keeps paragraph breaks so --- is a rule and lists do not swallow text', () => {
    const config = scratchConfig()
    const captured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerReport({ tools: { register: (t) => { captured[t.name] = t } } } as never, config)
    const dir = join(config.workspaceDir, 'findings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'F-001.json'), JSON.stringify({
      id: 'F-001', title: 'ThinkPHP RCE', vulnerability_type: 'rce', severity: 'critical',
      target: 'http://127.0.0.1:18080/index.php', description: 'Unauthenticated RCE.',
      evidence: 'uid=33(www-data)', confidence: 'high',
      counterevidence: 'WAF could block; it did not.', remediation: 'Upgrade.',
      created_at: 't0',
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (captured.strix_report!.execute({ action: 'report' }, {}) as any).then(() => {
      const md = readFileSync(join(config.workspaceDir, 'report.md'), 'utf8')
      const lines = md.split('\n')
      expect(lines.filter((l) => l.trim() === '').length).toBeGreaterThan(3)
      // A `---` directly under a text line is parsed as a setext H2.
      const rule = lines.indexOf('---')
      expect(rule).toBeGreaterThan(0)
      expect(lines[rule - 1]!.trim()).toBe('')
      // The description must not be a lazy continuation of the metadata list.
      const desc = lines.indexOf('Unauthenticated RCE.')
      expect(lines[desc - 1]!.trim()).toBe('')
    })
  })
})

describe('create validation (strict evidence, trimmed)', () => {
  it('rejects missing AND whitespace-only evidence in strict mode', () => {
    expect(validateFinding({}, true)).toMatch(/REJECTED/)
    expect(validateFinding({ evidence: '   ' }, true)).toMatch(/REJECTED/)
    expect(validateFinding({ evidence: 'uid=33' }, true)).toBeNull()
    expect(validateFinding({ evidence: 'uid=33' }, false)).toBeNull()
  })

  it('rejects out-of-list enums', () => {
    expect(validateFinding({ evidence: 'x', severity: 'SortaCritical' }, false)).toMatch(/severity/)
    expect(validateFinding({ evidence: 'x', vulnerability_type: 'skynet' }, false)).toMatch(/vulnerability_type/)
  })

  it('rejects out-of-list confidence', () => {
    expect(validateFinding({ evidence: 'x', confidence: 'banana' }, false)).toMatch(/confidence/)
    expect(validateFinding({ evidence: 'x', confidence: 'high' }, false)).toBeNull()
  })
})

describe('structured evidence refs (phase 3: tamper-evident artifacts)', () => {
  it('normalizeEvidenceRefs: undefined passes through, non-array is rejected', () => {
    const config = scratchConfig()
    expect(normalizeEvidenceRefs(config, undefined)).toEqual({ refs: [], error: null })
    expect(normalizeEvidenceRefs(config, 'nope').error).toMatch(/REJECTED/)
    expect(normalizeEvidenceRefs(config, {}).error).toMatch(/REJECTED/)
  })

  it('rejects refs missing fields, escaping the workspace, or pointing at missing files', () => {
    const config = scratchConfig()
    expect(normalizeEvidenceRefs(config, [{ source: 'strix_http' }]).error).toMatch(/artifact/)
    expect(normalizeEvidenceRefs(config, [{ artifact: 'responses/x.json' }]).error).toMatch(/source/)
    expect(normalizeEvidenceRefs(config, [{ artifact: '../../etc/passwd', source: 'strix_http' }]).error).toMatch(/workspace/)
    expect(normalizeEvidenceRefs(config, [{ artifact: 'responses/never-saved.json', source: 'strix_http' }]).error).toMatch(/does not exist/)
  })

  it('stamps plugin-computed sha256 + registered_at, trims the note', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'responses')
    mkdirSync(dir, { recursive: true })
    const body = '{"status":500,"body":"sql error"}'
    writeFileSync(join(dir, 'req-001.json'), body, 'utf8')
    const { refs, error } = normalizeEvidenceRefs(config, [
      { artifact: 'responses/req-001.json', source: 'strix_http', note: '  time-based blind pair  ' },
    ])
    expect(error).toBeNull()
    expect(refs).toHaveLength(1)
    expect(refs[0]!.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(refs[0]!.registered_at).toBeTruthy()
    expect(refs[0]!.note).toBe('time-based blind pair')
  })

  it('evidenceRefDrift flags changed and missing artifacts, stays silent when intact', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'screenshots')
    mkdirSync(dir, { recursive: true })
    for (const name of ['a.png', 'b.png', 'c.png']) writeFileSync(join(dir, name), `content-${name}`, 'utf8')
    const { refs } = normalizeEvidenceRefs(config, [
      { artifact: 'screenshots/a.png', source: 'strix_browser' },
      { artifact: 'screenshots/b.png', source: 'strix_browser' },
      { artifact: 'screenshots/c.png', source: 'strix_browser' },
    ])
    writeFileSync(join(dir, 'a.png'), 'tampered', 'utf8')
    rmSync(join(dir, 'c.png'))
    const drift = evidenceRefDrift(config, refs)
    expect(drift).toHaveLength(2)
    expect(drift.join('\n')).toMatch(/a\.png.*CHANGED/)
    expect(drift.join('\n')).toMatch(/c\.png.*missing/)
    expect(drift.join('\n')).not.toContain('b.png')
  })

  it('create wires evidence_refs; the report renders them and flags post-registration tampering', async () => {
    const config = scratchConfig()
    let captured: { execute: (a: unknown, e: unknown) => Promise<string> } | undefined
    registerFinding({ tools: { register: (t) => { captured = t } } } as never, config)
    const dir = join(config.workspaceDir, 'responses')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'poc.json'), 'proof-v1', 'utf8')
    const out = await captured!.execute({
      action: 'create', title: 'SQLi in login', severity: 'high', target: 'http://t/login',
      vulnerability_type: 'sqli', evidence: 'uid=33',
      evidence_refs: [{ artifact: 'responses/poc.json', source: 'strix_http', note: 'response pair' }],
    }, {})
    expect(out).toMatch(/F-001/)
    // Tamper AFTER registration — the report must catch it, not vouch for it.
    writeFileSync(join(dir, 'poc.json'), 'proof-v2', 'utf8')
    const rcaptured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerReport({ tools: { register: (t) => { rcaptured[t.name] = t } } } as never, config)
    await rcaptured.strix_report!.execute({ action: 'report' }, {})
    const md = readFileSync(join(config.workspaceDir, 'report.md'), 'utf8')
    expect(md).toContain('Evidence artifacts')
    expect(md).toContain('responses/poc.json')
    expect(md).toMatch(/CHANGED since registration/)
  })
})

describe('CVSS v3.1 vector syntax validation (phase 3)', () => {
  it('accepts valid base and full temporal+environmental vectors', () => {
    expect(validateCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeNull()
    expect(validateCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:U/RL:O/RC:C/CR:H/IR:M/AR:H/MAV:A/MC:L')).toBeNull()
  })

  it('rejects bad prefix, unknown metric, malformed value, missing base metrics', () => {
    expect(validateCvssVector('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toMatch(/REJECTED/)
    expect(validateCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/XX:H')).toMatch(/metric/)
    expect(validateCvssVector('CVSS:3.1/AV:n/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toMatch(/uppercase/)
    expect(validateCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H')).toMatch(/missing base metric/)
  })

  it('gates create through validateFinding', () => {
    expect(validateFinding({ evidence: 'x', cvss_vector: 'not-a-vector' }, false)).toMatch(/cvss_vector/)
    expect(validateFinding({ evidence: 'x', cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }, false)).toBeNull()
  })
})

describe('finish convergence (phase 3: close is a real terminal state)', () => {
  async function finishTool(config: ConfigType, jobs: unknown): Promise<{ execute: (a: unknown, e: unknown) => Promise<string> }> {
    const captured: Record<string, { execute: (a: unknown, e: unknown) => Promise<string> }> = {}
    registerReport({ tools: { register: (t) => { captured[t.name] = t } }, jobs } as never, config)
    if (!existsSync(join(config.workspaceDir, 'report.md'))) {
      writeFileSync(join(config.workspaceDir, 'report.md'), '# Report\n\nbody\n', 'utf8')
    }
    return captured.strix_report!
  }

  const finishArgs = {
    action: 'finish', caller_role: 'root',
    executive_summary: 's', methodology: 'm', technical_analysis: 't', recommendations: 'r',
  }

  function seedLedger(config: ConfigType) {
    writeLedger(config, [
      { id: 'C-001', surface: 'http://a.example/login', risk_area: 'auth', outcome: 'needs_follow_up', evidence_note: 'needs test account', recorded_at: 't0' },
      { id: 'C-002', surface: 'http://b.example/admin', risk_area: 'rce', outcome: 'blocked', evidence_note: 'WAF', recorded_at: 't0' },
      { id: 'C-003', surface: 'http://c.example/', risk_area: 'info', outcome: 'clean', evidence_note: '', recorded_at: 't0' },
    ])
  }

  it('no live jobs: loose ends listed honestly, report-final.md frozen', async () => {
    const config = scratchConfig()
    seedLedger(config)
    const tool = await finishTool(config, { list: () => [] })
    const out = await tool.execute(finishArgs, {})
    expect(out).toMatch(/Engagement closed/)
    expect(out).toMatch(/1 needs_follow_up, 1 blocked/)
    const md = readFileSync(join(config.workspaceDir, 'report.md'), 'utf8')
    expect(md).toContain('### Convergence')
    expect(md).toContain('No live strix-shell jobs at close.')
    expect(md).toContain('needs_follow_up: http://a.example/login')
    expect(md).toContain('blocked: http://b.example/admin')
    expect(existsSync(join(config.workspaceDir, 'report-final.md'))).toBe(true)
  })

  it('a job that settles within the budget is not killed', async () => {
    const config = scratchConfig()
    let running = true
    const kills: string[] = []
    const jobs = {
      list: () => (running ? [{ id: 'strix-shell-1', kind: 'strix-shell', status: 'running', label: 'nmap scan' }] : []),
      wait: async () => { running = false },
      kill: (id: string, _c: unknown, reason: string) => { kills.push(`${id}:${reason}`) },
    }
    const tool = await finishTool(config, jobs)
    const out = await tool.execute(finishArgs, {})
    expect(kills).toHaveLength(0)
    expect(out).toMatch(/1 settled within/)
  })

  it('a straggler past the budget is killed with a stated reason', async () => {
    const config = scratchConfig()
    const kills: string[] = []
    const jobs = {
      list: () => [{ id: 'strix-shell-2', kind: 'strix-shell', status: 'running', label: 'slow nuclei' }],
      wait: async () => { throw new Error('timeout') },
      kill: (id: string, _c: unknown, reason: string) => { kills.push(`${id}:${reason}`) },
    }
    const tool = await finishTool(config, jobs)
    const out = await tool.execute(finishArgs, {})
    expect(kills).toEqual(['strix-shell-2:engagement finish convergence'])
    expect(out).toMatch(/killed/)
    const md = readFileSync(join(config.workspaceDir, 'report.md'), 'utf8')
    expect(md).toContain('- killed: slow nuclei')
  })

  it('refreshes a stale SARIF sidecar at close', async () => {
    const config = scratchConfig()
    mkdirSync(join(config.workspaceDir, 'findings'), { recursive: true })
    writeFileSync(join(config.workspaceDir, 'findings', 'F-001.json'), JSON.stringify({
      id: 'F-001', title: 'X', vulnerability_type: 'xss', severity: 'low', target: 'http://t/',
      description: 'd', evidence: 'e', created_at: 't0',
    }), 'utf8')
    writeFileSync(join(config.workspaceDir, 'findings.sarif'), 'stale', 'utf8')
    const tool = await finishTool(config, { list: () => [] })
    const out = await tool.execute(finishArgs, {})
    expect(out).toMatch(/SARIF refreshed/)
    const sarif = JSON.parse(readFileSync(join(config.workspaceDir, 'findings.sarif'), 'utf8'))
    expect(sarif.version).toBe('2.1.0')
  })

  it('second finish is still rejected (idempotent close)', async () => {
    const config = scratchConfig()
    const tool = await finishTool(config, { list: () => [] })
    await tool.execute(finishArgs, {})
    const out2 = await tool.execute(finishArgs, {})
    expect(out2).toMatch(/already closed/)
  })
})

describe('finding update guards (regression: update was the back door past create validation)', () => {
  async function seededTool(config: ConfigType): Promise<{ execute: (a: unknown, e: unknown) => Promise<string> }> {
    let captured: { execute: (a: unknown, e: unknown) => Promise<string> } | undefined
    registerFinding({ tools: { register: (t) => { captured = t } } } as never, config)
    mkdirSync(join(config.workspaceDir, 'findings'), { recursive: true })
    writeFileSync(join(config.workspaceDir, 'findings', 'F-001.json'), JSON.stringify({
      id: 'F-001', title: 'SQLi in /login', vulnerability_type: 'sqli', severity: 'high',
      target: 'http://t/login', description: 'd', evidence: "1' OR '1'='1", created_at: 't0',
    }))
    return captured!
  }

  it('rejects a bogus severity through the tool surface', async () => {
    const tool = await seededTool(scratchConfig())
    await expect(tool.execute({ action: 'update', id: 'F-001', severity: 'SortaCritical' }, {}))
      .resolves.toMatch(/severity must be one of/)
  })

  it('rejects emptying evidence under strict mode', async () => {
    const tool = await seededTool(scratchConfig())
    await expect(tool.execute({ action: 'update', id: 'F-001', evidence: '   ' }, {}))
      .resolves.toMatch(/forbids emptying the evidence/)
  })

  it('allows unrelated updates (no evidence field passed)', async () => {
    const config = scratchConfig() // strictEvidence: true
    const tool = await seededTool(config)
    await expect(tool.execute({ action: 'update', id: 'F-001', title: 'SQLi in /login (confirmed)', confidence: 'high' }, {}))
      .resolves.toContain('Updated F-001')
  })
})

describe('dedupe-check manifest handling (regression: mismatch must not short-circuit)', () => {
  const mkFinding = (id: string, hay: string): Finding => ({
    id, title: hay, vulnerability_type: 'dependency_cve', severity: 'high',
    target: hay, description: hay, evidence: hay, created_at: 't0',
  })

  it('keeps scanning past a manifest mismatch', () => {
    const existing = [
      // F-001 shares CVE+package+ecosystem but never mentions the
      // candidate's manifest.
      mkFinding('F-001', 'npm lodash CVE-2021-23337 prototype pollution'),
      // F-002 shares all of that AND names the candidate's manifest.
      mkFinding('F-002', 'npm b/package.json lodash CVE-2021-23337'),
    ]
    const verdict = checkDuplicate(
      { vulnerability_type: 'dependency_cve', cve: 'CVE-2021-23337', package_name: 'lodash', package_ecosystem: 'npm', manifest_path: 'b/package.json' },
      existing,
    )
    expect(verdict.duplicate).toBe(true)
    expect(verdict.existing_id).toBe('F-002')
  })

  it('still reports distinct manifests as distinct findings', () => {
    const existing = [mkFinding('F-001', 'npm a/package.json lodash CVE-2021-23337')]
    const verdict = checkDuplicate(
      { vulnerability_type: 'dependency_cve', cve: 'CVE-2021-23337', package_name: 'lodash', package_ecosystem: 'npm', manifest_path: 'b/package.json' },
      existing,
    )
    expect(verdict.duplicate).toBe(false)
  })
})

describe('KEV cache reads', () => {
  const writeKev = (config: ConfigType, fetchedAt: string, cves: string[]): void => {
    const dir = join(config.workspaceDir, 'vulndb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'kev.json'), JSON.stringify({ fetched_at: fetchedAt, cves }))
  }

  it('treats a corrupt fetched_at as unusable instead of throwing', () => {
    const config = scratchConfig()
    writeKev(config, 'not-a-date', ['CVE-1'])
    expect(readKevCache(config, Date.now())).toBeNull()
  })

  it('stale is null for freshness checks but usable for plain lookups', () => {
    const config = scratchConfig()
    const old = Date.now() - 25 * 3600 * 1000
    writeKev(config, new Date(old).toISOString(), ['CVE-2024-0001'])
    expect(readKevCache(config, Date.now())).toBeNull()
    expect(readKevCache(config)?.has('CVE-2024-0001')).toBe(true)
  })
})

describe('bundled skills loading is fail-soft', () => {
  it('registers nothing and does not throw on a corrupt manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strix-skills-'))
    writeFileSync(join(dir, 'manifest.json'), '{ not json')
    const registered: string[] = []
    const ctx = { skills: { register: (s: { name: string }) => { registered.push(s.name) } } }
    await expect(registerBundledSkills(ctx as never, dir)).resolves.toBe(0)
    expect(registered).toHaveLength(0)
  })

  it('skips unreadable entries and duplicate names, registers the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strix-skills-'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([
      { name: 'good', description: 'd', category: 'c', upstream: 'u', file: 'good.md' },
      { name: 'missing', description: 'd', category: 'c', upstream: 'u', file: 'missing.md' },
      { name: 'good', description: 'dupe', category: 'c', upstream: 'u', file: 'good.md' },
      { name: '', description: 'd', category: 'c', upstream: 'u', file: 'noname.md' },
    ]))
    writeFileSync(join(dir, 'good.md'), 'content')
    const registered: string[] = []
    const ctx = { skills: { register: (s: { name: string }) => { registered.push(s.name) } } }
    await expect(registerBundledSkills(ctx as never, dir)).resolves.toBe(1)
    expect(registered).toEqual(['good'])
  })
})

describe('runProcess timeout reaps the process tree', () => {
  // node is guaranteed on PATH in CI (setup-node) and locally; `sleep` is not
  // a thing on Windows runners.
  const hang = () => runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 100)'], { timeoutMs: 700 })

  it('reports timedOut and settles promptly', async () => {
    const started = Date.now()
    const result = await hang()
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it.skipIf(process.platform !== 'win32')('kills grandchildren too (Windows taskkill /T)', async () => {
    // cmd -> ping. If only cmd died, ping would keep the stdio pipes open and
    // `close` would not fire until ping's full 30s lifetime — so a prompt
    // settle IS the assertion that the tree was reaped.
    const started = Date.now()
    const result = await runProcess('cmd', ['/c', 'ping -n 30 127.0.0.1'], { timeoutMs: 900 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it.skipIf(process.platform === 'win32')('kills grandchildren too (POSIX process group)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strix-tree-'))
    const pidFile = join(dir, 'grandchild.pid')
    const js = "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid)); setInterval(()=>{}, 100)"
    // `& wait` forces the shell to fork, so node really is a grandchild
    // (a single simple command would be exec-replaced into the shell).
    const result = await runProcess('sh', ['-c', 'node -e ' + JSON.stringify(js) + ' & wait'], { timeoutMs: 800 })
    expect(result.timedOut).toBe(true)
    const grandchild = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    await new Promise((r) => setTimeout(r, 300))
    let alive = true
    try { process.kill(grandchild, 0) } catch { alive = false }
    expect(alive).toBe(false)
  })
})

describe('storage hardening (batch 4)', () => {
  type Exec = (a: unknown, e: unknown) => Promise<string>
  const capture = (register: (ctx: never, config: ConfigType) => void, config: ConfigType): Record<string, { execute: Exec }> => {
    const captured: Record<string, { execute: Exec }> = {}
    register({ tools: { register: (t: { name: string }) => { captured[t.name] = t as { execute: Exec } } } } as never, config)
    return captured
  }

  it('writeFileAtomic lands complete content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strix-atomic-'))
    const file = join(dir, 'w.json')
    await writeFileAtomic(file, '{"a":1}')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 })
    await writeFileAtomic(file, '{"a":2}')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
  })

  it('listFindings skips a corrupt file instead of throwing', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'findings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'F-001.json'), JSON.stringify({ id: 'F-001' }))
    writeFileSync(join(dir, 'F-002.json'), '{broken')
    expect(listFindings(config).map((f) => f.id)).toEqual(['F-001'])
  })

  it('readLedger skips torn lines', () => {
    const config = scratchConfig()
    const dir = join(config.workspaceDir, 'coverage')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'ledger.jsonl'),
      ['{"id":"C-001"}', '{broken', '{"id":"C-002"}'].join('\n'),
    )
    expect(readLedger(config).map((e) => e.id)).toEqual(['C-001', 'C-002'])
  })

  it('coverage record appends and rejects blank fields', async () => {
    const config = scratchConfig()
    const tools = capture(registerCoverage, config)
    const cov = tools.strix_coverage!
    await cov.execute({ action: 'record', surface: 'http://t/', risk_area: 'SQLi', outcome: 'clean' }, {})
    await cov.execute({ action: 'record', surface: 'http://t/about', risk_area: 'XSS', outcome: 'clean' }, {})
    expect(readLedger(config)).toHaveLength(2)
    await expect(cov.execute({ action: 'record', surface: '   ', risk_area: 'XSS', outcome: 'clean' }, {}))
      .resolves.toMatch(/REJECTED/)
    await expect(cov.execute({ action: 'record', surface: 'http://t/', risk_area: 'SQLi', outcome: 'maybe' }, {}))
      .resolves.toMatch(/REJECTED/)
    await expect(cov.execute({ action: 'update', id: '../../evil' }, {}))
      .resolves.toMatch(/REJECTED/)
  })

  it('coverage update round-trips through the tool surface', async () => {
    const config = scratchConfig()
    const tools = capture(registerCoverage, config)
    const cov = tools.strix_coverage!
    await cov.execute({ action: 'record', surface: 'http://t/', risk_area: 'SQLi', outcome: 'needs_follow_up', evidence_note: 'pending' }, {})
    await expect(cov.execute({ action: 'update', id: 'C-001', outcome: 'clean' }, {}))
      .resolves.toContain('Moved C-001')
    await expect(cov.execute({ action: 'update', id: 'C-404', outcome: 'clean' }, {}))
      .resolves.toContain('not found')
  })

  it('budget record accumulates across reads (no lost increments)', async () => {
    const config = scratchConfig()
    const tools = capture(registerBudget, config)
    const budget = tools.strix_budget!
    await budget.execute({ action: 'record', input_tokens: 1000, output_tokens: 500 }, {})
    await budget.execute({ action: 'record', input_tokens: 1000, output_tokens: 500 }, {})
    const ledger = readBudget(config)
    expect(ledger.records).toBe(2)
    expect(ledger.inputTokens).toBe(2000)
    const status = await budget.execute({ action: 'status' }, {})
    expect(status).toContain('Tokens: 2000 in / 1000 out across 2 records.')
  })

  it('budget reset zeroes and audits the decision', async () => {
    const config = scratchConfig()
    const tools = capture(registerBudget, config)
    const budget = tools.strix_budget!
    await budget.execute({ action: 'record', input_tokens: 1000, output_tokens: 500 }, {})
    await expect(budget.execute({ action: 'reset' }, {})).resolves.toContain('reset to zero')
    expect(readBudget(config).records).toBe(0)
    const log = readFileSync(join(config.workspaceDir, 'evidence', 'log.jsonl'), 'utf8')
    expect(log).toContain('"outcome":"reset"')
  })

  it('finish appends exactly once; report preserves the close', async () => {
    const config = scratchConfig()
    const tools = capture(registerReport, config)
    const report = tools.strix_report!
    await report.execute({ action: 'report', engagement_title: 'T' }, {})
    const four = {
      executive_summary: 's', methodology: 'm', technical_analysis: 't', recommendations: 'r',
    }
    await expect(report.execute({ action: 'finish', caller_role: 'root', ...four }, {}))
      .resolves.toContain('Engagement closed')
    await expect(report.execute({ action: 'finish', caller_role: 'root', ...four }, {}))
      .resolves.toMatch(/already closed/)
    await report.execute({ action: 'report', engagement_title: 'T2' }, {})
    const md = readFileSync(join(config.workspaceDir, 'report.md'), 'utf8')
    expect(md).toContain(CLOSE_MARKER)
    expect(md).toContain('# T2')
    expect(md.indexOf(CLOSE_MARKER)).toBe(md.lastIndexOf(CLOSE_MARKER))
  })

  it('threat-model amend appends sections and rejects blanks', async () => {    const config = scratchConfig()
    const tools = capture(registerThreatModel, config)
    const tm = tools.strix_threat_model!
    await tm.execute({ action: 'save', text: 'baseline model' }, {})
    await tm.execute({ action: 'amend', text: 'boundary X is reachable' }, {})
    await tm.execute({ action: 'amend', text: 'role Y exists' }, {})
    const md = readFileSync(join(config.workspaceDir, 'threat-model.md'), 'utf8')
    expect(md).toContain('baseline model')
    expect(md).toContain('boundary X is reachable')
    expect(md).toContain('role Y exists')
    await expect(tm.execute({ action: 'amend', text: '   ' }, {})).resolves.toMatch(/REJECTED/)
    await expect(tm.execute({ action: 'save', text: '' }, {})).resolves.toMatch(/REJECTED/)
  })

  it('validates pip package specs without blocking pins and extras', () => {
    expect(validPipPackages('requests==2.31.0')).toBe(true)
    expect(validPipPackages('a>=1,<2 b~=1.4 c[x,y]')).toBe(true)
    expect(validPipPackages('')).toBe(true)
    for (const bad of ['--index-url http://evil', '-r req.txt', '--find-links /x', '--extra-index-url http://e', 'pkg; rm -rf /']) {
      expect(validPipPackages(bad)).toBe(false)
    }
  })

  it('clamps model-supplied timeouts to sane bounds', () => {
    expect(clampTimeoutMs(5000, 1000)).toBe(5000)
    expect(clampTimeoutMs(-5, 1000)).toBe(1000)
    expect(clampTimeoutMs(0, 1000)).toBe(1000)
    expect(clampTimeoutMs(Number.NaN, 1000)).toBe(1000)
    expect(clampTimeoutMs('x', 1000)).toBe(1000)
    expect(clampTimeoutMs(99_999_999, 1000)).toBe(3_600_000)
  })

  it('reads the bundle version from package.json instead of a constant', () => {
    // Must track package.json (not the old hardcoded 0.8.0) and look like semver.
    expect(strixDhVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(strixDhVersion()).not.toBe('0.8.0')
  })
})

// ── browser persistent-session integration (real Chromium) ──────────────────
// Regression for the "browser is not a persistent page session" P0: sessions
// must keep ONE BrowserContext + Page across calls, so login/fill/click/
// screenshot sequences work. Skips when playwright or its Chromium binary is
// unavailable (e.g. CI without `playwright install`); CI installs it.

const chromiumReady = await (async () => {
  try {
    const pw = await import('playwright')
    const b = await pw.chromium.launch({ headless: true })
    await b.close()
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!chromiumReady)('browser persistent session (real Chromium)', () => {
  const PAGE_HTML = `<!doctype html><html><head><title>strix-dh test page</title></head><body>
<h1>strix-dh test page</h1>
<input id="name" placeholder="name">
<button id="add" onclick="var v=document.getElementById('name').value||'(empty)';var li=document.createElement('li');li.textContent=v;document.getElementById('list').appendChild(li);localStorage.setItem('last',v);document.cookie='clicked=1'">add</button>
<ul id="list"></ul>
</body></html>`

  let server: import('node:http').Server | undefined
  let baseUrl = ''
  let disposePlugin: (() => void) | undefined

  beforeAll(async () => {
    const http = await import('node:http')
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const addr = server!.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  afterAll(async () => {
    disposePlugin?.()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  function browserTool(config: ConfigType): { execute: (raw: Record<string, unknown>) => Promise<string> } {
    const captured: Record<string, { execute: (raw: Record<string, unknown>) => Promise<string> }> = {}
    registerBrowser({
      tools: { register: (t) => { captured[t.name] = t } },
      effect: (fn: () => () => void) => { disposePlugin = fn() },
    } as never, config)
    return captured.strix_browser!
  }

  it('keeps page, DOM, localStorage, and cookies across calls in one session', async () => {
    const config = scratchConfig()
    const tool = browserTool(config)
    const s = 'persist-1'

    // 1. navigate
    await expect(tool.execute({ action: 'navigate', session: s, url: baseUrl })).resolves.toContain('strix-dh test page')

    // 2. fill on the SAME page (would fail on a fresh blank page: no #name)
    await expect(tool.execute({ action: 'fill', session: s, selector: '#name', value: 'alice' })).resolves.toContain('Filled')

    // 3. click #add — page JS appends <li>, sets localStorage + cookie
    await expect(tool.execute({ action: 'click', session: s, selector: '#add' })).resolves.toContain('Clicked')

    // 4. evaluate: DOM change from the click survived into this call
    await expect(tool.execute({ action: 'evaluate', session: s, value: 'document.querySelectorAll("#list li").length + ":" + localStorage.getItem("last") + ":" + document.cookie' })).resolves.toContain('1:alice')

    // 5. content: filled value + appended list item are in the live DOM
    await expect(tool.execute({ action: 'content', session: s })).resolves.toContain('alice')

    // 6. screenshot lands in workspace/screenshots
    const out = await tool.execute({ action: 'screenshot', session: s })
    const m = /Screenshot saved: (.+?.png)/.exec(out)
    expect(m).toBeTruthy()
    expect(existsSync(m![1].trim())).toBe(true)

    // 7. close, then a NEW session on the same name starts fresh (no cookie/localStorage bleed)
    await expect(tool.execute({ action: 'close', session: s })).resolves.toContain('closed')
    await tool.execute({ action: 'navigate', session: s, url: baseUrl })
    await expect(tool.execute({ action: 'evaluate', session: s, value: 'localStorage.getItem("last") + ":" + document.cookie' })).resolves.toBe('null:')
    await tool.execute({ action: 'close', session: s })
  })

  it('isolates concurrent sessions from each other', async () => {
    const config = scratchConfig()
    const tool = browserTool(config)

    await tool.execute({ action: 'navigate', session: 'iso-a', url: baseUrl })
    await tool.execute({ action: 'navigate', session: 'iso-b', url: baseUrl })
    await tool.execute({ action: 'evaluate', session: 'iso-a', value: 'localStorage.setItem("who","a")' })
    await tool.execute({ action: 'evaluate', session: 'iso-b', value: 'localStorage.setItem("who","b")' })
    await expect(tool.execute({ action: 'evaluate', session: 'iso-a', value: 'localStorage.getItem("who")' })).resolves.toBe('a')
    await expect(tool.execute({ action: 'evaluate', session: 'iso-b', value: 'localStorage.getItem("who")' })).resolves.toBe('b')
    await tool.execute({ action: 'close', session: 'iso-a' })
    await tool.execute({ action: 'close', session: 'iso-b' })
  })

  it('evaluate: bare expressions run directly, statements fall back to an IIFE (heuristic regression)', async () => {
    const config = scratchConfig()
    const tool = browserTool(config)
    await tool.execute({ action: 'navigate', session: 'eval-1', url: baseUrl })

    // Bare identifier/expression: runs as-is, no fallback marker. (The old
    // `includes('=>')` heuristic wrapped plain expressions in an IIFE and
    // returned undefined for them.)
    await expect(tool.execute({ action: 'evaluate', session: 'eval-1', value: 'document.title' })).resolves.toBe('strix-dh test page')
    // A multi-statement snippet whose LAST part is an expression evaluates
    // fine directly (Chromium accepts `let n = 1; n += 1; n` as one program
    // and returns 2) — no fallback needed, no marker.
    await expect(tool.execute({ action: 'evaluate', session: 'eval-1', value: 'let n = 1; n += 1; n' })).resolves.toBe('2')
    // A `return` statement is ILLEGAL in the expression context → the page
    // throws a SyntaxError → the statement fallback wraps it in
    // `(() => { ... })()` and stamps the retry note.
    const out = await tool.execute({ action: 'evaluate', session: 'eval-1', value: 'return 6 * 7' })
    expect(out).toMatch(/42/)
    expect(out).toMatch(/ran as statements/)
    // An arrow FUNCTION value passes through unwrapped (the heuristic used
    // to send statement strings unwrapped and arrow values double-wrapped).
    await expect(tool.execute({ action: 'evaluate', session: 'eval-1', value: 'typeof (() => 1)' })).resolves.toBe('function')
    await tool.execute({ action: 'close', session: 'eval-1' })
  })

  it('concurrent first calls on one session name share a single browser (leak regression)', async () => {
    const config = scratchConfig()
    const tool = browserTool(config)
    // Two actions racing on the SAME fresh session name: both must resolve
    // (a navigate racing another action on the one shared page can abort
    // with ERR_ABORTED — Playwright cancels in-flight loads — so the race
    // pair is evaluate+evaluate, both landing on the one page). The old
    // code launched two browsers and one leaked, unreachable by close.
    const [a, b] = await Promise.all([
      tool.execute({ action: 'evaluate', session: 'race-1', value: '1 + 1' }),
      tool.execute({ action: 'evaluate', session: 'race-1', value: '2 + 2' }),
    ])
    expect(a).toMatch(/2/)
    expect(b).toMatch(/4/)
    // The session is closeable exactly once — the second close reports not-open.
    await expect(tool.execute({ action: 'close', session: 'race-1' })).resolves.toMatch(/closed/)
    await expect(tool.execute({ action: 'close', session: 'race-1' })).resolves.toMatch(/not open/)
  })
})

// ── http timeout covers the body-receiving phase ─────────────────────────────
// Regression for the "clearTimeout fires when headers arrive" P1: a slow-drip
// body must still abort at the configured timeout, not hang until the socket
// closes on its own.

describe('sendHttpRequest timeout covers body reception', () => {
  it('aborts a slow-drip body at the configured timeout', async () => {
    const http = await import('node:http')
    // Headers arrive immediately; the body drips 1 byte/300ms forever.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const iv = setInterval(() => res.write('x'), 300)
      req.on('close', () => clearInterval(iv))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
    try {
      const config = scratchConfig()
      const started = Date.now()
      const out = await sendHttpRequest(config, { url, timeoutMs: 1200 })
      const elapsed = Date.now() - started
      expect(out.ok).toBe(false)
      expect(out.text).toMatch(/timeout after 1200ms while receiving the body/)
      // Aborted by OUR timer, not by the server: well under the drip's
      // natural lifetime, with generous CI scheduling slack.
      expect(elapsed).toBeLessThan(10_000)
    } finally {
      server.close()
      server.closeAllConnections?.()
    }
  })
})

// ── approval gate (createApprovalGate) ────────────────────────────────────────
// The fail-closed security core behind strix_shell/strix_pybox had ZERO test
// coverage (review finding): every branch here is a security property.

describe('approval gate (createApprovalGate)', () => {
  const exec = { name: 'strix_shell', callId: 'call-1', agent: { id: 'agent-1' }, signal: undefined }

  function gateCtx(outcome: string | Error): { ctx: unknown; requests: unknown[] } {
    const requests: unknown[] = []
    const ctx = {
      approval: {
        request: async (req: unknown) => {
          requests.push(req)
          if (outcome instanceof Error) throw outcome
          return outcome
        },
      },
    }
    return { ctx, requests }
  }

  it("gate 'off' grants without asking and logs gate-off to the evidence ledger", async () => {
    const config = scratchConfig() // approvalGate: 'off' by default
    const { ctx, requests } = gateCtx('rejected')
    const decision = await createApprovalGate(ctx as never, config)(exec, 'run "echo t"')
    expect(decision.granted).toBe(true)
    expect(requests).toHaveLength(0)
    expect(readFileSync(join(config.workspaceDir, 'evidence', 'log.jsonl'), 'utf8')).toMatch(/"outcome":"gate-off"/)
  })

  it('auto-allow pattern grants on the FULL text without asking', async () => {
    const config = { ...scratchConfig(), approvalGate: 'always' as const, approvalAutoAllow: ['^strix_shell: run "echo'] }
    const { ctx, requests } = gateCtx('rejected')
    const decision = await createApprovalGate(ctx as never, config)(exec, 'strix_shell: run "echo t" (network: on)')
    expect(decision.granted).toBe(true)
    expect(requests).toHaveLength(0)
    expect(readFileSync(join(config.workspaceDir, 'evidence', 'log.jsonl'), 'utf8')).toMatch(/"outcome":"auto-allowed"/)
  })

  it('a pattern matching only the display-truncation marker never grants (display-match regression)', async () => {
    // The marker text ("[full N chars, sha256:...]") exists ONLY in the
    // display half. Matching patterns against the display would let a
    // marker-shaped pattern grant on invisible content — the gate must ask.
    const config = { ...scratchConfig(), approvalGate: 'always' as const, approvalAutoAllow: ['\\[full \\d+ chars'] }
    const { ctx, requests } = gateCtx('rejected')
    const decision = await createApprovalGate(ctx as never, config)(exec, splitApprovalSummary('x'.repeat(500)))
    expect(decision.granted).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it("operator 'allowed-once' grants; rejected/cancelled/unavailable all fail closed", async () => {
    const config = { ...scratchConfig(), approvalGate: 'always' as const }
    const ok = gateCtx('allowed-once')
    const granted = await createApprovalGate(ok.ctx as never, config)(exec, 'run "echo t"')
    expect(granted.granted).toBe(true)
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const c = gateCtx(outcome)
      const d = await createApprovalGate(c.ctx as never, config)(exec, 'run "echo t"')
      expect(d.granted).toBe(false)
      if (!d.granted) {
        expect(d.message).toMatch(/DENIED/)
        expect(d.message).toContain(outcome)
      }
    }
  })

  it('approval service throwing degrades to denied (unavailable), never propagates', async () => {
    const config = { ...scratchConfig(), approvalGate: 'always' as const }
    const { ctx } = gateCtx(new Error('boom'))
    const d = await createApprovalGate(ctx as never, config)(exec, 'run "echo t"')
    expect(d.granted).toBe(false)
    if (!d.granted) expect(d.outcome).toBe('unavailable')
  })

  it('missing agent identity denies without asking (headless fail-closed)', async () => {
    const config = { ...scratchConfig(), approvalGate: 'always' as const }
    const { ctx, requests } = gateCtx('allowed-once')
    const d = await createApprovalGate(ctx as never, config)({ name: 'strix_shell', callId: 'c2' }, 'run "echo t"')
    expect(d.granted).toBe(false)
    expect(requests).toHaveLength(0)
  })
})

// ── docker integration: the real container path end-to-end ────────────────────
// Review finding: shell/pybox had only pure-function coverage; the whole
// dockerRun chain (argv → daemon → cidfile → output capture) was never
// exercised. These run wherever a Docker daemon answers (CI ubuntu legs;
// locally with Docker Desktop up) and self-skip otherwise — same pattern as
// the Chromium integration tests above.

const dockerReady = (() => {
  try {
    // A responding daemon is NOT enough: GitHub's windows runners run a
    // Windows-native daemon with no linux/amd64 manifests, and
    // `python:3.12-slim` fails with exit 125 ("no matching manifest") —
    // the integration tests must self-skip there (regression: the probe
    // only checked Server.Version and both container tests failed on
    // windows-latest). Docker Desktop (Linux containers) reports
    // OSType=linux and runs normally.
    const r = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    return r.status === 0 && r.stdout.trim().toLowerCase() === 'linux'
  } catch {
    return false
  }
})()

describe.skipIf(!dockerReady)('docker integration: strix_shell / strix_pybox end-to-end', () => {
  it('strix_shell runs a command in a real container and returns its output', async () => {
    const config = { ...scratchConfig(), shellTimeoutMs: 60_000, shellNetwork: false }
    const regs: unknown[] = []
    registerShell({ tools: { register: (d: unknown) => regs.push(d) } } as never, config)
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    const out = await tool.execute({ command: 'echo docker-shell-ok' }, { name: 'strix_shell', callId: 'd-1' })
    expect(out).toMatch(/docker-shell-ok/)
    expect(out).not.toMatch(/Docker is unavailable/)
    // Evidence ledger got the run result row.
    expect(readFileSync(join(config.workspaceDir, 'evidence', 'log.jsonl'), 'utf8')).toMatch(/"kind":"result"/)
  }, 120_000)

  it('strix_pybox runs a script with files and arguments in the mounted workspace', async () => {
    const config = { ...scratchConfig(), pyboxTimeoutMs: 60_000, pyboxNetwork: false }
    const regs: unknown[] = []
    registerPybox({ tools: { register: (d: unknown) => regs.push(d) } } as never, config)
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    const out = await tool.execute({
      script: 'import json\nprint("pybox-" + open("word.txt").read().strip())\nprint("arg=" + json.load(open("args.json"))["k"])',
      files: { 'word.txt': 'files-ok' },
      arguments: { k: 'args-ok' },
    }, { name: 'strix_pybox', callId: 'd-2' })
    expect(out).toMatch(/pybox-files-ok/)
    expect(out).toMatch(/arg=args-ok/)
    expect(out).not.toMatch(/Docker is unavailable/)
  }, 120_000)
})

// ── http response byte cap ────────────────────────────────────────────────────
// Regression: response.text() buffered the ENTIRE body into memory before the
// display copy was truncated — a multi-GB body OOM'd the harness. Reception
// must stop at httpMaxBodyBytes.

describe('sendHttpRequest byte cap', () => {
  it('stops receiving at httpMaxBodyBytes and stamps the output', async () => {
    const http = await import('node:http')
    // 50KB body; cap at 10KB — the connection must be torn down mid-stream.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('y'.repeat(50_000))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
    try {
      const config = { ...scratchConfig(), httpMaxBodyBytes: 10_000, httpMaxBodyChars: 200_000 }
      const out = await sendHttpRequest(config, { url })
      expect(out.ok).toBe(true)
      expect(out.text).toMatch(/body reception stopped at 10000 bytes/)
      // The received body is bounded by the cap. Node's fetch may coalesce
      // the whole 50KB into one chunk for a loopback response, so assert on
      // the CAP being hit and the marker, not on an exact byte count.
      expect(out.text).toMatch(/\[body reception stopped/)
      // The DISPLAY copy stays char-truncated as before.
      expect(out.rawBody.length).toBeLessThanOrEqual(50_000)
    } finally {
      server.close()
      server.closeAllConnections?.()
    }
  })

  it('receives the full body when under the cap', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('complete-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
    try {
      const out = await sendHttpRequest(scratchConfig(), { url })
      expect(out.ok).toBe(true)
      expect(out.rawBody).toBe('complete-body')
      expect(out.text).not.toMatch(/body reception stopped/)
      expect(out.byteCapped).toBe(false)
    } finally {
      server.close()
      server.closeAllConnections?.()
    }
  })

  it('reports byteCapped=true when reception was cut at the cap', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('y'.repeat(50_000))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
    try {
      const config = { ...scratchConfig(), httpMaxBodyBytes: 10_000, httpMaxBodyChars: 200_000 }
      const out = await sendHttpRequest(config, { url })
      expect(out.ok).toBe(true)
      // The flag is what save_to's honest cap note keys on: a capped
      // reception means the SAVED copy is bounded too.
      expect(out.byteCapped).toBe(true)
    } finally {
      server.close()
      server.closeAllConnections?.()
    }
  })
})

// ── budget block gates the execution-class tools ─────────────────────────────
// Regression: budgetAction 'block' was consulted only by recon/sast/depcheck/
// proxy — shell/pybox/browser ran regardless, so the config promised more
// than it enforced.

describe('budget block gates execution tools', () => {
  function overBudgetConfig(): ConfigType {
    const config = scratchConfig()
    // One record already over a $1 cap: priced at the scratch per-1K rates.
    writeFileSync(join(config.workspaceDir, 'budget-records.jsonl'),
      JSON.stringify({ ts: 't', in: 100_000, out: 0, usd: 10, note: 'seed' }) + '\n', 'utf8')
    return { ...config, budgetLimitUsd: 1, budgetAction: 'block' as const }
  }

  it('strix_shell refuses under block mode without running anything', async () => {
    const regs: unknown[] = []
    registerShell({ tools: { register: (d: unknown) => regs.push(d) } } as never, overBudgetConfig())
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    const out = await tool.execute({ command: 'echo should-not-run' }, { name: 'strix_shell', callId: 'b-1' })
    expect(out).toMatch(/BUDGET EXCEEDED: strix_shell refused/)
    expect(out).not.toMatch(/should-not-run/)
    // Nothing reached the evidence result ledger (the refusal precedes the gate).
    expect(existsSync(join(overBudgetConfig().workspaceDir, 'evidence', 'log.jsonl'))).toBe(false)
  })

  it('strix_pybox refuses under block mode without running anything', async () => {
    const regs: unknown[] = []
    registerPybox({ tools: { register: (d: unknown) => regs.push(d) } } as never, overBudgetConfig())
    const tool = regs[0] as { execute: (raw: Record<string, unknown>, exec: unknown) => Promise<string> }
    const out = await tool.execute({ script: 'print("should-not-run")' }, { name: 'strix_pybox', callId: 'b-2' })
    expect(out).toMatch(/BUDGET EXCEEDED: strix_pybox refused/)
    expect(out).not.toMatch(/should-not-run/)
  })

  it('strix_browser refuses actions but keeps close available over budget', async () => {
    let disposed = false
    const captured: Record<string, { execute: (raw: Record<string, unknown>) => Promise<string> }> = {}
    registerBrowser({
      tools: { register: (t) => { captured[t.name] = t } },
      effect: (fn: () => () => void) => { return () => { disposed = true; fn()() } },
    } as never, overBudgetConfig())
    const tool = captured.strix_browser!
    const out = await tool.execute({ action: 'navigate', session: 'b', url: 'http://127.0.0.1:1/' })
    expect(out).toMatch(/BUDGET EXCEEDED: strix_browser refused/)
    // close on an unopened session still answers (cleanup stays available).
    expect(await tool.execute({ action: 'close', session: 'b' })).toMatch(/not open/)
    expect(disposed).toBe(false)
  })
})

// ── bundled skill contract lint ───────────────────────────────────────────────
// Regression: python.md taught `install_packages: ["requests"]` (an ARRAY)
// while the tool parameter is a space-separated STRING — a model following
// the skill verbatim passes the wrong type. Skills are prompt surface; their
// examples must match the tool contracts they teach.

describe('bundled skill contract lint', () => {
  it('python.md teaches install_packages as a string, not an array', () => {
    const md = readFileSync(new URL('../assets/skills/python.md', import.meta.url), 'utf8')
    expect(md).not.toMatch(/install_packages:\s*\[/)
    expect(md).toMatch(/install_packages:\s*"/)
  })
})
