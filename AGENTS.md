# StriX-DH Engagement Instructions

This workspace hosts the StriX-DH project: an offensive-security tool suite
for the DeepSeek Harness, adapted from Strix (Apache-2.0).

## What agents working in this repository should know

- **Start from `docs/DEVELOPMENT.md`** — the full developer handbook (Strix/dsh
  analysis, compatibility surface, upgrade drill, verification matrix).
- Tool contracts: `docs/tools-reference.md`; engagement tutorial: `docs/walkthrough.md`; upstream analyses: `docs/strix-analysis.md`, `docs/dsh-analysis.md`; skill inventory: `docs/skills-catalog.md`
- Source of truth for runtime mechanics: `docs/architecture.md` (version
  pins, import redirection, section orders, profile semantics).
- Behavior rules and safety boundaries: `docs/safety.md` — only test targets
  you own or have written permission to test.
- How the agent is instructed: `docs/prompt-design.md`.
- Build: `cd packages/strix-tools && npm install && npm run build` (TypeScript
  strict, NodeNext ESM — imports need `.js` extensions).
- Regenerate adapted skills after upstream changes:
  `python scripts/adapt_skills.py`.
- Run: `npx -y @deepseek-ai/dsh@0.1.2-alpha.5 web --no-open` (boot log prints
  the registration line and the tokened WebUI URL).
- Default engagement workspace: `~/.dsh/strix-workspace` (findings/, coverage/,
  notes/, recon/, pybox/, responses/, evidence/, report.md).
- **Approval gate**: `strix_shell`/`strix_pybox` ask the operator via dsh's
  ApprovalService before every execution (fail-closed). New execution-class
  tools must route through `createApprovalGate` in `src/lib/approval.ts`.
- On Windows, if port 3080 is stuck after killing dsh, find the orphaned node
  PID via `netstat -ano | findstr :3080` and `taskkill /F /PID <pid>`.

## Code conventions

- Every tunable belongs in the plugin `Config` schema (`src/config.ts`), never
  hardcoded — dsh fails loudly on schema violations.
- Tool modules live in `src/tools/` and export a single
  `register(ctx, config)`; register them in `src/index.ts`.
- Tool descriptions are prompt surface: write them as behavioral rules, not
  feature lists.
- Adapted upstream content keeps its attribution header. Do not remove it.
