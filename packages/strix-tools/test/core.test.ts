/**
 * Unit tests for the pure, filesystem-light core of StriX-DH tools:
 * raw-request parsing, finding validation, ledger round-trips, and the
 * bounded-output helper. No Docker, no network, no LLM — safe in CI.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConfigType } from '../src/config.js'
import { nextIdAmong, nextSequentialId, runProcess, clampTimeoutMs, safeId, safeWorkspacePath, truncate, writeExclusive, writeFileAtomic } from '../src/lib/util.js'
import { registerBundledSkills } from '../src/skills-provider.js'
import { registerNotes } from '../src/tools/notes.js'
import { checkExtraArgs, SEMGREP_BLOCKED_EXTRA_FLAGS, semgrepTargetAllowed } from '../src/tools/sast.js'
import { matchesAutoAllow, splitApprovalSummary } from '../src/lib/approval.js'
import { methodologySection } from '../src/index.js'
import { formatDepFinding, parseOsvVuln, readKevCache, sortDepFindings } from '../src/tools/depcheck.js'
import { parseRawRequest, evaluatePostPolicy, STATE_CHANGING_METHODS } from '../src/tools/http.js'
import { SEVERITIES, VULN_TYPES, authorizationSummary, checkDuplicate, CLOSE_MARKER, listFindings, missingFinishSections, registerFinding, registerReport, validateFinding } from '../src/tools/finding.js'
import { OUTCOMES, readLedger, registerCoverage, writeLedger } from '../src/tools/coverage.js'
import { authorizationPath, isAuthorizationExpired, maskTestAccount, matchesPreApprovedPost, readAuthorization, registerAuthorization, renderAuthorizationSection, targetCoveredByAuth } from '../src/tools/authorization.js'
import { bumpPostCount, postCountsPath, readPostCounts } from '../src/tools/http.js'
import { budgetPath, checkBudget, formatUsd, priceUsage, readBudget, registerBudget } from '../src/tools/budget.js'
import { strixDhVersion } from '../src/tools/sarif.js'
import { validPipPackages } from '../src/tools/pybox.js'
import { buildBackgroundDockerArgs, jobLabel } from '../src/lib/jobs.js'
import { registerThreatModel } from '../src/tools/threat-model.js'
import { createSprayGuardHandler, type GuardedRoute } from '../src/tools/browser.js'
import { mirrorEvent } from '../src/lib/session-mirror.js'
import { filterFlows, formatFlow, pidOwnedByDockerCli, procCmdlineIsDockerCli, proxyImageKey, readFlows, tasklistRowIsDockerCli } from '../src/tools/proxy.js'
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
    expect(bumpPostCount(config, '/oas/forgetPassword')).toBe(1)
    expect(bumpPostCount(config, '/oas/forgetPassword')).toBe(2)
    expect(bumpPostCount(config, '/other')).toBe(1)
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
    expect(bumpPostCount(config, '/oas/forgetPassword')).toBe(6)
  })

  it('does not lose counts when two writers append concurrently', () => {
    const config = scratchConfig()
    // The old read→mutate→rewrite implementation had each writer read the
    // same total and both write old+1. Appending is order-independent.
    for (let i = 0; i < 7; i++) bumpPostCount(config, '/api/reset')
    expect(readPostCounts(config)['/api/reset']).toBe(7)
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
