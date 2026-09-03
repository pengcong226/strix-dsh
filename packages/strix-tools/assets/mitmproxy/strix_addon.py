"""
StriX-DH mitmproxy sidecar addon: logs every HTTP flow as a one-line JSON
summary plus full request/response files for later replay.

Runs inside the mitmproxy/mitmproxy container with the workspace mounted at
/workspace. Output layout under /workspace/proxy/:

  flows.jsonl        one JSON object per completed flow (append-only)
  flows/<id>.req     raw request (request line + headers + body)
  flows/<id>.rsp     raw response (status line + headers + body)

HTTPS without the sidecar CA installed yields CONNECT metadata only
(host/port); full bodies require the client to trust the sidecar CA
(see docs, strix_proxy start output tells where the CA lives).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

OUT = Path("/workspace/proxy")
FLOWS = OUT / "flows"


def _body_preview(content: bytes | None, limit: int = 2000) -> str:
    if not content:
        return ""
    try:
        text = content.decode("utf-8", errors="replace")
    except Exception:
        return f"<{len(content)} binary bytes>"
    return text[:limit]


def _save(flow_id: str, suffix: str, data: bytes) -> None:
    try:
        (FLOWS / f"{flow_id}.{suffix}").write_bytes(data)
    except OSError:
        pass


class StrixLogger:
    def __init__(self) -> None:
        self._seq = 0
        OUT.mkdir(parents=True, exist_ok=True)
        FLOWS.mkdir(parents=True, exist_ok=True)

    def _next_id(self) -> str:
        self._seq += 1
        return f"F-{int(time.time())}-{self._seq:04d}"

    def response(self, flow) -> None:
        req = flow.request
        rsp = flow.response
        if rsp is None:
            return
        fid = self._next_id()
        raw_req = req.method.encode() + b" " + req.path.encode() + b" HTTP/1.1\r\n"
        for k, v in req.headers.items():
            raw_req += f"{k}: {v}\r\n".encode()
        raw_req += b"\r\n" + (req.content or b"")
        raw_rsp = f"HTTP/1.1 {rsp.status_code} {rsp.reason}\r\n".encode()
        for k, v in rsp.headers.items():
            raw_rsp += f"{k}: {v}\r\n".encode()
        raw_rsp += b"\r\n" + (rsp.content or b"")
        _save(fid, "req", raw_req)
        _save(fid, "rsp", raw_rsp)
        summary = {
            "id": fid,
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "method": req.method,
            "url": req.pretty_url,
            "status": rsp.status_code,
            "req_bytes": len(raw_req),
            "rsp_bytes": len(raw_rsp),
            "rsp_preview": _body_preview(rsp.content),
        }
        try:
            with (OUT / "flows.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(summary, ensure_ascii=False) + "\n")
        except OSError:
            pass


addons = [StrixLogger()]
