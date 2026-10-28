#!/usr/bin/env python3
"""Run a bounded Luna coding loop against this repository in an offline sandbox.

Model HTTP runs in the controller. Every model-requested command and independent
verification runs through bubblewrap; credentials never enter that environment.
Candidates are exported, never automatically applied to the source checkout.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOLS = [
    {"type": "function", "function": {"name": name, "description": description,
     "parameters": {"type": "object", "properties": properties,
                    "required": required, "additionalProperties": False}}}
    for name, description, properties, required in [
        ("exec_command", "Run a shell command in the writable offline project sandbox. The working directory is /workspace. No host files or credentials are available.",
         {"command": {"type": "string"}, "timeout": {"type": "integer", "minimum": 1, "maximum": 600000,
          "description": "Optional timeout in milliseconds, capped by the controller's command timeout."}}, ["command"]),
        ("read_file", "Read a complete UTF-8 source file in the project sandbox. Use exec_command for partial reads of large files.",
         {"path": {"type": "string"}}, ["path"]),
        ("context_folding", "Read an archived reference from this trial's folding archive. Read returns the current view with offset/limit pagination; list and status inspect the archive.",
         {"action": {"type": "string", "enum": ["read", "list", "status"]},
          "id": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
          "limit": {"type": "integer", "minimum": 1, "maximum": 24000}}, ["action"]),
    ]
]


CANDIDATE_CHECK_TOOL = {"type": "function", "function": {
    "name": "check_candidate", "description": "Check your current allowed deliverable in a fresh sandbox using the configured acceptance check. Returns its feedback; checker authors must omit expected answers. At most two calls, including rejected calls. Revise only when evidence warrants it.",
    "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False}}}


async def candidate_check(args, sandbox_module, sandbox, original, original_modes, report):
    report["candidate_checks"] = report.get("candidate_checks", 0) + 1
    if report["candidate_checks"] > 2:
        return {"error": "Candidate check limit reached; inspect the previous feedback"}
    current = files(sandbox.path)
    modes = file_modes(sandbox.path, current)
    changed = [name for name in original.keys() | current.keys() if original.get(name) != current.get(name)
               or (name in original and name in current and original_modes.get(name) != modes.get(name))]
    allowed = set(args.allowed_path) - set(args.exclude_path)
    if any(name not in allowed for name in changed):
        return {"error": "Candidate changed files outside the allowed scope"}
    from types import SimpleNamespace
    check_args = SimpleNamespace(**vars(args))
    check_args.verify = "true"
    feedback = {}
    await clean_verification(check_args, sandbox_module, current, changed, allowed, original_modes, feedback)
    result = feedback["acceptance"]
    return {"exit_code": result["exit_code"], "timed_out": result["timed_out"],
            "feedback": result["stdout"],
            "error": "Acceptance could not read the deliverable" if result["stderr"] else None}


async def command(sandbox, argv, timeout=120):
    process = await asyncio.create_subprocess_exec(*sandbox.command(argv),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        stdout, stderr = await process.communicate()
        if isinstance(error, asyncio.CancelledError):
            raise
        timed_out = True
    return {"exit_code": process.returncode, "timed_out": timed_out,
            "stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace")}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError(f"Model HTTP redirect {code} refused; not retried")


def complete(url, key, payload, timeout):
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + key} if key else {})})
    # A local gateway should not go through environment HTTP proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Model HTTP {error.code}; not retried") from None
    except urllib.error.URLError:
        raise RuntimeError("Model transport failed; not retried") from None


def files(path):
    """Prune dependencies before walking; never follow model-created links/FIFOs.

    Bounded exports fail explicitly rather than consuming unbounded host memory.
    Symlinks are rejected instead of silently reporting an existing file deleted.
    """
    ignored = {".git", "node_modules", "__pycache__", "dist", ".pytest_cache", ".venv"}
    result = {}
    total = 0
    for parent, directories, names, parent_fd in os.fwalk(path, follow_symlinks=False):
        directories[:] = sorted(name for name in directories if name not in ignored)
        for name in directories + names:
            if name in ignored:
                continue
            entry = Path(parent) / name
            mode = os.stat(name, dir_fd=parent_fd, follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise ValueError(f"Unsupported candidate entry: {entry.relative_to(path)}")
            # O_NOFOLLOW also protects the final component if a background command
            # replaces the entry between lstat and open.
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            with os.fdopen(fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Candidate entry is no longer a regular file")
                data = stream.read(8 * 1024 * 1024 + 1)
            total += len(data)
            if len(data) > 8 * 1024 * 1024 or total > 64 * 1024 * 1024 or len(result) >= 10000:
                raise ValueError("Candidate export exceeds file/count/total size limit")
            result[str(entry.relative_to(path))] = data
    return result


def verification_message(result, sandbox, output_mode="summary"):
    """Keep full verifier evidence on disk; disclose routine passing logs on demand."""
    path = sandbox.path / ".benchmark-verification.json"
    if path.exists() or path.is_symlink():
        raise RuntimeError("Verification log destination already exists")
    path.write_text(json.dumps(result, ensure_ascii=False))
    if output_mode == "full":
        return "Independent initial verification:\n" + json.dumps(result, ensure_ascii=False)
    summary = {"exit_code": result["exit_code"], "timed_out": result["timed_out"],
               "stdout_bytes": len(result["stdout"].encode()), "stderr_bytes": len(result["stderr"].encode()),
               "full_log": "/workspace/.benchmark-verification.json"}
    if result["exit_code"] != 0 or result["timed_out"]:
        # Failure evidence stays complete; successful per-test chatter is the cut.
        summary.update(stdout=result["stdout"], stderr=result["stderr"])
    else:
        lines = (result["stdout"] + "\n" + result["stderr"]).splitlines()
        summary["test_summary"] = [line for line in lines if (
            line.startswith(("Ran ", "OK", "FAILED", "SUMMARY:"))
            or re.fullmatch(r"\s*\d+ (?:pass|fail|skip)\s*", line))]
    return "Independent initial verification:\n" + json.dumps(summary, ensure_ascii=False)


def exclude_paths(root, paths):
    for name in paths:
        path = root / name
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            raise ValueError("Excluded path must be an exact file: " + name)


def prepare_sandbox(sandbox, args):
    exclude_paths(sandbox.path, getattr(args, "exclude_path", []))
    if getattr(args, "harbor", False):
        sites = ROOT / "benchmarks/harbor/.venv/lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
        if not sites.is_dir():
            raise RuntimeError("Harbor site-packages missing for controller Python version")
        sandbox.prefix[1:1] = ["--ro-bind", str(sites), "/opt/harbor"]
        at = sandbox.prefix.index("PYTHONPATH") + 1
        sandbox.prefix[at] += ":/workspace/benchmarks/harbor:/opt/harbor"


def file_modes(root, entries):
    return {name: stat.S_IMODE((root / name).stat().st_mode) for name in entries}


async def clean_verification(args, sandbox_module, current, changed, allowed, original_modes, report):
    with sandbox_module.Sandbox(ROOT, snapshot_path=args.snapshot_path, metadata=args.source_metadata) as clean:
        prepare_sandbox(clean, args)
        for name in changed:
            if name not in allowed:
                continue
            destination = clean.path / name
            # Frozen sources are trusted, but candidate paths must not traverse links.
            if any(parent.is_symlink() for parent in [destination, *destination.parents] if parent != clean.path):
                raise ValueError("Candidate destination traverses symlink")
            if name not in current:
                destination.unlink(missing_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(current[name])
                destination.chmod(original_modes.get(name, 0o644))
        report["verification_environment"] = "fresh frozen snapshot plus allowed candidate changes only"
        report["verification_after"] = await command(clean, ["/bin/sh", "-c", args.verify], args.command_timeout)
        if getattr(args, "acceptance", None):
            report["acceptance"] = await command(clean, ["/bin/sh", "-c", args.acceptance], args.command_timeout)


async def trial(args, sandbox_module, bridge_module, mode, index):
    suffix = f"-{args.verification_output}" if getattr(args, "compare_verification_output", False) else ""
    directory = args.output / f"{index:02d}-{mode}{suffix}"
    directory.mkdir(parents=True, exist_ok=False)
    report = {"model_requested": args.model, "mode": mode, "iteration": index,
              "sandbox": "linux-bubblewrap-offline", "completion": "running", "requests": [],
              "folded_requests": 0, "recovery_calls": 0, "changed_files": [], "verified": False}
    started = time.monotonic()
    try:
        return await run_trial(args, sandbox_module, bridge_module, mode, index, directory, report)
    except Exception as error:
        report["completion"] = "error"
        report["error"] = f"{type(error).__name__}: {error}"
        report["verified"] = False
        return report
    finally:
        report["wall_seconds"] = time.monotonic() - started
        temporary = directory / "result.json.tmp"
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(directory / "result.json")


async def run_trial(args, sandbox_module, bridge_module, mode, index, directory, report):
    started = time.monotonic()
    with sandbox_module.Sandbox(ROOT, **({"snapshot_path": args.snapshot_path, "metadata": args.source_metadata}
                                           if hasattr(args, "snapshot_path") else {})) as sandbox:
        report["source"] = sandbox.metadata
        prepare_sandbox(sandbox, args)
        original = files(sandbox.path)
        original_modes = file_modes(sandbox.path, original)
        bridge = bridge_module.Bridge(directory)
        trial_tools = [*TOOLS, *([CANDIDATE_CHECK_TOOL] if getattr(args, "candidate_feedback", False) else [])]
        messages = [{"role": "system", "content": (
            "You are testing and improving this repository itself. All execution is in an offline sandbox. "
            "Inspect, reproduce a real defect, make a small fix, add a meaningful regression, and retest. "
            "Preserve existing work and public behavior. Do not delete or skip failing tests to pass. "
            "Do not edit test infrastructure, credentials, .git, package manifests, or this controller. "
            "Use complete source reads when practical. Mark long completed working notes using whole-line "
            "<!-- @context-fold begin LABEL --> and <!-- @context-fold end LABEL -->, leaving conclusions outside. "
            "The host may fold those notes after a request; context_folding retrieves an actual reference if needed. "
            "Finish with the defect, changed files, and actual test results.")},
            {"role": "user", "content": args.task}]
        try:
            await bridge.start()
            before = await command(sandbox, ["/bin/sh", "-c", args.verify], args.command_timeout)
            report["verification_before"] = before
            if "bwrap:" in before["stderr"] or before["timed_out"]:
                raise RuntimeError("Independent initial verification could not execute; no model request sent")
            initial = verification_message(before, sandbox, getattr(args, "verification_output", "summary"))
            report["verification_message_bytes"] = len(initial.encode())
            report["verification_output"] = getattr(args, "verification_output", "summary")
            original = files(sandbox.path)
            original_modes = file_modes(sandbox.path, original)
            messages.append({"role": "user", "content": initial})
            with (directory / "transcript.jsonl").open("w") as log:
                for turn in range(args.max_turns):
                    payload = {"model": args.model, "messages": messages, "tools": trial_tools,
                               "max_completion_tokens": args.max_output_tokens}
                    projected = await bridge.call("project", body=payload, mode=mode)
                    entry = {k: projected[k] for k in ("input_bytes", "output_bytes", "projection_ms", "folded")}
                    report["folded_requests"] += int(projected["folded"])
                    report["requests"].append(entry)
                    success = False
                    try:
                        request_start = time.monotonic()
                        response = await asyncio.to_thread(complete, args.url, args.key, projected["body"], args.request_timeout)
                        entry["model_wall_seconds"] = time.monotonic() - request_start
                        success = True
                        entry["model_reported"] = response.get("model")
                        entry["usage"] = response.get("usage")
                    finally:
                        await bridge.call("response", success=success)
                    choices = response.get("choices", [])
                    if len(choices) != 1 or not isinstance(choices[0].get("message"), dict):
                        raise RuntimeError("Expected exactly one assistant message")
                    answer = choices[0]["message"]
                    if answer.get("role") != "assistant":
                        raise RuntimeError("Expected assistant role")
                    messages.append(answer)
                    log.write(json.dumps({"turn": turn, "message": answer, "usage": response.get("usage")}, ensure_ascii=False) + "\n")
                    log.flush()
                    calls = answer.get("tool_calls") or []
                    if choices[0].get("finish_reason") in {"length", "content_filter"}:
                        raise RuntimeError("Incomplete or filtered assistant response")
                    if not calls:
                        if choices[0].get("finish_reason") != "stop":
                            raise RuntimeError("Assistant did not finish normally")
                        report["completion"] = "final"
                        break
                    ids = set()
                    for call in calls:
                        if not isinstance(call, dict) or call.get("type") != "function" or not isinstance(call.get("id"), str) or not call["id"] or call["id"] in ids:
                            raise RuntimeError("Malformed or duplicate tool call")
                        ids.add(call["id"])
                        try:
                            function = call["function"]
                            if not isinstance(function, dict) or not isinstance(function.get("arguments"), str):
                                raise ValueError("Expected function and JSON arguments")
                            fields = json.loads(function["arguments"])
                            if not isinstance(fields, dict):
                                raise ValueError("Expected object")
                            if function["name"] == "check_candidate" and getattr(args, "candidate_feedback", False):
                                if fields:
                                    raise ValueError("Candidate check takes no arguments")
                                result = await candidate_check(args, sandbox_module, sandbox, original, original_modes, report)
                            else:
                                result = await tool(sandbox, bridge, report, function["name"], fields, args.command_timeout, bridge_module.BridgeError)
                        except (ValueError, TypeError, KeyError) as error:
                            result = {"error": type(error).__name__}
                        message = {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result}
                        messages.append(message)
                        log.write(json.dumps({"turn": turn, "message": message}, ensure_ascii=False) + "\n")
                        log.flush()
                else:
                    report["completion"] = "max-turns"
        except Exception as error:
            report["completion"] = "error"
            report["error"] = str(error)
        finally:
            await bridge.close()
            current = files(sandbox.path)
            current_modes = file_modes(sandbox.path, current)
            report["mode_changes"] = sorted(name for name in original.keys() & current.keys() if original_modes.get(name) != current_modes.get(name))
            changed = sorted(name for name in original.keys() | current.keys() if original.get(name) != current.get(name) or name in report["mode_changes"]) 
            report["changed_files"] = changed
            allowed = set(getattr(args, "allowed_path", [])) - set(getattr(args, "exclude_path", []))
            await clean_verification(args, sandbox_module, current, changed, allowed, original_modes, report)
            report["unauthorized_changed_files"] = [name for name in changed if name not in allowed]
            report["export_allowed_paths"] = sorted(allowed)
            candidates = directory / "candidate"
            for name in changed:
                if name in current and name in allowed:
                    destination = candidates / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(current[name])
                    destination.chmod(original_modes.get(name, 0o644))
            report["deleted_files"] = [name for name in changed if name not in current]
            report["candidate_sha256"] = {name: hashlib.sha256(current[name]).hexdigest() for name in changed if name in current}
    report["wall_seconds"] = time.monotonic() - started
    report["verified"] = (report["completion"] == "final"
                          and report["verification_after"]["exit_code"] == 0
                          and not report["verification_after"]["timed_out"]
                          and not report.get("unauthorized_changed_files")
                          and (not getattr(args, "acceptance", None) or (
                              report["acceptance"]["exit_code"] == 0 and not report["acceptance"]["timed_out"])))
    (directory / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"trial": str(directory), "verified": report["verified"], "completion": report["completion"],
                      "requests": len(report["requests"]), "folded_requests": report["folded_requests"],
                      "changed_files": report["changed_files"]}), flush=True)
    return report


async def tool(sandbox, bridge, report, name, fields, timeout, bridge_error=()):
    allowed = {"exec_command": {"command", "timeout"}, "read_file": {"path"},
               "context_folding": {"action", "id", "offset", "limit"}}
    if not isinstance(name, str) or name not in allowed or not isinstance(fields, dict):
        raise ValueError("Invalid tool name or argument object")
    if set(fields) - allowed[name]:
        raise ValueError("Unexpected tool arguments")
    if name == "exec_command":
        value = fields["command"]
        if not isinstance(value, str) or not value or "\0" in value:
            raise ValueError("Invalid command")
        requested_timeout = fields.get("timeout")
        if requested_timeout is not None:
            if type(requested_timeout) is not int or not 1 <= requested_timeout <= 600000:
                raise ValueError("Invalid command timeout")
            timeout = min(timeout, requested_timeout / 1000)
        result = await command(sandbox, ["/bin/sh", "-c", value], timeout)
        for key in ("stdout", "stderr"):
            if len(result[key]) > 48000:
                result[key] = result[key][:48000]
                result[key + "_truncated"] = True
        return result
    if name == "read_file":
        path = fields["path"]
        if not isinstance(path, str) or not path or "\0" in path:
            raise ValueError("Invalid path")
        code = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); b=p.read_bytes(); assert len(b)<=100000, 'file too large'; sys.stdout.write(b.decode('utf-8'))"
        result = await command(sandbox, ["/usr/bin/python3", "-I", "-c", code, path], timeout)
        return result["stdout"] if result["exit_code"] == 0 else result
    if name == "context_folding":
        action = fields["action"]
        if not isinstance(action, str) or action not in {"read", "list", "status"}:
            raise ValueError("Invalid archive action")
        argv = [action, "--json"]
        for key in ("id", "offset", "limit"):
            if key in fields:
                value = fields[key]
                if key == "id" and (not isinstance(value, str) or not value or "\0" in value or value.startswith("-")):
                    raise ValueError("Invalid ID")
                if key != "id" and (type(value) is not int or value < 0 or (key == "limit" and not 1 <= value <= 24000)):
                    raise ValueError("Invalid range")
                argv.extend(["--" + key, str(value)])
        if action == "read":
            report["recovery_calls"] += 1
        try:
            result = await bridge.call("cli", argv=argv)
        except bridge_error as error:
            if error.code not in {"archive_unavailable", "scope_mismatch", "invalid_request", "unsupported_action"}:
                raise
            return {"error": error.code}
        return json.loads(result["stdout"]) if result["exit_code"] == 0 else result
    raise ValueError("Unknown tool")


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="codex/gpt-6-luna")
    parser.add_argument("--modes", nargs="+", choices=["baseline", "folding"], default=["baseline", "folding"])
    parser.add_argument("--iterations", type=int, default=1,
                        help="Number of independent repetitions per mode; candidates are not promoted between repetitions")
    parser.add_argument("--max-turns", type=int, default=24)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--request-timeout", type=int, default=180)
    parser.add_argument("--command-timeout", type=int, default=180)
    parser.add_argument("--harbor", action="store_true", help="Expose installed Harbor Python modules read-only inside sandbox")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify", required=True, help="Independent verification command run inside sandbox")
    parser.add_argument("--verification-output", choices=["summary", "full"], default="full",
                        help="Initial verification output: full (default), or optional passing summary with on-demand full log")
    parser.add_argument("--compare-verification-output", action="store_true",
                        help="Compare full versus summary initial verification on the same frozen source")
    parser.add_argument("--acceptance", help="Additional independent command after the model finishes; must pass for verified")
    parser.add_argument("--candidate-feedback", action="store_true", help="Expose at most two clean acceptance checks as a tool; requires --acceptance")
    parser.add_argument("--task", required=True)
    parser.add_argument("--exclude-path", action="append", default=[], help="Exact relative source file hidden from all trial snapshots")
    parser.add_argument("--allowed-path", action="append", default=[],
                        help="Exact repository-relative file permitted for candidate export; repeat per file. Default exports nothing.")
    args = parser.parse_args()
    if args.candidate_feedback and not args.acceptance:
        parser.error("--candidate-feedback requires --acceptance")
    for name in args.allowed_path + args.exclude_path:
        path = Path(name)
        if not name or path.is_absolute() or ".." in path.parts or str(path) != name:
            parser.error("--allowed-path must be an exact normalized repository-relative file")
    if args.request_timeout <= 0 or args.command_timeout <= 0:
        parser.error("Timeouts must be positive")
    if not 1 <= args.iterations <= 5 or not 1 <= args.max_turns <= 100 or args.max_output_tokens <= 0:
        parser.error("Use 1-5 iterations, 1-100 turns and positive output token limit")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    base = os.environ.get("HARBOR_MODEL_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL", "")
    args.key = os.environ.get("HARBOR_MODEL_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
    sys.path.insert(0, str(ROOT / "benchmarks/harbor"))
    from magpie_harbor import agent as bridge_module
    args.url = bridge_module.endpoint(base.rstrip("/") + ("" if base.rstrip("/").endswith("/v1") else "/v1"))
    sandbox_module = load("self_benchmark", ROOT / "scripts/self-benchmark.py")
    results = []
    # Freeze one worktree once. Concurrent development must not change the
    # starting version between baseline/folding or independent attempts.
    with sandbox_module.Sandbox(ROOT) as frozen:
        exclude_paths(frozen.path, args.exclude_path)
        frozen.metadata = {**frozen.metadata, "excluded_paths": args.exclude_path}
        args.snapshot_path = frozen.path
        args.source_metadata = frozen.metadata
        # Pin the host-side hook/CLI bridge to the same source snapshot too.
        # This dependency link is hidden behind the read-only sandbox mount.
        (frozen.path / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        frozen_bridge = load("magpie_harbor.frozen_agent", frozen.path / "benchmarks/harbor/magpie_harbor/agent.py")
        output_modes = ["full", "summary"] if args.compare_verification_output else [args.verification_output]
        for index in range(1, args.iterations + 1):
            # Alternate order across attempts to expose rather than hide cache warming.
            variants = output_modes if index % 2 else list(reversed(output_modes))
            for variant in variants:
                args.verification_output = variant
                for mode in args.modes:
                    results.append(await trial(args, sandbox_module, frozen_bridge, mode, index))
    summary = {"schema_version": 1, "model": args.model, "trials": results,
               "verified": all(item["verified"] for item in results),
               "note": "Independent candidate runs, not cumulative promotion; no automatic patch application or savings guarantee."}
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0 if summary["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
