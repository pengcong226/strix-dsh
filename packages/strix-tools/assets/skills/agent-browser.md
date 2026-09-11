<!--
Adapted for StriX-DH from the Strix project (https://github.com/usestrix/strix),
licensed under the Apache License, Version 2.0. Rewritten for the native
strix_browser tool (Playwright) — the upstream agent-browser CLI does not
exist here. Modifications © 2026 StriX-DH contributors, Apache-2.0.
-->

# strix_browser core

Native Playwright browser automation, called directly as the `strix_browser`
tool — never through strix_shell. Actions: `navigate | click | fill | evaluate
| screenshot | content | close`. Selectors are plain CSS (`#id`, `.class`,
`input[name=q]`).

## Sessions are persistent

A session (default `"default"`) is one BrowserContext + one long-lived page:
navigation, cookies, and localStorage SURVIVE between calls. Login once, then
fill/click/screenshot in later calls. Sessions live in the plugin process —
parallel agents or engagements must use distinct session names.

```
strix_browser {action: "navigate", session: "auth-flow", url: "https://target/login"}
strix_browser {action: "fill", session: "auth-flow", selector: "#username", value: "test"}
strix_browser {action: "fill", session: "auth-flow", selector: "#password", value: "..."}
strix_browser {action: "click", session: "auth-flow", selector: "button[type=submit]"}
strix_browser {action: "evaluate", session: "auth-flow", value: "document.cookie"}
strix_browser {action: "close", session: "auth-flow"}   // when done
```

## The core loop

1. `navigate` the target (returns the page title).
2. Read the DOM you need to act on: `content` (HTML, truncated at 20k chars)
   or `evaluate` a JS expression (`document.querySelector('#x').outerHTML`).
3. `click` / `fill` by CSS selector.
4. After any state change, re-read (`content` / `evaluate`) — DOM you captured
   earlier is stale.
5. `screenshot` to workspace/screenshots/<session>-<ts>.png for evidence
   (view it with the read_image tool).

## evaluate semantics

`value` is a JavaScript EXPRESSION evaluated in the page. Wrap statements or
reading a variable in an IIFE: `(() => document.title)()`,
`(() => { const t = document.title; return t })()`. Plain expressions like
`document.title` also work. Return values are JSON-serialized into the tool
result.

## Spray-guard on writes

Every page carries the automated spray-guard: browser-fired writes (form
submits, XHR/fetch from evaluate) go through the same pre-approval / per-path
cap policy as strix_http, with no human involved. Over-cap writes are
ABORTED before they leave and the verdict is stamped into the action result —
if a click "does nothing", check the guard note in the output.

## Auth-flow testing pattern (XSS / CSRF / clickjacking / session)

- Log in inside a dedicated session, then use `evaluate` to probe
  `document.cookie`, localStorage tokens, and window variables.
- For reflected-XSS confirmation, navigate to the payload URL and `evaluate`
  `document.body.innerText` / alert-hook checks.
- For CSRF, reproduce the cross-site form inside the session and observe the
  response state via `content`.
- For session-fixation / cookie-scope checks, compare `document.cookie`
  across navigate steps in the SAME session.
- Screenshots before/after are the evidence pair for strix_finding.

Only against authorized targets.
