# strix-dsh-tools

Offensive-security tool suite for the DeepSeek Harness (dsh): 16 native tools
(strix_http / strix_finding / strix_coverage / strix_shell / strix_pybox /
strix_browser / strix_recon / strix_sast / strix_proxy / strix_depcheck /
strix_authorization / strix_budget / strix_report / strix_runs /
strix_notes / strix_threat_model), a methodology + authorization system-prompt
section, and 75 bundled knowledge skills — adapted from
[Strix](https://github.com/usestrix/strix) (Apache-2.0).

**Authorized use only.** Only run the tools against systems you own or have
explicit, written permission to test.

Full documentation lives in the repository root:
[README](https://github.com/pengcong226/strix-dsh) ·
[docs/DEVELOPMENT.md](https://github.com/pengcong226/strix-dsh/blob/main/docs/DEVELOPMENT.md) ·
[docs/tools-reference.md](https://github.com/pengcong226/strix-dsh/blob/main/docs/tools-reference.md) ·
[docs/safety.md](https://github.com/pengcong226/strix-dsh/blob/main/docs/safety.md)

## Install into a dsh profile

```sh
dsh plugin --profile web add ./packages/strix-tools
npx -y @deepseek-ai/dsh web --no-open
# boot log: [strix-dsh-tools] registered 16 tool modules + methodology + authorization sections + 75 skills
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — methodology,
prompts, and skill packages are adapted from Strix (Apache-2.0); this is a
plugin bundle for dsh (MIT).
