# -*- coding: utf-8 -*-
"""
adapt_skills.py —— 把 Strix 上游知识包机械改编为 StriX-DH 的 dsh skills

- 读取 upstream/strix/strix/skills/**/*.md（README 除外）
- 工具/生命周期名称映射到 StriX-DH 原生工具与 dsh 原生机制
- 技能名转 kebab-case（dsh SKILL_NAME 规范不允许下划线）
- 每个文件头部注入改编与出处声明
- 生成 manifest.json 供 bundled skill provider 加载
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "upstream" / "strix" / "strix" / "skills"
OUT = ROOT / "packages" / "strix-tools" / "assets" / "skills"

# Strix 工具/机制 → StriX-DH / dsh 原生（词边界替换，大小写敏感优先）
MAPPINGS: list[tuple[str, str]] = [
    # 报告管线
    (r"create_vulnerability_report", "strix_finding"),
    (r"create_dependency_report", "strix_finding (vulnerability_type=dependency_cve)"),
    (r"update_vulnerability_report", "strix_finding update action"),
    (r"get_report", "strix_finding get action"),
    (r"list_reports", "strix_finding list action"),
    # 状态台账
    (r"record_coverage", "strix_coverage record"),
    (r"update_coverage", "strix_coverage update"),
    (r"list_coverage", "strix_coverage list"),
    (r"create_note", "strix_notes create"),
    (r"list_notes", "strix_notes list"),
    (r"get_note", "strix_notes get"),
    (r"update_note", "strix_notes update"),
    (r"delete_note", "strix_notes delete"),
    (r"get_threat_model", "strix_threat_model get"),
    (r"amend_threat_model", "strix_threat_model amend"),
    (r"save_threat_model", "strix_threat_model save"),
    # 执行
    (r"exec_command", "strix_shell"),
    (r"agent-browser", "strix_browser"),
    (r"agent_browser", "strix_browser"),
    # 技能加载
    (r"load_skill", "skill"),
    # 编排（dsh 原生）
    (r"create_agent", "subagent"),
    (r"wait_for_agents", "subagent 后台运行+通知（dsh 原生）"),
    (r"view_agent_graph", "agent 状态总览（dsh 原生）"),
    (r"send_message_to_agent", "send_message（dsh 原生）"),
    (r"stop_agent", "interrupt_agent（dsh 原生）"),
    # 生命周期（dsh 无对应工具，turn 自然结束）
    (r"finish_scan", "完成收尾（汇总报告并结束任务）"),
    (r"agent_finish", "完成子任务（汇报结果并结束）"),
    (r"respond_to_user", "直接回复用户（dsh 原生 turn 语义）"),
    # Caido 代理
    (r"caido_api", "strix_http"),
    (r"list_requests", "strix_http 重放与捕获"),
    (r"proxy history", "striX-DH 捕获的请求记录"),
]

HEADER = """<!--
Adapted for StriX-DH from the Strix project (https://github.com/usestrix/strix),
licensed under the Apache License, Version 2.0. Tool names and lifecycle
references have been remapped to StriX-DH native tools and dsh primitives.
Modifications © 2026 StriX-DH contributors, Apache-2.0.
-->
"""


def to_kebab(name: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return re.sub(r"-{2,}", "-", out)


def adapt_body(body: str) -> str:
    for pat, repl in MAPPINGS:
        body = re.sub(rf"\b{pat}\b", repl, body)
    return body


def parse_frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    seen_names: set[str] = set()
    for path in sorted(SRC.rglob("*.md")):
        rel = path.relative_to(SRC)
        if rel.parts[0] == "README.md" or rel.name == "README.md":
            continue
        category = rel.parts[0] if len(rel.parts) > 1 else "general"
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(raw)
        name = to_kebab(meta.get("name") or path.stem)
        if name in seen_names:
            name = to_kebab(f"{category}-{name}")
        seen_names.add(name)
        description = meta.get("description", f"{category} methodology from Strix")
        adapted = f"{HEADER}\n{adapt_body(body).strip()}\n"
        out_path = OUT / f"{name}.md"
        out_path.write_text(adapted, encoding="utf-8", newline="\n")
        manifest.append(
            {
                "name": name,
                "description": description,
                "category": category,
                "upstream": f"strix/strix/skills/{rel.as_posix()}",
                "file": f"{name}.md",
            }
        )
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n"
    )
    print(f"adapted {len(manifest)} skills -> {OUT}")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        import unittest

        class TestToKebab(unittest.TestCase):
            def test_snake_to_kebab(self):
                self.assertEqual(to_kebab("record_coverage"), "record-coverage")

            def test_spaces_and_case(self):
                self.assertEqual(to_kebab("  SQL Injection Basics "), "sql-injection-basics")

            def test_collapses_separators(self):
                self.assertEqual(to_kebab("a__b--c  d"), "a-b-c-d")

            def test_strips_edges(self):
                self.assertEqual(to_kebab("_leading_trailing_"), "leading-trailing")

            def test_empty(self):
                self.assertEqual(to_kebab(""), "")

        class TestAdaptBody(unittest.TestCase):
            def test_word_boundary_mapping(self):
                out = adapt_body("use create_vulnerability_report today")
                self.assertIn("strix_finding", out)
                # Word boundary: must not rewrite a longer identifier.
                out2 = adapt_body("my_create_vulnerability_report_x")
                self.assertNotIn("strix_finding", out2)

            def test_unmapped_passthrough(self):
                self.assertEqual(adapt_body("plain text"), "plain text")

        unittest.main(argv=[sys.argv[0]], exit=False)
    else:
        main()
