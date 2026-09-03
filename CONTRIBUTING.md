# Contributing to StriX-DH

## Start here

- `docs/DEVELOPMENT.md` is the developer handbook (Strix/dsh analysis, compatibility surface, upgrade drill, verification matrix). Read it before changing tools.
- `AGENTS.md` has the working conventions for this repo (build, skills regeneration, workspace layout, approval-gate rule).
- `docs/safety.md` + `SECURITY.md` are normative: no stealth/evasion, no C2/post-exploitation, no auth-bypass helpers. PRs adding such capabilities will be closed.

## Ground rules

1. **Every tunable goes in the plugin `Config` schema** (`packages/strix-tools/src/config.ts`). No hardcoded timeouts, images, rates, or prices — dsh fails loudly on schema violations, and reviewers will ask for the config field.
2. **One tool module per capability** (`src/tools/<name>.ts`, single `register(ctx, config)` export, registered in `src/index.ts`). Tool `description` text is prompt surface: write behavioral rules, not feature lists.
3. **Pure logic must be exported and unit-tested.** `test/core.test.ts` runs in CI with no Docker/network/LLM: parsers, validators, ledger round-trips, formatters, argv builders. New pure functions without tests will be sent back.
4. **Python scripts carry `--self-test`** (`scripts/adapt_skills.py --self-test`, stdlib unittest only) and CI runs it.
5. **Framework deps pin to the runtime's version exactly** (`@deepseek-ai/dsh-tools`, `dsh-jobs`, …). The `^` range that broke third-party plugins on the CallId incident is documented in DEVELOPMENT.md §3.3 — do not reintroduce it.
6. **Attribution headers stay.** Adapted Strix content keeps its Apache-2.0 header; do not remove or rewrite it.
7. **Fail closed.** Approval gates, budget gates, and validation rejections deny by default; `unavailable` is a denial, never a pass-through. Mirror/ledger writes are best-effort and must never turn a tool success into an error.

## Workflow

```sh
cd packages/strix-tools
npm install
npm run build        # zero errors before anything else
npm test -- --run    # vitest, 36+ tests
cd ../.. && python scripts/adapt_skills.py --self-test
```

- Bump `packages/strix-tools/package.json` version per change (0.x minor per feature) and add a row to the version history in `docs/DEVELOPMENT.md` §4.
- Update `docs/tools-reference.md` (contract + real output), `docs/walkthrough.md` (if the tutorial path changes), and both READMEs' tool tables when adding or changing tools.
- Verify with a real headless call before claiming a tool works (`docs/DEVELOPMENT.md` §4.5 smoke commands). Quote the verbatim output in the PR.
- Keep `upstream/` out of PRs (gitignored reference clones, never published). Remove run artifacts (`dsh-boot.log`, `strix-workspace/`) before committing.

## What we will not merge

- Evasion/stealth features, fingerprint spoofing, persistence/C2/post-exploitation tooling, jailbreak or refusal-bypass mechanisms. See `docs/safety.md` ("Things StriX-DH deliberately does not do").
- Changes that phone home or exfiltrate workspace data anywhere.
- New execution-class tools that bypass `createApprovalGate` (`src/lib/approval.ts`).
