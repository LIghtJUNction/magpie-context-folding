"""Opt-in Claude Code Read hook; inspect archived source through bounded queries.

Only complete Python reads are supported: partial source cannot prove lexical
context. The older explicit expand command remains for manual compatibility.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import sys

from .annotations import _source_lines, discover_source
from .core import Client

ENV = "CONTEXT_FOLDING_READ_BINDING"


def private_root() -> Path:
    root = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "context-folding/claude-read"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Private state directory required")
    return root


def key(root: Path) -> bytes:
    path = root / "binding.key"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as stream:
            stream.write(secrets.token_bytes(32))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Private binding key required")
        value = stream.read(33)
    if len(value) != 32:
        raise ValueError("Invalid binding key")
    return value


def binding(secret: bytes, session: str, cwd: str) -> str:
    if not isinstance(session, str) or not session or len(session) > 200:
        raise ValueError("Missing session binding")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        raise ValueError("Missing project binding")
    payload = json.dumps([session, str(Path(cwd).resolve())], separators=(",", ":")).encode()
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def start(event: dict, root: Path) -> None:
    token = binding(key(root), event.get("session_id"), event.get("cwd"))
    # Only SessionStart supplies this host-managed environment file. Never take
    # a destination from tool_input, and never emit the binding to model context.
    destination = os.environ.get("CLAUDE_ENV_FILE")
    if not destination:
        return
    with open(destination, "a") as stream:
        stream.write(f"\nexport {ENV}={token}\n")
    record = root / (token + ".json")
    fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump({"cwd": str(Path(event["cwd"]).resolve())}, stream)


def client(root: Path, token: str, cwd: str) -> Client:
    # Keep nearest-project configuration anchored to the original hook cwd.
    return Client(root / (token + ".sqlite3"), project_dir=cwd)


def fold(event: dict, archive: Client, scope: str, *, selectors: list[str] | None = None,
         expand_mode: str = "recursive", recovery: str | None = None) -> dict:
    if event.get("hook_event_name") != "PostToolUse" or event.get("tool_name") != "Read":
        return {}
    response = event.get("tool_response")
    if not isinstance(response, dict) or response.get("type") != "text":
        return {}
    file = response.get("file")
    if not isinstance(file, dict):
        return {}
    text, path = file.get("content"), file.get("filePath")
    if not isinstance(text, str) or not text or not isinstance(path, str):
        return {}
    # Numbered/truncated/rendered content is not the raw source schema.
    if Path(path).suffix.lower() not in {".py", ".pyi"}:
        return {}
    count = len(_source_lines(text))
    if any(type(file.get(name)) is not int for name in ("startLine", "numLines", "totalLines")):
        return {}
    if file["startLine"] != 1 or file["numLines"] != count or file["totalLines"] != count:
        return {}
    annotation = discover_source(text, "python")
    result = archive.read_source(scope, text=text, language="python", mode="folded", limit=24000,
                                 expand=[] if selectors is None else selectors, expandMode=expand_mode)
    if result.get("parser") != "python-comments":
        return {}
    selected = {r["id"]: r for r in annotation["regions"]}
    regions = result.get("foldedRegions", [])
    if not regions:
        return {}
    # Store the exact response, including every extra host metadata field.
    recovery = recovery or archive.put(scope, json.dumps(response, ensure_ascii=False))["id"]
    chunks, cursor = [], 0
    for folded in regions:
        region = selected[folded["id"]]
        first, last = region["startLine"], region["endLine"]
        payload = text[region["start"]:region["end"]]
        script = shlex.quote(str(Path(__file__).resolve().parents[2] / 'scripts/claude-read.py'))
        ref_id = folded["reference"][8:-2]
        notice = (f"[context-folding: lines {first}-{last} folded; NOT SOURCE; "
                  f"blank lines preserve numbering; inspect: python3 {script} read {ref_id}; "
                  f"snapshot={recovery} region={region['id']}]")
        # Preserve every original newline byte. Host numbering remains truthful
        # for all visible source after each placeholder, including CRLF input.
        replacement = notice + "".join(re.findall(r"\r\n|\r|\n", payload))
        if len(replacement) >= len(payload):
            continue
        if region["start"] < cursor:
            raise ValueError("Overlapping source regions")
        chunks.extend((text[cursor:region["start"]], replacement))
        cursor = region["end"]
    chunks.append(text[cursor:])
    output = "".join(chunks)
    if len(output) >= len(text) or len(_source_lines(output)) != count:
        return {}
    updated = {**response, "file": {**file, "content": output}}
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "updatedToolOutput": updated}}


def expand(root: Path, identifier: str, region_id: str | list[str] | None = None,
           expand_mode: str | None = None) -> dict:
    # Without a mode, retain the original full-response / exact-region recovery.
    # An explicit mode returns a selective view of the complete Read response.
    if expand_mode is not None and expand_mode not in ("single", "recursive"):
        raise ValueError("Invalid source expansion mode")
    if expand_mode is not None:
        selectors = [] if region_id is None else [region_id] if isinstance(region_id, str) else region_id
        if not isinstance(selectors, list) or any(not isinstance(s, str) or not s for s in selectors):
            raise ValueError("Invalid source selectors")
    token = os.environ.get(ENV, "")
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("No host session binding; start a session with the plugin enabled")
    record = root / (token + ".json")
    fd = os.open(record, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        cwd = json.load(stream)["cwd"]
    # Recovery stays anchored to the recorded project even if Bash changed cwd.
    with client(root, token, cwd) as archive:
        parts, offset = [], 0
        while True:
            result = archive.read(token, identifier, offset=offset, limit=24000)
            parts.append(result["text"])
            offset = result["nextOffset"]
            if offset is None:
                break
    response = json.loads("".join(parts))
    if not isinstance(response, dict) or response.get("type") != "text" or not isinstance(response.get("file"), dict):
        raise ValueError("Not an archived Read response")
    if expand_mode is not None:
        with client(root, token, cwd) as archive:
            output = fold({"hook_event_name": "PostToolUse", "tool_name": "Read",
                           "tool_response": response}, archive, token, selectors=selectors,
                          expand_mode=expand_mode, recovery=identifier)
        return output.get("hookSpecificOutput", {}).get("updatedToolOutput", response)
    if region_id is not None:
        file = response["file"]
        regions = discover_source(file["content"], "python")["regions"]
        region = next((r for r in regions if r["id"] == region_id), None)
        if region is None:
            raise ValueError("Unknown region in this Read response")
        first, last = region["startLine"], region["endLine"]
        # Exact original lines (including terminal newline), with original range.
        content = "".join(_source_lines(file["content"])[first - 1:last])
        response = {**response, "file": {**file, "content": content, "startLine": first,
                                        "numLines": last - first + 1}}
    return response


def inspect(root: Path, command: list[str]) -> int:
    """Use the same ctxf paginated query formatter with the host-bound scope."""
    if not command or command[0] not in ("list", "grep", "read", "meta"):
        raise ValueError("Expected list, grep, read or meta")
    if any(arg in ("--state", "--project-dir", "--scope")
           or arg.startswith(("--state=", "--project-dir=", "--scope="))
           for arg in command[1:]):
        raise ValueError("Host-bound archive settings cannot be overridden")
    token = os.environ.get(ENV, "")
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("No host session binding; start a session with the plugin enabled")
    record = root / (token + ".json")
    fd = os.open(record, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        cwd = json.load(stream)["cwd"]
    from .cli import ctxf_main
    return ctxf_main(["--state", str(root / (token + ".sqlite3")), "--project-dir", cwd,
                      "--scope", token, *command])


def main() -> int:
    command = sys.argv[1:]
    try:
        root = private_root()
        if command and command[0] in ("list", "grep", "read", "meta"):
            return inspect(root, command)
        if command and command[0] == "expand":
            parser = argparse.ArgumentParser(prog="claude-read.py expand")
            parser.add_argument("identifier")
            parser.add_argument("regions", nargs="*")
            parser.add_argument("--expand-mode", choices=("single", "recursive"))
            options = parser.parse_args(command[1:])
            if options.expand_mode is None and len(options.regions) > 1:
                raise ValueError("Multiple selectors require --expand-mode")
            regions = options.regions if options.expand_mode else next(iter(options.regions), None)
            print(json.dumps(expand(root, options.identifier, regions, options.expand_mode), ensure_ascii=False))
            return 0
        if command not in (["start"], ["hook"]):
            raise ValueError("Expected start, hook, list, grep, read, meta or legacy expand ID")
        event = json.load(sys.stdin)
        if command == ["start"]:
            if event.get("hook_event_name") == "SessionStart":
                start(event, root)
            return 0
        token = binding(key(root), event.get("session_id"), event.get("cwd"))
        # Replacement is useful only if SessionStart established real recovery.
        record = root / (token + ".json")
        if os.environ.get(ENV) != token or not record.is_file() or record.is_symlink():
            return 0
        with client(root, token, event["cwd"]) as archive:
            output = fold(event, archive, token)
        if output:
            print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as error:
        if command and command[0] in ("expand", "list", "grep", "read", "meta"):
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 1
        # No updatedToolOutput means the host retains the original response.
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
