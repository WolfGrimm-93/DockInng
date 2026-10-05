#!/usr/bin/env python3
"""Run the project's declared DTS Labs quality gate without third-party dependencies."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "quality-gate.yaml"
ARTIFACTS = ROOT / "artifacts" / "quality-gate"


def load_contract() -> dict:
    # JSON is valid YAML 1.2 and keeps this runner dependency-free.
    try:
        return json.loads(CONTRACT.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"No existe el contrato: {CONTRACT}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"quality-gate.yaml debe contener YAML compatible con JSON: {exc}")


def run_check(check: dict, timeout: int) -> dict:
    command = check.get("command")
    started = time.monotonic()
    result = {
        "id": check["id"],
        "name": check.get("name", check["id"]),
        "required": bool(check.get("required", True)),
        "command": command,
        "status": "pending",
        "exit_code": None,
        "duration_seconds": 0.0,
        "stdout": "",
        "stderr": "",
    }
    if not command:
        result["status"] = "not_applicable" if not result["required"] else "blocked"
        result["duration_seconds"] = round(time.monotonic() - started, 3)
        return result
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            shell=True,
            text=True,
            capture_output=True,
            timeout=int(check.get("timeout", timeout)),
            env=os.environ.copy(),
        )
        result["exit_code"] = completed.returncode
        result["stdout"] = completed.stdout[-12000:]
        result["stderr"] = completed.stderr[-12000:]
        result["status"] = "passed" if completed.returncode == 0 else "failed"
    except subprocess.TimeoutExpired as exc:
        result["status"] = "failed"
        result["exit_code"] = 124
        result["stdout"] = (exc.stdout or "")[-12000:] if isinstance(exc.stdout, str) else ""
        result["stderr"] = f"Timeout after {check.get('timeout', timeout)} seconds"
    except OSError as exc:
        result["status"] = "failed"
        result["exit_code"] = 1
        result["stderr"] = str(exc)
    result["duration_seconds"] = round(time.monotonic() - started, 3)
    return result


def write_junit(results: list[dict]) -> None:
    suite = ET.Element("testsuite", name="dts-quality-gate", tests=str(len(results)))
    failures = 0
    skipped = 0
    for item in results:
        case = ET.SubElement(suite, "testcase", name=item["id"], time=str(item["duration_seconds"]))
        if item["status"] in {"failed", "blocked"}:
            failures += 1
            failure = ET.SubElement(case, "failure", message=item["status"])
            failure.text = item.get("stderr", "")
        elif item["status"] in {"pending", "not_applicable"}:
            skipped += 1
            ET.SubElement(case, "skipped", reason=item["status"])
    suite.set("failures", str(failures))
    suite.set("skipped", str(skipped))
    ET.ElementTree(suite).write(ARTIFACTS / "junit.xml", encoding="utf-8", xml_declaration=True)


def write_evidence(contract: dict, results: list[dict]) -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    passed = sum(item["status"] == "passed" for item in results)
    required_failures = [
        item for item in results
        if item["required"] and item["status"] not in {"passed", "not_applicable"}
    ]
    payload = {
        "project": contract.get("project", ROOT.name),
        "contract": str(CONTRACT.relative_to(ROOT)),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "status": "passed" if not required_failures else "blocked",
        "summary": {"total": len(results), "passed": passed, "required_failures": len(required_failures)},
        "checks": results,
    }
    (ARTIFACTS / "latest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [f"# Quality Gate — {payload['project']}", "", f"Estado: **{payload['status']}**", ""]
    for item in results:
        mark = "✅" if item["status"] == "passed" else "❌" if item["required"] else "⚪"
        lines.append(f"- {mark} `{item['id']}` — {item['status']} — exit {item['exit_code']}")
    if required_failures:
        lines += ["", "## Bloqueadores", ""]
        lines.extend(f"- `{item['id']}`: {item['status']}" for item in required_failures)
    (ARTIFACTS / "latest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    write_junit(results)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true", help="List declared checks without executing them")
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()
    contract = load_contract()
    checks = contract.get("checks", [])
    if not isinstance(checks, list) or not checks:
        raise SystemExit("El contrato debe declarar una lista checks no vacía")
    if args.list:
        for check in checks:
            print(f"{check['id']}\t{'required' if check.get('required', True) else 'optional'}\t{check.get('command') or 'manual/not-applicable'}")
        return 0
    results = [run_check(check, args.timeout) for check in checks]
    write_evidence(contract, results)
    print(json.dumps({"project": contract.get("project", ROOT.name), "status": "passed" if all(not r["required"] or r["status"] == "passed" for r in results) else "blocked", "checks": len(results)}, ensure_ascii=False))
    return 0 if all(not item["required"] or item["status"] == "passed" for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
