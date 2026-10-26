#!/usr/bin/env python3
"""Exercise the real Magpie/Bun host with synthetic HTTP and accounting only.

Requires the package's source entries, Magpie, Bun, and Linux bubblewrap. The accounting
fixture defines one serialized Unicode character as one token. Its prices and
certificates test the integration and never represent a provider's real bill.
The real home is hidden by a temporary mount; HOME itself is left unchanged.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
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


def serialized(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class Fixture:
    def __init__(self) -> None:
        self.upstream: list[dict] = []
        self.accounting: list[dict] = []
        self.refuse_saving = False
        self.cache_spread = True

    def handler(self) -> type[BaseHTTPRequestHandler]:
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def respond(self, status: int, value: object) -> None:
                data = serialized(value).encode()
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
                if self.path == "/accounting":
                    fixture.accounting.append(payload)
                    old_price = 0 if fixture.refuse_saving else (0.1 if fixture.cache_spread else 1)
                    new_price = 1.25 if fixture.cache_spread else 1
                    self.respond(200, {
                        "requestHash": payload["requestHash"],
                        "model": payload["model"],
                        "protocol": payload["protocol"],
                        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
                        "beforeLowerTokens": len(serialized(payload["before"])),
                        "afterUpperTokens": len(serialized(payload["after"])),
                        "oldMinPricePerMillion": old_price,
                        "newMaxPricePerMillion": new_price,
                        "extraCostUpperUsd": 0,
                        "assumptions": [
                            "SYNTHETIC ONLY: one serialized Unicode character is one billable token",
                            f"SYNTHETIC ONLY: old input minimum {old_price} and new input maximum {new_price} USD per million tokens",
                            "SYNTHETIC ONLY: no other input or accounting fee",
                        ],
                    })
                    return
                if self.path.endswith("/chat/completions"):
                    fixture.upstream.append(payload)
                    reply = {
                        "id": "chatcmpl-synthetic", "object": "chat.completion",
                        "created": int(time.time()), "model": "m1",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "synthetic reply"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
                    }
                    if payload.get("stream"):
                        events = [
                            {"id": reply["id"], "model": "m1", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "synthetic reply"}}]},
                            {"id": reply["id"], "model": "m1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": reply["usage"]},
                        ]
                        data = ("".join("data: " + serialized(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                    else:
                        self.respond(200, reply)
                    return
                self.respond(404, {"error": "synthetic endpoint not found"})

        return Handler


def request_json(url: str, payload: object | None = None, session: str = "host-smoke") -> dict:
    headers = {
        "Authorization": "Bearer magpie-codex", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream", "X-Magpie-Session": session,
    }
    request = Request(url, data=None if payload is None else serialized(payload).encode(), headers=headers)
    try:
        with HTTP.open(request, timeout=20) as response:
            data = response.read().decode()
    except HTTPError as error:
        raise AssertionError(f"HTTP {error.code} from isolated host: {error.read().decode()[:2000]}") from error
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
    path.write_text(serialized(value))


def run(magpie: Path, bun: Path, bwrap: Path, directory: Path, project: Path) -> None:
    fixture = Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    upstream = f"http://127.0.0.1:{server.server_port}"
    port = free_port()
    gateway = f"http://127.0.0.1:{port}"
    config = directory / "config"
    cache = directory / "cache"
    home = directory / "home"
    home.mkdir()
    cache.mkdir()
    write_json(config / "magpie" / "providers.json", {"providers": [{
        "id": "fake", "name": "Synthetic smoke provider", "key": "synthetic",
        "models": ["m1"], "chat": upstream + "/v1",
    }]})
    write_json(config / "magpie" / "plugins.json", {"plugins": [{
        "spec": str(project), "options": {
            "thresholdTokens": 32, "keepRecentMessages": 1, "headChars": 80,
            "minimumSavingUsd": 0.000001,
            "accounting": {"url": upstream + "/accounting", "timeoutMs": 2000},
        },
    }]})
    write_json(cache / "magpie" / "models.json", {"fake": {"id": "fake", "name": "Synthetic", "models": {
        "m1": {"id": "m1", "name": "Synthetic", "limit": {"context": 1_000_000, "output": 1000}, "tool_call": True},
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
    # Hide all actual agent homes, while retaining read access to this build and
    # Bun. This also protects against Magpie's background Codex maintenance.
    command = [
        str(bwrap), "--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/",
        "--proc", "/proc", "--dev", "/dev",
        "--bind", str(directory), str(directory),
        "--bind", str(home), str(Path.home()),
        "--ro-bind", str(project), str(project),
        "--ro-bind", str(bun), str(bun),
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
                if "error" in reply:
                    raise AssertionError(f"MCP {method} failed: {reply['error']}")
                return reply["result"]

            tools = rpc("tools/list", {})["tools"]
            tool = next((tool for tool in tools if tool["name"].endswith("_context_folding") or tool["name"] == "context_folding"), None)
            assert tool is not None, f"context_folding missing from real MCP tools/list: {[tool['name'] for tool in tools]}"

            def call(arguments: dict, expect_error: bool = False) -> dict:
                reply = rpc("tools/call", {"name": tool["name"], "arguments": arguments})
                text = "".join(item.get("text", "") for item in reply.get("content", []))
                if reply.get("isError"):
                    assert expect_error, f"real MCP tool failed: {reply}"
                    return reply
                result = json.loads(text)
                if expect_error:
                    assert result.get("error"), "unknown scope unexpectedly allowed archive access"
                else:
                    assert not result.get("error"), f"real MCP tool failed: {result}"
                return result

            original = "Beginning of an old assistant message.\n" + "".join(
                f"middle-evidence-{i:04d}: preserve every original byte, punctuation and line break; 原文必须可逆恢复。\n"
                for i in range(1800)
            ) + "Final result: three synthetic checks passed.\n"
            messages = [
                {"role": "system", "content": "Synthetic system instruction; preserve exactly."},
                {"role": "user", "content": "Opening request; preserve exactly."},
                {"role": "assistant", "content": original},
                {"role": "user", "content": "A later request."},
                {"role": "assistant", "content": "A later short answer."},
                {"role": "user", "content": "Current request; preserve exactly."},
            ]
            body = {"model": "fake/m1", "stream": False, "messages": messages, "tools": [{
                "type": "function", "function": {"name": tool["name"], "description": tool.get("description", ""), "parameters": tool["inputSchema"]},
            }]}

            def send(session: str = "host-smoke") -> dict:
                count = len(fixture.upstream)
                reply = request_json(gateway + "/v1/chat/completions", body, session)
                assert "synthetic reply" in serialized(reply), f"unexpected gateway reply: {reply}"
                assert len(fixture.upstream) == count + 1, "request did not reach the synthetic upstream exactly once"
                return fixture.upstream[-1]

            first = send()
            scope_match = re.search(r"scope=([a-f0-9]{64})", serialized(first))
            assert scope_match, "gateway hook did not append a scope guide"
            scope = scope_match.group(1)
            entries = call({"scope": scope, "action": "list"})["entries"]
            entry = next((entry for entry in entries if entry["role"] == "assistant" and entry["chars"] == len(original)), None)
            assert entry is not None, "historical assistant text was not inventoried"
            entry_id = entry["id"]
            summary = ("Final result: three synthetic checks passed. " + "The completed investigation verified synthetic data and retained its evidence. " * 18).strip()
            call({"scope": scope, "action": "mark", "marks": [{"id": entry_id, "disposition": "foldable", "summary": summary}]})
            folded = send()
            folded_text = serialized(folded)
            assert "middle-evidence-1000" not in folded_text, "marked historical assistant text was not folded"
            assert original[:80] in folded["messages"][2]["content"], "fold lost the opening excerpt"
            assert summary in folded_text, "fold lost the model-supplied summary"
            assert folded["messages"][0] == first["messages"][0], "system instruction changed"
            assert folded["messages"][1] == first["messages"][1], "opening request changed"
            assert folded["tools"] == first["tools"], "client tool declarations changed"
            assert folded["messages"][-1]["content"].startswith(messages[-1]["content"]), "current request changed"
            assert fixture.accounting, "fold bypassed the accounting certificate gate"

            # Magpie finishes response hooks asynchronously; wait for the actual
            # successful response rather than crediting the proposed fold.
            deadline = time.monotonic() + 5
            while True:
                folding_stats = call({"action": "stats"})
                if folding_stats["metrics"]["certifiedComparisons"] >= 1:
                    break
                assert time.monotonic() < deadline, f"successful response did not earn certified statistics: {folding_stats}"
                time.sleep(0.05)
            assert folding_stats["metrics"]["foldBatchesApproved"] == 1
            assert folding_stats["metrics"]["successfulFoldedRequests"] >= 1
            assert int(folding_stats["metrics"]["savingNanoUsdLower"]) > 0

            restored_parts: list[str] = []
            offset = 0
            expected_hash = hashlib.sha256(original.encode()).hexdigest()
            while True:
                page = call({"scope": scope, "action": "read", "id": entry_id, "offset": offset, "limit": 5000})
                assert page["offset"] == offset and page["totalChars"] == len(original), "read pagination metadata changed"
                assert page["sha256"] == expected_hash, "original archive digest changed"
                restored_parts.append(page["text"])
                following = page.get("nextOffset")
                if following is None:
                    break
                assert following > offset, "read pagination did not progress"
                offset = following
            assert "".join(restored_parts) == original, "read did not restore historical text byte for byte"
            call({"scope": "0" * 64, "action": "read", "id": entry_id}, expect_error=True)
            pasted_path = directory / "pasted-original.txt"
            pasted = call({"scope": scope, "action": "paste", "id": entry_id, "path": str(pasted_path)})
            assert pasted_path.read_text() == original, "paste did not write the full original"
            assert pasted["sha256"] == expected_hash and "text" not in pasted, "paste metadata leaked or changed text"
            assert pasted["bytes"] == len(original.encode()), "paste byte count changed"
            call({"scope": scope, "action": "paste", "id": entry_id, "path": str(pasted_path)}, expect_error=True)
            assert pasted_path.read_text() == original, "paste overwrote an existing file"

            # An equal-price synthetic tariff allows a second, smaller fold to
            # pass without pretending that mild compaction offsets deep cache
            # discounts. This phase tests the recursive layer mechanism only.
            fixture.cache_spread = False
            current = call({"scope": scope, "action": "read", "id": entry_id, "limit": 1})
            first_layer_id = current["currentLayer"]
            assert first_layer_id != "original", "first fold was not saved as a layer"
            shorter_summary = "Final result: three synthetic checks passed."
            call({"scope": scope, "action": "mark", "marks": [{"id": entry_id, "disposition": "foldable", "summary": shorter_summary}]})
            second = send()
            assert len(second["messages"][2]["content"]) < len(folded["messages"][2]["content"]), "second summary did not produce a smaller fold"
            current = call({"scope": scope, "action": "read", "id": entry_id, "limit": 1})
            second_layer_id = current["currentLayer"]
            assert second_layer_id not in ("original", first_layer_id), "second fold did not create its own layer"
            second_layer = call({"scope": scope, "action": "read", "id": entry_id, "layer": second_layer_id})
            assert second_layer["text"] == second["messages"][2]["content"], "current layer did not match the second outgoing fold"
            assert second_layer["previousId"] == first_layer_id, "second layer did not point to the preceding fold"
            first_layer = call({"scope": scope, "action": "read", "id": entry_id, "layer": second_layer["previousId"]})
            assert first_layer["text"] == folded["messages"][2]["content"], "intermediate fold was not recoverable"
            assert first_layer["previousId"] == "original", "intermediate layer did not link back to the original"
            original_page = call({"scope": scope, "action": "read", "id": entry_id, "layer": first_layer["previousId"], "limit": 100})
            assert original_page["text"] == original[:100] and original_page["previousId"] is None, "recursive traversal did not reach the original"
            send()
            repeated = next(entry for entry in call({"scope": scope, "action": "list"})["entries"] if entry["id"] == entry_id)
            assert [layer["id"] for layer in repeated["layers"]] == [first_layer_id, second_layer_id], "unchanged repeated request created duplicate layers"

            call({"scope": scope, "action": "mark", "marks": [{"id": entry_id, "disposition": "keep"}]})
            kept = send()
            assert kept["messages"][2]["content"] == original, "keep did not restore the original outgoing text"
            fixture.refuse_saving = True
            call({"scope": scope, "action": "mark", "marks": [{"id": entry_id, "disposition": "foldable", "summary": "Unique synthetic rejection summary."}]})
            denied = send()
            assert denied["messages"][2]["content"] == original, "non-positive savings certificate still allowed folding"
            status = call({"scope": scope, "action": "status"})
            other = send("host-smoke-other-session")
            other_scope = re.search(r"scope=([a-f0-9]{64})", serialized(other))
            assert other_scope and other_scope.group(1) != scope, "different sessions shared an archive scope"
            assert other["messages"][2]["content"] == original, "a mark leaked into another session"
            print(serialized({
                "result": "passed", "host": "real Magpie and Bun", "billing": "SYNTHETIC_ACCOUNTING_ONLY",
                "checks": ["MCP discovery", "historical assistant mark and automatic fold", "opening and summary retained", "protected messages and tools retained", "successful-response lifetime statistics", "paginated byte-for-byte read", "paste full original to new file without echo or overwrite", "unknown scope refused", "two folds recursively unfold to original", "unchanged requests do not duplicate layers", "keep restores outgoing original", "unprofitable fold refused", "session isolation"],
                "originalChars": len(original), "foldedChars": len(folded["messages"][2]["content"]),
                "accountingRequests": len(fixture.accounting), "status": status,
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
    parser.add_argument("--magpie", default=shutil.which("magpie"))
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--bwrap", default=shutil.which("bwrap"))
    parser.add_argument("--project", type=Path, default=PROJECT, help="installed package directory to exercise")
    arguments = parser.parse_args()
    project = arguments.project.resolve()
    for name in ("magpie", "bun", "bwrap"):
        if not getattr(arguments, name):
            parser.error(f"{name} is required; no live configuration will be used as a fallback")
    package = json.loads((project / "package.json").read_text())
    if not (project / package["main"]).exists() or not (project / package["magpie"]["hooks"]).exists():
        parser.error("package main or Magpie hook entry is missing")
    with tempfile.TemporaryDirectory(prefix="magpie-context-folding-smoke-") as temporary:
        run(Path(arguments.magpie).resolve(), Path(arguments.bun).resolve(), Path(arguments.bwrap).resolve(), Path(temporary), project)


if __name__ == "__main__":
    main()
