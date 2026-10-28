#!/usr/bin/env python3
"""Exercise annotation folding through the real Magpie/Bun host and MCP gateway.

Requires this package's source entries, Magpie, Bun, and Linux bubblewrap. A local
synthetic OpenAI-compatible provider records the real outgoing HTTP requests; no
external model is called. Historical assistant text and Read results are fixtures,
not claims that a model or an external file-reading tool performed those actions.
The real home is hidden by a temporary mount; HOME itself is left unchanged.
Missing dependencies are an error, never a passing or simulated host run.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


PROJECT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))
CAPACITY = 1_000_000
OUTPUT_RESERVED = 1000
BUDGET = re.compile(
    r"^<context-budget used_estimate=(\d+) capacity=(\d+|unknown) "
    r"output_reserved=(\d+) available_estimate=(\d+|unknown) "
    r"basis=json-utf8-bytes/4(?: scope=([a-f0-9]{64}))?\s*/>$"
)


def serialized(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


class Fixture:
    def __init__(self) -> None:
        self.upstream: list[dict] = []

    def handler(self) -> type[BaseHTTPRequestHandler]:
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def respond(self, status: int, value: object) -> None:
                data = serialized(value).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if self.path.endswith("/models"):
                    self.respond(200, {"object": "list", "data": [
                        {"id": "m1", "object": "model", "owned_by": "synthetic"},
                    ]})
                else:
                    self.respond(404, {"error": "synthetic endpoint not found"})

            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                if not self.path.endswith("/chat/completions"):
                    self.respond(404, {"error": "synthetic endpoint not found"})
                    return
                fixture.upstream.append(payload)
                self.respond(200, {
                    "id": "chatcmpl-synthetic", "object": "chat.completion",
                    "created": int(time.time()), "model": "m1",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "synthetic reply"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
                })

        return Handler


def request_json(url: str, payload: object | None = None, session: str = "host-smoke") -> dict:
    headers = {
        "Authorization": "Bearer magpie-codex", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream", "X-Magpie-Session": session,
    }
    request = Request(url, data=None if payload is None else serialized(payload).encode("utf-8"), headers=headers)
    try:
        with HTTP.open(request, timeout=20) as response:
            data = response.read().decode("utf-8")
    except HTTPError as error:
        raise AssertionError(f"HTTP {error.code} from isolated host: {error.read().decode(errors='replace')[:2000]}") from error
    if data.startswith("event:") or data.startswith("data:"):
        for line in data.splitlines():
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                result = json.loads(line[5:])
                if "result" in result or "error" in result:
                    return result
        raise AssertionError("MCP response contained no JSON-RPC result")
    return json.loads(data)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialized(value), encoding="utf-8")


def verify_budget(outgoing: dict, sent: dict) -> tuple[dict, str, dict]:
    """Check the actual wire request after allowing for Magpie's provider routing."""
    clean = copy.deepcopy(outgoing)
    hints = [item for item in clean["messages"] if item.get("role") == "system"
             and isinstance(item.get("content"), str) and BUDGET.fullmatch(item["content"])]
    assert len(hints) == 1, f"expected exactly one system budget, found {len(hints)}"
    match = BUDGET.fullmatch(hints[0]["content"])
    assert match is not None
    used, capacity, reserved, available, scope = match.groups()
    assert scope is not None, "callable recovery tool did not produce a session locator"
    assert int(capacity) == CAPACITY and int(reserved) == OUTPUT_RESERVED, "configured budget was not propagated"
    assert int(available) == max(0, CAPACITY - int(used) - OUTPUT_RESERVED), "remaining budget arithmetic changed"
    # The hook estimates the whole request, including its hint, before the host
    # changes fake/m1 to m1. All other request fields are checked by each scenario.
    assert outgoing["model"] == "m1", f"unexpected routed model: {outgoing['model']}"
    estimated = {**outgoing, "model": sent["model"]}
    expected = (len(serialized(estimated).encode("utf-8")) + 3) // 4
    assert int(used) == expected, f"budget is not self-inclusive: {used} != {expected}"
    clean["messages"].remove(hints[0])
    clean["model"] = sent["model"]
    assert clean["tools"] == sent["tools"], "client tool declarations changed"
    return clean, scope, {"usedEstimate": int(used), "availableEstimate": int(available)}


def advance(body: dict, message: str) -> dict:
    result = copy.deepcopy(body)
    result["messages"].extend([
        {"role": "assistant", "content": "synthetic reply"},
        {"role": "user", "content": message},
    ])
    return result


def run(magpie: Path, bun: Path, bwrap: Path, directory: Path, project: Path) -> None:
    fixture = Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    upstream = f"http://127.0.0.1:{server.server_port}"
    port = free_port()
    gateway = f"http://127.0.0.1:{port}"
    config, cache, home = (directory / name for name in ("config", "cache", "home"))
    home.mkdir()
    cache.mkdir()
    # Stop project configuration discovery at this isolated working directory.
    (directory / ".git").mkdir()
    write_json(config / "magpie" / "providers.json", {"providers": [{
        "id": "fake", "name": "Synthetic smoke provider", "key": "synthetic",
        "models": ["m1"], "chat": upstream + "/v1",
    }]})
    write_json(config / "magpie" / "plugins.json", {"plugins": [{
        "spec": str(project), "options": {
            "enabled": True, "delayRequests": 1, "maxSessionBytes": 64 * 1024 * 1024,
            "contextWindowTokens": CAPACITY, "reserveOutputTokens": OUTPUT_RESERVED,
        },
    }]})
    write_json(cache / "magpie" / "models.json", {"fake": {"id": "fake", "name": "Synthetic", "models": {
        "m1": {"id": "m1", "name": "Synthetic", "limit": {"context": CAPACITY, "output": OUTPUT_RESERVED}, "tool_call": True},
    }}})
    environment = dict(os.environ)
    environment.update({
        "XDG_CONFIG_HOME": str(config), "XDG_CACHE_HOME": str(cache),
        "XDG_DATA_HOME": str(directory / "data"), "XDG_STATE_HOME": str(directory / "state"),
        "XDG_RUNTIME_DIR": str(directory / "runtime"),
        "MAGPIE_ADDR": f"127.0.0.1:{port}", "MAGPIE_BUN": str(bun),
        "MAGPIE_NO_ACCOUNTS": "1", "MAGPIE_CONTEXT_FOLDING_STATE_DIR": str(directory / "folder-state"),
        "NO_COLOR": "1", "TMPDIR": str(directory / "tmp"),
    })
    for name in ("data", "state", "runtime", "tmp"):
        (directory / name).mkdir(mode=0o700)
    # Hide the actual home while retaining read access to this build and the
    # selected executables. This also protects against background maintenance.
    command = [
        str(bwrap), "--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/",
        "--proc", "/proc", "--dev", "/dev",
        "--bind", str(home), str(Path.home()),
        "--bind", str(directory), str(directory),
        "--ro-bind", str(project), str(project),
        "--ro-bind", str(bun), str(bun), "--ro-bind", str(magpie), str(magpie),
        "--chdir", str(directory), str(magpie), "serve",
    ]
    log_path = directory / "magpie.log"
    process: subprocess.Popen | None = None
    try:
        with log_path.open("wb") as log:
            process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise AssertionError(f"isolated Magpie exited with {process.returncode}")
                try:
                    request_json(gateway + "/v1/models")
                    break
                except (URLError, ConnectionError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise AssertionError("isolated Magpie did not start within 30 seconds")
                    time.sleep(0.1)

            rpc_id = 0

            def rpc(method: str, params: object) -> dict:
                nonlocal rpc_id
                rpc_id += 1
                reply = request_json(gateway + "/mcp/magpie/tools", {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params})
                assert "error" not in reply, f"MCP {method} failed: {reply.get('error')}"
                return reply["result"]

            tools = rpc("tools/list", {})["tools"]
            tool = next((item for item in tools if item["name"].endswith("_context_folding") or item["name"] == "context_folding"), None)
            assert tool is not None, f"context_folding missing from real MCP tools/list: {[item['name'] for item in tools]}"

            def call(arguments: dict, expect_error: bool = False) -> dict:
                reply = rpc("tools/call", {"name": tool["name"], "arguments": arguments})
                if reply.get("isError"):
                    assert expect_error, f"real MCP tool failed: {reply}"
                    return reply
                result = json.loads("".join(item.get("text", "") for item in reply.get("content", [])))
                assert bool(result.get("error")) == expect_error, f"unexpected real MCP tool result: {result}"
                return result

            def completions(metrics: dict) -> int:
                return sum(metrics.get(key, 0) for key in (
                    "successfulHookRequests", "failedHookRequests", "unverifiedHookRequests"))

            def send(body: dict, session: str = "host-smoke") -> tuple[dict, str, dict]:
                before = call({"action": "stats"})["metrics"]
                count = len(fixture.upstream)
                reply = request_json(gateway + "/v1/chat/completions", body, session)
                assert "synthetic reply" in serialized(reply), f"unexpected gateway reply: {reply}"
                assert len(fixture.upstream) == count + 1, "request did not reach synthetic upstream exactly once"
                output = verify_budget(fixture.upstream[-1], body)
                # Response hooks can finish after HTTP completion. Wait for their
                # write before the next archive mutation; do not mistake an
                # unverified host response for verified usage.
                deadline = time.monotonic() + 5
                while True:
                    after = call({"action": "stats"})["metrics"]
                    if completions(after) == completions(before) + 1:
                        assert after["failedHookRequests"] == before["failedHookRequests"], "host recorded a failed request"
                        break
                    assert time.monotonic() < deadline, f"response hook did not finish: {after}"
                    time.sleep(0.05)
                return output

            def read_all(scope: str, original: str) -> None:
                expected_hash = sha256(original)
                parts: list[str] = []
                offset = 0
                while True:
                    page = call({"scope": scope, "action": "read", "peek": True,
                                 "id": expected_hash[:12], "offset": offset, "limit": 5000})
                    assert page["id"] == expected_hash and page["sha256"] == expected_hash, "content hash changed"
                    assert page["offset"] == offset and page["totalChars"] == utf16_length(original), "read pagination metadata changed"
                    assert page["kept"] is False, "peek changed persistent expansion"
                    parts.append(page["text"])
                    following = page.get("nextOffset")
                    if following is None:
                        assert offset + utf16_length(page["text"]) == utf16_length(original)
                        break
                    assert following == offset + utf16_length(page["text"]) and following > offset, "read pagination did not progress"
                    offset = following
                # A UTF-16 page boundary may split a surrogate pair; concatenate
                # units before decoding so exact Unicode text is still verified.
                restored = "".join(parts).encode("utf-16-le", errors="surrogatepass").decode("utf-16-le")
                assert restored.encode("utf-8") == original.encode("utf-8"), "read did not restore exact archived bytes"

            declarations = [
                {"type": "function", "function": {"name": tool["name"], "description": tool.get("description", ""), "parameters": tool["inputSchema"]}},
                {"type": "function", "function": {"name": "exec", "description": "Synthetic history only", "parameters": {"type": "object", "properties": {"code": {"type": "string"}}}}},
                {"type": "function", "function": {"name": "read", "description": "Synthetic Read history only", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}},
            ]
            first_part = "Beginning of completed research.\r\n" + "".join(
                f"middle-evidence-{i:04d}: punctuation and CRLF; 原文必须可逆恢复。😀\r\n"
                for i in range(600)
            )
            last_part = "Final result: three synthetic checks passed."
            original = first_part + last_part
            prefix = "Visible planning note.\n@context-fold begin research\n"
            suffix = "\n@context-fold end research\nVisible conclusion."
            generic_result = "@context-fold begin tool-data\n" + "Generic tool bytes remain visible.\n" * 100 + "@context-fold end tool-data"
            opening = {"model": "fake/m1", "stream": False, "tools": declarations, "messages": [
                {"role": "system", "content": "Synthetic system instruction; preserve exactly."},
                {"role": "user", "content": "Opening request.\n@context-fold begin user-data\nUser instructions remain visible.\n@context-fold end user-data"},
                {"role": "assistant", "content": "Large unmarked assistant text remains visible.\n" * 100},
                {"role": "assistant", "content": prefix + first_part, "tool_calls": [{
                    "id": "exec-1", "type": "function", "function": {
                        "name": "exec", "arguments": serialized({"code": "@context-fold begin argument\nliteral argument\n@context-fold end argument"}),
                    },
                }]},
                {"role": "tool", "tool_call_id": "exec-1", "content": generic_result},
            ]}
            open_output, scope, _ = send(opening)
            assert open_output == opening, "an unfinished annotation changed the request"
            closed = copy.deepcopy(opening)
            closed["messages"].extend([
                {"role": "assistant", "content": last_part + suffix},
                {"role": "user", "content": "The annotation is now closed."},
            ])
            first, first_scope, first_budget = send(closed)
            assert first_scope == scope and first == closed, "first closed observation did not keep its grace period"
            retry, retry_scope, _ = send(closed)
            assert retry_scope == scope and retry == closed, "an identical retry consumed the grace period"
            advanced = advance(closed, "A distinct request after the completed work.")
            folded, folded_scope, folded_budget = send(advanced)
            reference = f"[[cf:v2:{sha256(original)[:12]}]]"
            expected = copy.deepcopy(advanced)
            expected["messages"][3]["content"] = prefix + reference
            expected["messages"][5]["content"] = reference + suffix
            assert folded_scope == scope and folded == expected, "only annotated assistant text should change; tool structure and other text must survive"
            assert folded_budget["usedEstimate"] < first_budget["usedEstimate"], "fold did not reduce the outgoing estimate"
            repeated, _, _ = send(advanced)
            assert repeated == expected, "a repeated request changed the projection"
            projected = copy.deepcopy(fixture.upstream[-1])
            projected["model"] = "fake/m1"
            replayed, _, _ = send(projected)
            assert replayed == expected, "replaying a projected request duplicated the budget or re-folded a reference"
            status = call({"scope": scope, "action": "status"})
            assert status["entries"] == 1 and status["metrics"]["itemsFolded"] == 1, "retry created duplicate archives or folds"
            read_all(scope, original)
            call({"scope": "0" * 64, "action": "read", "peek": True, "id": sha256(original)[:12]}, expect_error=True)
            exported = directory / "original.txt"
            pasted = call({"scope": scope, "action": "paste", "peek": True, "id": sha256(original)[:12], "path": str(exported)})
            assert exported.read_bytes() == original.encode("utf-8"), "paste changed original bytes"
            assert pasted["sha256"] == sha256(original) and "text" not in pasted, "paste metadata changed"
            call({"scope": scope, "action": "paste", "peek": True, "id": sha256(original)[:12], "path": str(exported)}, expect_error=True)
            assert exported.read_bytes() == original.encode("utf-8"), "paste overwrote an existing file"
            kept = call({"scope": scope, "action": "read", "id": sha256(original)[:12], "limit": 1})
            assert kept["kept"] is True, "read did not persist expansion"
            assert send(advanced)[0] == advanced, "read did not expand all slices of the original"
            later = advance(advanced, "Another request must keep recovered text visible.")
            assert send(later)[0] == later, "recovered text folded again on a later request"
            other, other_scope, _ = send(closed, "host-smoke-other")
            assert other_scope != scope and other == closed, "session isolation or new-session grace failed"
            other_folded, _, _ = send(advanced, "host-smoke-other")
            assert other_folded == expected, "persistent expansion leaked across sessions"

            source_path = directory / "worker.ts"
            source_payload = "\r\n".join(f'  perform("中文😀", {index});' for index in range(100))
            source_text = "// @context-fold begin worker\r\n" + source_payload + "\r\n// @context-fold end worker\r\n"
            source_path.write_bytes(source_text.encode("utf-8"))

            def source_body(text: str, call_id: str) -> dict:
                return {"model": "fake/m1", "stream": False, "tools": declarations, "messages": [
                    {"role": "user", "content": "Inspect the synthetic source view."},
                    {"role": "assistant", "content": "Reading source.", "tool_calls": [{
                        "id": call_id, "type": "function", "function": {"name": "read", "arguments": serialized({"path": str(source_path)})},
                    }]},
                    {"role": "tool", "tool_call_id": call_id, "content": text},
                    {"role": "user", "content": "Continue."},
                ]}

            source_input = source_body(source_text, "read-1")
            source_first, source_scope, _ = send(source_input, "host-smoke-source")
            assert source_first == source_input
            assert send(source_input, "host-smoke-source")[0] == source_input, "Read retry consumed the grace period"
            source_next = advance(source_input, "Review the annotated source next.")
            source_expected = copy.deepcopy(source_next)
            source_expected["messages"][2]["content"] = source_text.replace(source_payload, f"[[cf:v2:{sha256(source_payload)[:12]}]]")
            assert send(source_next, "host-smoke-source")[0] == source_expected, "source comments did not use the same hash and delay contract"
            assert source_path.read_bytes() == source_text.encode("utf-8"), "folding changed the source file"
            fresh = source_body(source_text, "read-2")
            assert send(fresh, "host-smoke-source")[0] == fresh, "old hash hid a fresh Read occurrence immediately"
            changed_payload = source_payload.replace("perform", "changed_perform", 1)
            changed_text = source_text.replace(source_payload, changed_payload)
            source_path.write_bytes(changed_text.encode("utf-8"))
            changed = source_body(changed_text, "read-3")
            assert send(changed, "host-smoke-source")[0] == changed
            changed_next = advance(changed, "Review the changed source next.")
            changed_expected = copy.deepcopy(changed_next)
            changed_expected["messages"][2]["content"] = changed_text.replace(changed_payload, f"[[cf:v2:{sha256(changed_payload)[:12]}]]")
            assert send(changed_next, "host-smoke-source")[0] == changed_expected, "source update did not receive a new content hash"
            assert source_path.read_bytes() == changed_text.encode("utf-8"), "folding changed updated source bytes"
            read_all(source_scope, source_payload)
            read_all(source_scope, changed_payload)
            unmarked = source_body(changed_payload, "read-4")
            assert send(unmarked, "host-smoke-source")[0] == unmarked
            unmarked_next = advance(unmarked, "Unmarked source must remain complete.")
            assert send(unmarked_next, "host-smoke-source")[0] == unmarked_next, "unmarked source was selected automatically"
            final_metrics = call({"action": "stats"})["metrics"]
            print(serialized({
                "result": "passed", "host": "real Magpie and Bun via bubblewrap",
                "provider": "local synthetic HTTP fixture; no external model was called",
                "checks": [
                    "MCP discovery and recovery", "open annotations stay visible", "first closed observation and identical retries stay visible",
                    "distinct requests fold explicit annotations", "short SHA-256 references retain marker lines", "system/user/unmarked text and tool calls/results remain intact",
                    "one self-inclusive budget with configured reserve", "projection replay does not duplicate budgets or archives",
                    "paginated byte-for-byte Unicode/CRLF recovery", "exclusive paste without text echo", "unknown scope refused",
                    "default read persistently expands all slices", "session isolation", "source comments share the protocol",
                    "fresh Read occurrence gets its own grace period", "changed source gets a new hash while old snapshots recover",
                    "source files remain unchanged by folding", "unmarked source stays visible",
                ],
                "upstreamRequests": len(fixture.upstream), "originalUtf8Bytes": len(original.encode("utf-8")),
                "firstBudget": first_budget, "foldedBudget": folded_budget,
                "responseHooks": {key: final_metrics[key] for key in (
                    "successfulHookRequests", "unverifiedHookRequests", "failedHookRequests")},
            }))
    except BaseException:
        if log_path.exists():
            print("Isolated Magpie log (synthetic fixtures only):\n" + log_path.read_text(errors="replace")[-6000:])
        raise
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("magpie", "bun", "bwrap"):
        parser.add_argument(f"--{name}", default=shutil.which(name), help=f"path to installed {name} executable (defaults to PATH)")
    parser.add_argument("--project", type=Path, default=PROJECT, help="installed package directory to exercise")
    arguments = parser.parse_args()
    if not __debug__:
        parser.error("run without Python -O; host assertions must remain enabled")
    executables = {}
    missing = []
    for name in ("magpie", "bun", "bwrap"):
        value = getattr(arguments, name)
        path = Path(value).expanduser().resolve() if value else None
        if path is None or not path.is_file() or not os.access(path, os.X_OK):
            missing.append(name)
        else:
            executables[name] = path
    if missing:
        parser.error("required executable(s) unavailable: " + ", ".join(missing)
                     + "; no host was run. Supply --magpie/--bun/--bwrap; no live configuration fallback is allowed")
    project = arguments.project.resolve()
    try:
        package = json.loads((project / "package.json").read_text(encoding="utf-8"))
        entries = [project / package["main"], project / package["magpie"]["hooks"]]
        if any(not entry.is_file() for entry in entries):
            raise ValueError("missing entry")
    except (OSError, ValueError, KeyError, TypeError):
        parser.error("package.json, package main, or Magpie hook entry is missing or invalid")
    with tempfile.TemporaryDirectory(prefix="magpie-context-folding-smoke-", dir=os.environ.get("TMPDIR")) as temporary:
        run(executables["magpie"], executables["bun"], executables["bwrap"], Path(temporary).resolve(), project)


if __name__ == "__main__":
    main()
