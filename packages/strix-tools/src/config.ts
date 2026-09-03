/**
 * StriX-DH plugin configuration. Every tunable is a config field per the dsh
 * "no hardcoded tunables" principle; values live in the bundle row under
 * `config:` in cordis.patch.yml / profile patches.
 */
import z from '@deepseek-ai/schemastery'

export interface ConfigType {
  /**
   * Shared engagement workspace (findings/, coverage/, notes/, recon/).
   * Empty string anchors to `<DSH_HOME>/strix-workspace` (stable across
   * boots); a relative path resolves against the process cwd.
   */
  workspaceDir: string
  /** strix_http: request timeout in milliseconds. */
  httpTimeoutMs: number
  /** strix_http: maximum response body characters returned to the model. */
  httpMaxBodyChars: number
  /**
   * strix_http: per-path cap for non-preapproved POSTs sent under a live
   * authorization (spray guard). 0 disables the cap. Persisted as an
   * append-only ledger in workspace/http-post-counts.jsonl, keyed by path
   * (pre-0.12 workspace/http-post-counts.json is read-only-merged, never
   * rewritten, so upgrades keep the existing budget).
   */
  httpPostCapPerPath: number
  /** strix_shell: container image used for command execution. */
  shellImage: string
  /**
   * strix_shell: extra container images the model may select via the per-call
   * `image` override (e.g. a Kali image). Empty (default) = only shellImage.
   * Any other image name is refused — the model must never pull arbitrary
   * images on its own.
   */
  shellAllowedImages: string[]
  /** strix_shell: container network enabled by default. */
  shellNetwork: boolean
  /** strix_shell: default timeout in milliseconds. */
  shellTimeoutMs: number
  /** strix_pybox: container image used for Python exploit scripts. */
  pyboxImage: string
  /** strix_pybox: extra pip packages pre-installed before running a script. */
  pyboxExtraPackages: string[]
  /** strix_pybox: container network enabled by default. */
  pyboxNetwork: boolean
  /** strix_pybox: default timeout in milliseconds. */
  pyboxTimeoutMs: number
  /** Directory containing recon/sast binaries (subfinder, httpx, nuclei, semgrep). Also searched on PATH. */
  binariesDir: string
  /** strix_recon: default timeout per engine in milliseconds. */
  reconTimeoutMs: number
  /** strix_sast: nuclei rate limit (requests per second). */
  nucleiRateLimit: number
  /** strix_browser: run Chromium headless. */
  browserHeadless: boolean
  /** strix_finding: reject findings without an evidence field. */
  strictEvidence: boolean
  /**
   * HITL gate for strix_shell/strix_pybox: 'always' routes every command and
   * script through dsh's ApprovalService before execution (fail closed);
   * 'off' runs autonomously — only for unattended runs the operator accepts.
   */
  approvalGate: 'always' | 'off'
  /**
   * strix_shell/strix_pybox: regex list (as strings) for commands/scripts
   * the operator pre-approves — matching summaries skip the human prompt and
   * run immediately, logged as `auto-allowed` in evidence/log.jsonl.
   * Default empty = no auto-allow (previous behavior, fully fail-closed).
   * Typical: `^strix_shell: run "(echo|uname|whoami|id|ls|cat|head|tail|grep|jq)`.
   * The match runs against the same approval summary a human would read
   * (tool name + command/script head), so patterns stay reviewable.
   */
  approvalAutoAllow: string[]
  /**
   * Budget ledger (strix_budget): 0 disables. Otherwise the engagement's
   * cumulative LLM spend cap in USD, priced with the per-1K rates below.
   */
  budgetLimitUsd: number
  /** strix_budget: price per 1K input tokens in USD. */
  budgetInputPer1k: number
  /** strix_budget: price per 1K output tokens in USD. */
  budgetOutputPer1k: number
  /**
   * strix_budget: what heavy tools (recon/sast) do once the ledger exceeds
   * the cap — 'warn' prepends a warning and proceeds, 'block' refuses.
   */
  budgetAction: 'warn' | 'block'
}

export const Config = z
  .object({
    workspaceDir: z.string().default(''),
    httpTimeoutMs: z.number().default(30_000),
    httpMaxBodyChars: z.number().default(20_000),
    httpPostCapPerPath: z.number().default(5),
    shellImage: z.string().default('python:3.12-slim'),
    shellAllowedImages: z.array(z.string()).default([]),
    shellNetwork: z.boolean().default(true),
    shellTimeoutMs: z.number().default(120_000),
    pyboxImage: z.string().default('python:3.12-slim'),
    pyboxExtraPackages: z.array(z.string()).default([]),
    pyboxNetwork: z.boolean().default(true),
    pyboxTimeoutMs: z.number().default(60_000),
    binariesDir: z.string().default(''),
    reconTimeoutMs: z.number().default(300_000),
    nucleiRateLimit: z.number().default(50),
    browserHeadless: z.boolean().default(true),
    strictEvidence: z.boolean().default(true),
    approvalGate: z.union(['always', 'off'] as const).default('always'),
    approvalAutoAllow: z.array(z.string()).default([]),
    budgetLimitUsd: z.number().default(0),
    budgetInputPer1k: z.number().default(0.00027),
    budgetOutputPer1k: z.number().default(0.0004),
    budgetAction: z.union(['warn', 'block'] as const).default('warn'),
  })
  .description('StriX-DH offensive-security tool suite configuration')
