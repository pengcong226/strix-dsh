<!--
Adapted for StriX-DH from the Strix project (https://github.com/usestrix/strix),
licensed under the Apache License, Version 2.0. Rewritten for the native
strix_pybox / strix_shell tools — the upstream sandbox Python module and
Caido SDK bindings do not exist here. Modifications © 2026 StriX-DH
contributors, Apache-2.0.
-->

# Python In The Sandbox

Two native tools run Python — never mix them up:

- **strix_pybox**: purpose-built for exploit scripts. Pass the script text in
  `script`, extra files in `files`, CLI args in `arguments`, pip packages in
  `install_packages`. Runs in a one-shot container; the run directory
  (workspace/pybox/run-*) keeps main.py, args, and output for evidence.
- **strix_shell**: general commands, including `python3 -c '...'` one-liners
  and `python3 script.py` for files already in the workspace (the workspace is
  mounted at /workspace).

Prefer strix_pybox for payload sprays and PoC scripts; prefer strix_shell for
quick transformations. Both go through the operator approval gate.

## Writing reusable scripts

Write the script to a workspace file once, then run it repeatedly:

```bash
# strix_shell: python3 /workspace/scripts/retry.py https://target.tld/
python3 /workspace/scripts/retry.py "$1"
```

For anything longer than a few lines, strix_pybox with the full script text
beats shell-quoting gymnastics.

## HTTP from Python

There is no `strix_http` Python module — that was upstream's Caido binding.
Use the standard library or requests (via `install_packages: "requests"` — a
SPACE-SEPARATED STRING, not an array — in strix_pybox):

```python
import requests
r = requests.post("https://target.tld/login",
                  data={"username": "probe", "password": "x"},
                  timeout=10, allow_redirects=False)
print(r.status_code, r.headers.get("Location"))
```

For single request/response pairs, prefer the strix_http tool directly — it
stamps pre-approval/cap audit notes and can save full bodies with `save_to`.
Use Python only when you need loops, parsing, or state across requests.

## Proxy capture from Python

To work with captured traffic, read the proxy flow files directly from the
workspace (`proxy/flows.jsonl`, `proxy/flows/<id>.req|.rsp`) — plain JSONL and
raw text, no SDK needed:

```python
import json
for line in open("/workspace/proxy/flows.jsonl"):
    f = json.loads(line)
    if f.get("method") == "POST":
        print(f["id"], f["url"])
```

Replay a captured request with the strix_proxy tool (`action: "replay"`), or
re-send it manually via requests using the .req file contents.

## Installing extra packages

strix_pybox: pass pip specs in `install_packages` as a single string
(space-separated for multiple, e.g. `"requests beautifulsoup4"`; names only —
flags like `-r`/`--index-url` are rejected). Common picks: `requests`,
`httpx`, `beautifulsoup4`, `lxml`, `pyjwt`, `cryptography`.

strix_shell: the default python:3.12-slim image has no extra packages — pip
install inside the same command if needed, or use strix_pybox instead.

## Workflow for iterative exploit work

1. Keep the script in the workspace under a task-unique name (e.g.
   `poc_<task-id>.py`) so it cannot clobber another agent's script.
2. Run it (strix_pybox for full scripts, strix_shell for one-liners).
3. Edit and rerun until the proof-of-concept is reliable, then cite the file
   in the finding's `poc_script` field.

## Discipline

- One well-structured script beats a dozen ad-hoc one-liners.
- Honor the engagement's noise constraints inside scripts too: sleep between
  requests, cap iterations, never spray faster than the operator allowed.
- Only against authorized targets.
