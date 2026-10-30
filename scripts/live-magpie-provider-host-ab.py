#!/usr/bin/env python3
"""Compare one real provider completion per arm through isolated Magpie hosts.

Uses ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN (or the HARBOR_MODEL_* pair),
with separate temporary Magpie hosts for observe-only baseline and folding.
The two seed completions per arm use a local fixture; only the measured final
turn reaches the provider. Provider address and credentials are never written
to the result file or printed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


PROJECT = Path(__file__).resolve().parents[1]
HTTP = build_opener(ProxyHandler({}))
UPSTREAM_HTTP = build_opener()
MODEL = os.environ.get("MAGPIE_SOURCE_READ_BENCH_MODEL", "claude-sonnet-5")
READ_TOOL = {
    "type": "function",
    "function": {
        "name": "Read",
        "description": "Read a complete UTF-8 source file.",
        "parameters": {
            "type": "object",
            "properties": {"absolutePath": {"type": "string"}},
            "required": ["absolutePath"],
            "additionalProperties": False,
        },
    },
}
SHELL_TOOL = {
    "type": "function",
    "function": {
        "name": "exec_command",
        "description": "Execute a shell command.",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "required": ["cmd"],
        },
    },
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request_json(url: str, payload: object | None = None, session: str = "host-provider-ab") -> dict:
    headers = {
        "Authorization": "Bearer magpie-codex",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Magpie-Session": session,
    }
    request = Request(url, data=None if payload is None else json.dumps(payload).encode(), headers=headers)
    try:
        with HTTP.open(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"magpie_gateway_http_{error.code}") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise RuntimeError("magpie_gateway_request_failed") from None


def cli_stats(bun: Path, env: dict[str, str], cwd: Path) -> dict:
    result = subprocess.run(
        [str(bun), str(PROJECT / "src" / "cli.ts"), "stats", "--json"],
        env=env, cwd=cwd, capture_output=True, text=True, timeout=20,
    )
    if result.returncode != 0:
        raise RuntimeError("plugin_stats_failed")
    return json.loads(result.stdout)


def stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def provider_chat_base(raw: str) -> str:
    url = urlsplit(raw)
    loopback = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (url.username or url.password or url.query or url.fragment
            or (url.scheme != "https" and not (loopback and url.scheme == "http"))):
        raise RuntimeError("provider_route_invalid")
    path = url.path.rstrip("/")
    if not path.endswith("/v1"):
        path += "/v1"
    return urlunsplit((url.scheme, url.netloc, path, "", ""))


class ProviderProxy:
    """Seed one Read interaction locally, then forward the measured turn."""

    def __init__(self, external_endpoint: str, api_key: str, source_path: Path) -> None:
        self.external_endpoint = external_endpoint
        self.api_key = api_key
        self.source_path = source_path
        self.requests: list[dict] = []
        self.external_body: dict | None = None
        self.external_reply: dict | None = None
        self.error: str | None = None
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                return

            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": [{"id": MODEL, "object": "model"}]}).encode())

            def do_POST(self) -> None:
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                    proxy.requests.append(body)
                    if len(proxy.requests) == 1:
                        tool_call = {"id": "read-source", "type": "function", "function": {
                            "name": "Read", "arguments": json.dumps({"absolutePath": str(proxy.source_path)}),
                        }}
                        result = proxy.reply(body, {"role": "assistant", "content": None,
                                                   "tool_calls": [tool_call]}, "tool_calls")
                    elif len(proxy.requests) == 2:
                        result = proxy.reply(body, {"role": "assistant",
                                                   "content": "calculate(value) multiplies by 29 and adds 13."}, "stop")
                    elif len(proxy.requests) == 3:
                        proxy.external_body = body
                        outgoing = Request(
                            proxy.external_endpoint,
                            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                            headers={"Authorization": f"Bearer {proxy.api_key}",
                                     "Content-Type": "application/json"},
                        )
                        with UPSTREAM_HTTP.open(outgoing, timeout=60) as response:
                            result = json.loads(response.read().decode("utf-8"))
                        proxy.external_reply = result
                    else:
                        proxy.error = "unexpected_extra_completion"
                        self.send_error(429)
                        return
                    encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except HTTPError as error:
                    proxy.error = f"provider_http_{error.code}"
                    self.send_error(502)
                except (OSError, ValueError, URLError, TimeoutError):
                    proxy.error = "provider_forward_failed"
                    self.send_error(502)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.chat_base = f"http://127.0.0.1:{self.server.server_port}/v1"

    @staticmethod
    def reply(body: dict, message: dict, finish_reason: str) -> dict:
        return {
            "id": "chatcmpl-local-seed", "object": "chat.completion", "created": 1,
            "model": body.get("model", MODEL),
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10},
        }

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def make_source() -> tuple[str, str]:
    payload = "export function calculate(value: number): number { return value * 29 + 13; }\n"
    payload += "".join(
        f"// synthetic retained source line {index:04d}: stable context for the provider input comparison.\n"
        for index in range(360)
    )
    return payload, f"// @context-fold begin worker.ts\n{payload}// @context-fold end worker.ts\n"


def iter_strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from iter_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from iter_strings(item)


def run_arm(mode: str, magpie: Path, bun: Path, bwrap: Path, api_key: str,
            external_endpoint: str, payload: str, marked_source: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="magpie-live-provider-host-") as temporary:
        root = Path(temporary).resolve()
        cwd = root / "cwd"
        config, cache, home = (root / name for name in ("config", "cache", "home"))
        for directory in (cwd, config / "magpie", cache / "magpie", home):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ("data", "state", "runtime", "tmp", "folder-state"):
            (root / name).mkdir(mode=0o700)

        source_path = cwd / "worker.ts"
        source_path.write_text(marked_source, encoding="utf-8", newline="")
        source_path.chmod(0o600)
        fixture = ProviderProxy(external_endpoint, api_key, source_path)
        plugin_options = {
            "enabled": True,
            "observeOnly": mode == "baseline",
            "delayRequests": 1,
            "minSavingsTokens": 256,
            "maxSessionBytes": 64 * 1024 * 1024,
        }
        write_json(config / "magpie" / "providers.json", {"providers": [{
            "id": "host-ab", "name": "Isolated provider comparison", "key": "synthetic",
            "models": [MODEL], "chat": fixture.chat_base,
        }]})
        write_json(config / "magpie" / "plugins.json", {"plugins": [{
            "spec": str(PROJECT), "options": plugin_options,
        }]})
        write_json(cache / "magpie" / "models.json", {"host-ab": {
            "id": "host-ab", "name": "Isolated provider comparison", "models": {
                MODEL: {"id": MODEL, "name": MODEL,
                        "limit": {"context": 1_000_000, "output": 1024}, "tool_call": True},
            },
        }})

        port = free_port()
        gateway = f"http://127.0.0.1:{port}"
        state_dir = root / "folder-state"
        env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TZ")
               if name in os.environ}
        env.update({
            "HOME": str(Path.home()),
            "XDG_CONFIG_HOME": str(config), "XDG_CACHE_HOME": str(cache),
            "XDG_DATA_HOME": str(root / "data"), "XDG_STATE_HOME": str(root / "state"),
            "XDG_RUNTIME_DIR": str(root / "runtime"), "TMPDIR": str(root / "tmp"),
            "MAGPIE_ADDR": f"127.0.0.1:{port}", "MAGPIE_BUN": str(bun),
            "MAGPIE_NO_ACCOUNTS": "1", "MAGPIE_CONTEXT_FOLDING_STATE_DIR": str(state_dir),
            "NO_COLOR": "1", "NO_PROXY": "127.0.0.1,localhost,::1",
            "no_proxy": "127.0.0.1,localhost,::1",
        })
        command = [
            str(bwrap), "--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/",
            "--proc", "/proc", "--dev", "/dev",
            "--bind", str(home), str(Path.home()), "--bind", str(root), str(root),
            "--ro-bind", str(PROJECT), str(PROJECT), "--ro-bind", str(bun), str(bun),
            "--ro-bind", str(magpie), str(magpie), "--chdir", str(cwd), str(magpie), "serve",
        ]
        log_path = root / "magpie.log"
        process: subprocess.Popen | None = None
        try:
            with log_path.open("wb") as log:
                process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                deadline = time.monotonic() + 30
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"isolated_magpie_exited_{process.returncode}")
                    try:
                        request_json(gateway + "/v1/models")
                        break
                    except (RuntimeError, URLError, TimeoutError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("isolated_magpie_start_timeout")
                        time.sleep(0.1)

                body = {
                    "model": f"host-ab/{MODEL}", "stream": False, "temperature": 0,
                    "max_tokens": 64, "tools": [SHELL_TOOL, READ_TOOL],
                    "messages": [
                        {"role": "system", "content": "Do not call tools. Answer follow-up questions accurately and concisely."},
                        {"role": "user", "content": f"Read and summarize {source_path}. Use the Read tool."},
                    ],
                }
                first = request_json(gateway + "/v1/chat/completions", body, f"host-ab-{mode}")
                first_message = (first.get("choices") or [{}])[0].get("message") or {}
                first_calls = first_message.get("tool_calls") or []
                if len(first_calls) != 1 or first_calls[0].get("function", {}).get("name") != "Read":
                    raise RuntimeError("synthetic_read_seed_invalid")
                try:
                    read_args = json.loads(first_calls[0]["function"]["arguments"])
                except (KeyError, TypeError, json.JSONDecodeError):
                    raise RuntimeError("synthetic_read_arguments_invalid") from None
                if Path(read_args.get("absolutePath", "")).resolve() != source_path.resolve():
                    raise RuntimeError("synthetic_read_path_mismatch")
                body["messages"].append(first_message)
                body["messages"].append({
                    "role": "tool", "tool_call_id": first_calls[0]["id"],
                    "content": source_path.read_text(encoding="utf-8"),
                })
                second = request_json(gateway + "/v1/chat/completions", body, f"host-ab-{mode}")
                second_message = (second.get("choices") or [{}])[0].get("message") or {}
                if not isinstance(second_message.get("content"), str):
                    raise RuntimeError("synthetic_source_answer_invalid")
                body["messages"].append(second_message)
                body["messages"].append({
                    "role": "user", "content": "What is 17 * 23? Reply with only the integer.",
                })
                reply = request_json(gateway + "/v1/chat/completions", body, f"host-ab-{mode}")

                message = (reply.get("choices") or [{}])[0].get("message") or {}
                answer = message.get("content") if isinstance(message.get("content"), str) else ""
                usage = reply.get("usage") or {}
                prompt_usage = usage.get("prompt_tokens_details") or {}
                input_usage = usage.get("input_tokens_details") or {}
                deadline = time.monotonic() + 8
                stats = cli_stats(bun, env, cwd)
                metrics = stats.get("metrics") or {}
                expected = "observeOnlySuccessfulRequests" if mode == "baseline" else "successfulFoldedRequests"
                while metrics.get(expected, 0) < 1 and time.monotonic() < deadline:
                    time.sleep(0.1)
                    stats = cli_stats(bun, env, cwd)
                    metrics = stats.get("metrics") or {}

                outgoing = fixture.external_body
                outgoing_json = json.dumps(outgoing, ensure_ascii=False, separators=(",", ":")) if outgoing else ""
                outgoing_text = "\n".join(iter_strings(outgoing)) if outgoing else ""
                reference_present = bool(re.search(r"\[\[cf:v2:[a-f0-9]{12}\]\]", outgoing_text))
                source_payload_present = marked_source in outgoing_text
                expected_hook = "observeOnlySuccessfulRequests" if mode == "baseline" else "successfulHookRequests"
                hook_confirmed = metrics.get(expected_hook, 0) >= 1
                fold_confirmed = metrics.get("successfulFoldedRequests", 0) >= 1 and metrics.get("itemsFolded", 0) >= 1
                host_diagnostic = None
                if not hook_confirmed or (mode == "folding" and not fold_confirmed):
                    raw_log = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
                    parsed_base = urlsplit(external_endpoint)
                    for secret in (api_key, external_endpoint, f"{parsed_base.scheme}://{parsed_base.netloc}"):
                        if secret:
                            raw_log = raw_log.replace(secret, "[redacted]")
                    raw_log = re.sub(r"https?://\S+", "[redacted-url]", raw_log)
                    host_diagnostic = raw_log[-2000:]

                return {
                    "mode": mode,
                    "answer": answer.strip(),
                    "answer_correct": answer.strip() == "391",
                    "hook_confirmed": hook_confirmed,
                    "fold_confirmed": fold_confirmed,
                    "synthetic_seed_completions": 2,
                    "measured_provider_completions": fixture.external_reply is not None,
                    "provider_usage": {
                        "input_tokens": usage.get("prompt_tokens"),
                        "output_tokens": usage.get("completion_tokens"),
                        "total_tokens": usage.get("total_tokens"),
                        "cached_input_tokens": prompt_usage.get("cached_tokens")
                        or input_usage.get("cached_tokens") or usage.get("cache_read_input_tokens"),
                        "cache_write_input_tokens": prompt_usage.get("cache_write_tokens")
                        or input_usage.get("cache_write_tokens") or usage.get("cache_creation_input_tokens"),
                    },
                    "provider_wire": {
                        "request_json_bytes": len(outgoing_json.encode("utf-8")),
                        "full_source_payload_present": source_payload_present,
                        "fold_reference_present": reference_present,
                    },
                    "hook_metrics": {key: metrics.get(key, 0) for key in (
                        "observeOnlySuccessfulRequests", "successfulHookRequests",
                        "successfulFoldedRequests", "foldBatchesApproved", "itemsFolded",
                        "guidanceSuppressedRequests", "unverifiedHookRequests", "failedHookRequests")},
                    "provider_error": fixture.error,
                    **({"sanitized_host_diagnostic": host_diagnostic} if host_diagnostic else {}),
                }
        finally:
            stop(process)
            fixture.close()

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--magpie", default=shutil.which("magpie"))
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--bwrap", default=shutil.which("bwrap"))
    args = parser.parse_args()

    missing = [name for name in ("magpie", "bun", "bwrap") if not getattr(args, name)]
    if missing:
        parser.error("missing required executable(s): " + ", ".join(missing))
    base = os.environ.get("HARBOR_MODEL_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL")
    api_key = os.environ.get("HARBOR_MODEL_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not base or not api_key:
        parser.error("provider route credentials are not available in environment")

    magpie = Path(args.magpie).resolve()
    bun = Path(args.bun).resolve()
    bwrap = Path(args.bwrap).resolve()
    external_endpoint = provider_chat_base(base) + "/chat/completions"
    payload, marked_source = make_source()
    baseline = run_arm("baseline", magpie, bun, bwrap, api_key, external_endpoint, payload, marked_source)
    folding = run_arm("folding", magpie, bun, bwrap, api_key, external_endpoint, payload, marked_source)
    baseline_tokens = baseline["provider_usage"]["input_tokens"]
    folding_tokens = folding["provider_usage"]["input_tokens"]
    baseline_wire = baseline["provider_wire"]
    folding_wire = folding["provider_wire"]
    folded = bool(folding["fold_confirmed"] and folding_wire["fold_reference_present"]
                  and not folding_wire["full_source_payload_present"])
    baseline_unfolded = bool(baseline_wire["full_source_payload_present"]
                             and not baseline_wire["fold_reference_present"])
    usage_available = isinstance(baseline_tokens, int) and isinstance(folding_tokens, int)
    valid = bool(baseline["answer_correct"] and folding["answer_correct"]
                 and baseline["hook_confirmed"] and baseline_unfolded
                 and folding["hook_confirmed"] and folded and usage_available)
    report = {
        "schema_version": 1,
        "benchmark": "isolated-magpie-host-provider-unrelated-followup",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_requested": MODEL,
        "route": "real provider forwarded by local fixture through isolated Magpie/Bun hosts",
        "provider_address_recorded": False,
        "claim_under_test": "Compare provider-reported input usage for the same completed-Read history and unrelated follow-up with observe-only versus source folding through Magpie/Bun host dispatch.",
        "design": {
            "pair_count": 1,
            "real_provider_completions": 2,
            "synthetic_seed_completions": 4,
            "source_payload_utf8_bytes": len(payload.encode("utf-8")),
            "source_marked_utf8_bytes": len(marked_source.encode("utf-8")),
            "read_tool_shape": "Read.absolutePath",
            "task": "unrelated integer follow-up after a completed source answer",
            "historical_tool_result": "synthetic source fixture; no external Read tool was run",
            "temporary_home_and_xdg": True,
            "bubblewrap_isolation": True,
        },
        "baseline": baseline,
        "folding": folding,
        "valid": valid,
        "provider_input_tokens_saved": baseline_tokens - folding_tokens if usage_available else None,
        "limitations": [
            "One exploratory pair cannot establish typical savings or speedup.",
            "Provider token usage is not a bill amount; cached token accounting may differ.",
            "The source and prior read/answer are synthetic fixtures, and the test does not reload the live plugin.",
        ],
    }
    write_json(args.output, report)
    print(json.dumps({
        "result": "valid" if valid else "invalid",
        "real_provider_completions": 2,
        "synthetic_seed_completions": 4,
        "baseline_input_tokens": baseline_tokens,
        "folding_input_tokens": folding_tokens,
        "provider_input_tokens_saved": report["provider_input_tokens_saved"],
        "baseline_answer_correct": baseline["answer_correct"],
        "folding_answer_correct": folding["answer_correct"],
        "folding_items": folding["hook_metrics"]["itemsFolded"],
        "folding_wire_has_reference": folding_wire["fold_reference_present"],
        "folding_wire_has_source": folding_wire["full_source_payload_present"],
        "baseline_hook_confirmed": baseline["hook_confirmed"],
        "folding_hook_confirmed": folding["hook_confirmed"],
        "artifact": str(args.output),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
