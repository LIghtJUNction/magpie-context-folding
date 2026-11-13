#!/usr/bin/env python3
"""Exercise annotation folding through the real Magpie/Bun host and local CLI.

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
GUIDANCE = re.compile(r"^<context-folding>.*</context-folding>$", re.DOTALL)


def serialized(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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
    return json.loads(data)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialized(value), encoding="utf-8")


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
            "minSavingsTokens": 9007199254740991,
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

            archive = directory / "folder-state" / "archive"

            def cli(*arguments: str) -> str:
                completed = subprocess.run(
                    [str(bun), str(project / "dist" / "cli.js"), *arguments, "--dir", str(archive)],
                    env=environment, cwd=directory, check=False, capture_output=True,
                )
                assert completed.returncode == 0, completed.stderr
                return completed.stdout.decode("utf-8")

            def send(body: dict, session: str = "host-smoke") -> dict:
                count = len(fixture.upstream)
                reply = request_json(gateway + "/v1/chat/completions", body, session)
                assert "synthetic reply" in serialized(reply), reply
                assert len(fixture.upstream) == count + 1
                outgoing = copy.deepcopy(fixture.upstream[-1])
                hints = [item for item in outgoing["messages"] if item.get("role") == "system"
                         and GUIDANCE.fullmatch(str(item.get("content", "")))]
                assert len(hints) == 1, "expected exactly one folding guide"
                assert "→ 不折叠开始" in hints[0]["content"], "missing literal-example guide"
                assert "--scope" not in hints[0]["content"], "obsolete CLI guidance"
                outgoing["messages"].remove(hints[0])
                outgoing["model"] = body["model"]
                assert outgoing["tools"] == body["tools"]
                return outgoing

            island = "→ 不折叠开始\n>> Literal example <<\nKeep request_id=42.\n<< Literal result >>\n← 不折叠结束\n"
            original = "before evidence 中文🙂\r\n" * 500 + island + "after evidence 中文🙂\r\n" * 500
            marked = ">> Investigating <<\n" + original + "\n<< Verified >>"
            body = {"model": "fake/m1", "stream": False,
                    "tools": [{"type": "function", "function": {"name": "arbitrary_host_wrapper", "parameters": {"type": "object"}}}],
                    "messages": [{"role": "user", "content": "Review the evidence."},
                                 {"role": "assistant", "content": marked},
                                 {"role": "user", "content": "Continue."}]}
            before = copy.deepcopy(body)
            assert send(body) == body, "first observation must retain the grace request"
            assert send(body) == body, "identical retry consumed the grace request"
            advanced = advance(body, "A distinct next question.")
            output = send(advanced)
            text = output["messages"][1]["content"]
            assert island in text, "keep island changed"
            assert "before evidence" not in text and "after evidence" not in text
            assert text.endswith("...\n<< Verified >>"), "folded body must use dots"
            path = Path(re.search(r"^path:(.+)$", text, re.MULTILINE)[1].rstrip("\r"))
            assert path == archive / (sha256(original) + ".txt")
            assert path.read_bytes() == original.encode("utf-8"), "complete original differs"
            assert cli("read", sha256(original)[:12]).encode("utf-8") == original.encode("utf-8")
            stats = json.loads(cli("stats"))
            assert stats["files"] == 1 and stats["bytes"] == len(original.encode("utf-8"))
            listing = json.loads(cli("list", "--sort", "size"))
            assert listing[0]["hash"] == sha256(original)
            assert ":" in cli("search", "request_id=42")
            assert send(output) == output, "projection replay changed the wire history"
            literal = copy.deepcopy(body)
            literal["messages"][1]["content"] = "→ 不折叠开始\n" + marked + "\n← 不折叠结束"
            assert send(literal, "literal-example") == literal
            assert send(advance(literal, "Another turn."), "literal-example") == advance(literal, "Another turn.")
            assert body == before, "caller history mutated"
            tiny = copy.deepcopy(body)
            tiny["messages"][1]["content"] = ">> Small closed note <<\nx\n<< Verified >>"
            assert send(tiny, "tiny-closed-note") == tiny, "configured grace must still apply"
            tiny_output = send(advance(tiny, "Next request."), "tiny-closed-note")
            tiny_text = tiny_output["messages"][1]["content"]
            assert "\n...\n<< Verified >>" in tiny_text, "tiny closed note was rejected by a size gate"
            tiny_path = Path(re.search(r"^path:(.+)$", tiny_text, re.MULTILINE)[1])
            assert tiny_path.read_text(encoding="utf-8") == "x"
            assert cli("read", sha256("x")) == "x"
            assert send(tiny_output, "tiny-closed-note") == tiny_output
            preview = json.loads(cli("clean", sha256(original)))
            assert not preview["applied"] and path.exists()
            removed = json.loads(cli("clean", sha256(original), "--apply"))
            assert removed["applied"] and not path.exists()
            print(serialized({
                "result": "passed", "host": "real Magpie and Bun via bubblewrap",
                "provider": "local synthetic HTTP fixture; no external model was called",
                "upstreamRequests": len(fixture.upstream), "originalUtf8Bytes": len(original.encode("utf-8")),
                "checks": ["folding independent of shell tool names", "grace and identical retry", "dots projection", "literal islands",
                           "full original SHA-256 file", "built CLI read/stats/list/search/clean",
                           "projection replay", "protected examples", "caller history unchanged",
                           "tiny closed note ignores legacy token threshold"],
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
        entries = [project / package["main"], project / package["magpie"]["hooks"], project / package["bin"]["magpie-context-folding"]]
        if any(not entry.is_file() for entry in entries):
            raise ValueError("missing entry")
    except (OSError, ValueError, KeyError, TypeError):
        parser.error("package.json, package main, or Magpie hook entry is missing or invalid")
    with tempfile.TemporaryDirectory(prefix="magpie-context-folding-smoke-", dir=os.environ.get("TMPDIR")) as temporary:
        run(executables["magpie"], executables["bun"], executables["bwrap"], Path(temporary).resolve(), project)


if __name__ == "__main__":
    main()
