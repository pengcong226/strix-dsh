/**
 * Unit tests for the pure, filesystem-light core of StriX-DH tools:
 * raw-request parsing, finding validation, ledger round-trips, and the
 * bounded-output helper. No Docker, no network, no LLM — safe in CI.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConfigType } from '../src/config.js'
import { safeId, safeWorkspacePath, truncate } from '../src/lib/util.js'
import { checkExtraArgs } from '../src/tools/sast.js'
import { matchesAutoAllow } from '../src/lib/approval.js'
import { methodologySection } from '../src/index.js'
import { formatDepFinding, parseOsvVuln, sortDepFindings } from '../src/tools/depcheck.js'
import { parseRawRequest } from '../src/tools/http.js'
import { SEVERITIES, VULN_TYPES, authorizationSummary, checkDuplicate, listFindings, missingFinishSections, validateFinding } from '../src/tools/finding.js'
import { OUTCOMES, readLedger, writeLedger } from '../src/tools/coverage.js'
import { authorizationPath, isAuthorizationExpired, maskTestAccount, matchesPreApprovedPost, readAuthorization, renderAuthorizationSection } from '../src/tools/authorization.js'
import { bumpPostCount, postCountsPath, readPostCounts } from '../src/tools/http.js'
import { budgetPath, checkBudget, formatUsd, priceUsage, readBudget } from '../src/tools/budget.js'
import { buildBackgroundDockerArgs, jobLabel } from '../src/lib/jobs.js'
import { mirrorEvent } from '../src/lib/session-mirror.js'
import { filterFlows, formatFlow, readFlows } from '../src/tools/proxy.js'
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
    browserHeadless: true,
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
  ]

  it('flags same type + endpoint + overlapping target as duplicate', () => {
    const v = checkDuplicate(
      { title: 'login SQL injection', vulnerability_type: 'sqli', target: 'https://example.com/login?user=x' },
      registered,
    )
    expect(v.duplicate).toBe(true)
    expect(v.existing_id).toBe('F-001')
  })

  it('clears different endpoints with the same type', () => {
    const v = checkDuplicate(
      { title: 'search SQL injection', vulnerability_type: 'sqli', target: 'https://example.com/search?q=x' },
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
    expect(bumpPostCount(config, '/oas/forgetPassword')).toBe(1)
    expect(bumpPostCount(config, '/oas/forgetPassword')).toBe(2)
    expect(bumpPostCount(config, '/other')).toBe(1)
    expect(readPostCounts(config)).toEqual({ '/oas/forgetPassword': 2, '/other': 1 })
    // Persisted as JSON next to the workspace.
    expect(JSON.parse(readFileSync(postCountsPath(config), 'utf8'))['/oas/forgetPassword']).toBe(2)
  })

  it('returns empty on missing or corrupt files instead of throwing', () => {
    expect(readPostCounts(scratchConfig())).toEqual({})
    const config = scratchConfig()
    writeFileSync(postCountsPath(config), '{not json', 'utf8')
    expect(readPostCounts(config)).toEqual({})
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
  }

  it('builds docker run argv with workspace mount and workdir', () => {
    const args = buildBackgroundDockerArgs('/ws', baseSpec)
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-v'])
    expect(args).toContain('/ws:/workspace')
    expect(args).toContain('/workspace')
    expect(args.slice(-3)).toEqual(['bash', '-c', 'echo hi'])
    expect(args).not.toContain('--network')
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

  it('forwards type and data to a live session', () => {
    const calls: Array<{ type: string; data: unknown }> = []
    const exec = fakeExec({
      id: 'x',
      session: {
        append: (type: string, data: unknown) => {
          calls.push({ type, data })
        },
      },
    })
    mirrorEvent(exec, 'strix/note', { action: 'create', note: { id: 'N-001' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.type).toBe('strix/note')
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
