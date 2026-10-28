"""Local CLI and JSON Lines RPC for SDK subprocesses."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import stat
import sys
import secrets
from pathlib import Path
from typing import Any, BinaryIO

from .annotations import annotate_python_functions

from .core import Client, FoldingError

MAX_INPUT_BYTES = 8 * 1024 * 1024
ACTIONS = ("fold", "put", "list", "read", "render", "restore", "resolve", "paste", "status", "gc", "roots", "pin", "skills", "annotate", "read-source")


class InputError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _json(value: Any) -> str:
    # ASCII escaping also makes output safe on hosts whose locale is not UTF-8.
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def _emit(value: Any) -> None:
    sys.stdout.write(_json(value) + "\n")
    sys.stdout.flush()


def _reject_constant(_: str) -> None:
    raise ValueError("Non-finite number")


def _loads(data: bytes | str) -> Any:
    try:
        if isinstance(data, bytes):
            data = data.decode("utf-8", errors="strict")
        return json.loads(data, parse_constant=_reject_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise InputError("invalid_json", "Input must be valid UTF-8 JSON") from None


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InputError("invalid_request", "Request must be a JSON object")
    return value


def _error(exc: FoldingError | InputError) -> dict[str, str]:
    return {"code": str(exc.code), "message": str(getattr(exc, "message", str(exc)))}


def _call(client: Client, request: Any) -> dict[str, Any]:
    try:
        return {"result": client.call(_object(request))}
    except (FoldingError, InputError) as exc:
        return {"error": _error(exc)}
    except Exception:
        # Payloads and exception details can contain private archive content.
        return {"error": {"code": "internal_error", "message": "Internal operation failed"}}


def _lines(stream: BinaryIO):
    """Read bounded frames, draining an oversized frame without retaining it."""
    while True:
        line = stream.readline(MAX_INPUT_BYTES + 2)
        if not line:
            return
        payload = line[:-1] if line.endswith(b"\n") else line
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        if len(payload) > MAX_INPUT_BYTES:
            while line and not line.endswith(b"\n"):
                line = stream.readline(64 * 1024)
            yield InputError("input_too_large", "Input exceeds the 8 MiB limit")
        else:
            yield payload


def serve_rpc(client: Client, stream: BinaryIO) -> int:
    for frame in _lines(stream):
        try:
            if isinstance(frame, InputError):
                raise frame
            response = _call(client, _loads(frame))
        except InputError as exc:
            response = {"error": _error(exc)}
        _emit(response)
    return 0


def _read_stdin() -> bytes:
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise InputError("input_too_large", "Input exceeds the 8 MiB limit")
    return data


def _argument_json(value: str) -> Any:
    if len(value.encode("utf-8")) > MAX_INPUT_BYTES:
        raise InputError("input_too_large", "Input exceeds the 8 MiB limit")
    return _loads(value)


def _text(value: str) -> str:
    if value != "-":
        if len(value.encode("utf-8")) > MAX_INPUT_BYTES:
            raise InputError("input_too_large", "Input exceeds the 8 MiB limit")
        return value
    try:
        return _read_stdin().decode("utf-8", errors="strict")
    except UnicodeError:
        raise InputError("invalid_utf8", "Text must be valid UTF-8") from None


def _default_state() -> str:
    return os.environ.get("CTXF_STATE") or str(
        Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
        / "context-folding" / "archive.sqlite3")


def _parser(*, ctxf: bool = False) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ctxf" if ctxf else None,
        description="Fold explicit comment regions from UTF-8 stdin (default: fold); originals persist for read/resolve."
        if ctxf else "Local reversible context archive; no model calls.")
    parser.add_argument("--state", default=_default_state() if ctxf else None,
                        help="SQLite state file (ctxf default: CTXF_STATE or XDG data directory; also accepted after the command)")
    parser.add_argument("--project-dir", help="Project settings discovery directory (default: current directory)")
    if ctxf:
        parser.add_argument("--scope", default=argparse.SUPPRESS, help="Persistent archive namespace (default: default)")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("rpc", "call", *ACTIONS, "annotate-functions"):
        sub = commands.add_parser(command)
        if command == "annotate-functions":
            sub.add_argument("path", help="Python/JavaScript/TypeScript source file or project directory")
            sub.add_argument("--language", default="python")
            sub.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                             help="Exclude a relative path or basename (repeatable; directories are pruned)")
            sub.add_argument("--apply", action="store_true",
                             help="Preflight all files, then replace atomically per file; write errors may leave a partial batch (default: preview)")
            continue
        sub.add_argument("--state", default=argparse.SUPPRESS, help="SQLite state file")
        sub.add_argument("--project-dir", default=argparse.SUPPRESS, help="Project settings discovery directory")
        if command == "rpc":
            continue
        if command == "fold":
            sub.add_argument("--scope", required=not ctxf, default=argparse.SUPPRESS)
            sub.add_argument("--text", default=argparse.SUPPRESS, help="UTF-8 text; '-' or omission reads stdin")
            sub.add_argument("--language", default=argparse.SUPPRESS)
            sub.add_argument("--comment-styles", default=argparse.SUPPRESS, help="Additional comment delimiters as JSON")
            sub.add_argument("--json", action="store_true", help="Output text and reference metadata as JSON")
            continue
        sub.add_argument("--json", metavar="JSON", help="Request object; '-' reads JSON stdin")
        if command == "call":
            if ctxf:
                sub.add_argument("--scope", default=argparse.SUPPRESS)
            continue
        sub.add_argument("--scope", required=not ctxf, default=argparse.SUPPRESS)
        if command == "read":
            sub.add_argument("--raw", action="store_true", help="Output complete UTF-8 text without JSON; --limit requests only that range")
        for name in ("id", "text", "role", "occurrence", "query", "name", "description", "path", "mode", "body", "sort", "order", "language"):
            sub.add_argument("--" + name, default=argparse.SUPPRESS)
        sub.add_argument("--request-cycle", type=int, default=argparse.SUPPRESS)
        sub.add_argument("--expand-mode", choices=("single", "recursive"), default=argparse.SUPPRESS,
                         help="Expansion depth for read and read-source (default: recursive)")
        for name in ("ids", "protected", "keep", "expand"):
            sub.add_argument("--" + name, nargs="*", default=argparse.SUPPRESS)
        for name in ("source", "value", "config", "files", "comment-styles"):
            sub.add_argument("--" + name, default=argparse.SUPPRESS, help="JSON value; '-' reads JSON stdin")
        for name in ("limit", "offset", "depth"):
            sub.add_argument("--" + name, type=int, default=argparse.SUPPRESS)
        sub.add_argument("--pinned", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS)
        sub.add_argument("--peek", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS)
    return parser


def _request(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "call":
        request = _object(_loads(_read_stdin()) if args.json in (None, "-") else _argument_json(args.json))
        if hasattr(args, "scope"):
            request["scope"] = args.scope
        return request
    json_fields = ("source", "value", "config", "files", "comment_styles")
    text_fields = ("text", "body")
    stdin_used = False

    def input_value(raw: str, is_json: bool) -> Any:
        nonlocal stdin_used
        if raw == "-":
            if stdin_used:
                raise InputError("invalid_request", "Only one input may read stdin")
            stdin_used = True
        return (_loads(_read_stdin()) if raw == "-" else _argument_json(raw)) if is_json else _text(raw)

    request = {} if args.command == "fold" or args.json is None else _object(input_value(args.json, True))
    excluded = ("command", "state", "project_dir", "json", "raw", *json_fields, *text_fields)
    request.update({key: value for key, value in vars(args).items() if key not in excluded})
    for key in json_fields + text_fields:
        if hasattr(args, key):
            request["commentStyles" if key == "comment_styles" else key] = input_value(getattr(args, key), key in json_fields)
    request["action"] = args.command
    if "request_cycle" in request:
        request["requestCycle"] = request.pop("request_cycle")
    if "expand_mode" in request:
        request["expandMode"] = request.pop("expand_mode")
    if args.command in ("put", "fold") and "text" not in request:
        request["text"] = input_value("-", False)
    return request


_ANNOTATION_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox",
    "node_modules", "build", "dist", ".eggs",
})


def _annotation_language(language: str) -> tuple[str, set[str]]:
    from .javascript import normalize_language
    language = normalize_language(language)
    options = {"python": {".py", ".pyi"}, "py": {".py", ".pyi"},
               "javascript": {".js", ".mjs", ".cjs", ".jsx"}, "jsx": {".jsx"},
               "typescript": {".ts", ".mts", ".cts", ".tsx"}, "tsx": {".tsx"}}
    if language not in options:
        raise ValueError("Function annotation supports Python, JavaScript, JSX, TypeScript and TSX")
    return ("python" if language == "py" else language), options[language]


def _annotation_plan(path: str, language: str) -> tuple:
    language, _ = _annotation_language(language)
    target = Path(path)
    initial_stat = target.lstat()
    if not stat.S_ISREG(initial_stat.st_mode):
        raise ValueError("Path must be a regular, non-symlink source file")
    if initial_stat.st_nlink != 1:
        raise ValueError("Source file must not have multiple hard links")
    with target.open("rb") as stream:
        original = stream.read(MAX_INPUT_BYTES + 1)
    if len(original) > MAX_INPUT_BYTES:
        raise ValueError("Source file exceeds the 8 MiB limit")
    text = original.decode("utf-8", errors="strict")
    if language == "python":
        result = annotate_python_functions(text)
    else:
        from .javascript import annotate_javascript_functions
        # TSX/JSX grammar is selected per file when traversing a project.
        if target.suffix.lower() in {".tsx", ".jsx"}:
            language = target.suffix.lower()[1:]
        result = annotate_javascript_functions(text, language)
    encoded = result["text"].encode("utf-8")
    if len(encoded) > MAX_INPUT_BYTES:
        raise ValueError("Annotated source exceeds the 8 MiB limit")
    result.update({"path": str(target), "language": language, "applied": False})
    # Snapshot ancestor identities too: a directory swapped for a symlink must
    # not redirect an otherwise unchanged file outside the selected project.
    parents = [(parent, parent.lstat()) for parent in target.absolute().parents]
    if any(not stat.S_ISDIR(info.st_mode) for _, info in parents):
        raise ValueError("Source ancestors must be non-symlink directories")
    return target, initial_stat, original, encoded, result, parents


def _annotation_parent_fd(plan: tuple) -> int:
    target, _, _, _, _, parents = plan
    expected = {parent: info for parent, info in parents}
    fd = os.open(target.absolute().anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        parent_path = Path(target.absolute().anchor)
        for part in target.absolute().parent.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            parent_path /= part
            info, current = expected[parent_path], os.fstat(fd)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("File changed during annotation; refusing write")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _verify_annotation(plan: tuple, parent_fd: int | None = None) -> None:
    target, initial, original, _, _, parents = plan
    try:
        for parent, info in parents:
            current = parent.lstat()
            if (not stat.S_ISDIR(current.st_mode)
                    or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino)):
                raise ValueError("File changed during annotation; refusing write")
        owned_fd = parent_fd is None
        if owned_fd:
            parent_fd = _annotation_parent_fd(plan)
        try:
            current = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                    or (current.st_dev, current.st_ino, current.st_mode) != (initial.st_dev, initial.st_ino, initial.st_mode)):
                raise ValueError("File changed during annotation; refusing write")
            source_fd = os.open(target.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            with os.fdopen(source_fd, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if ((opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink)
                        != (initial.st_dev, initial.st_ino, initial.st_mode, 1)
                        or stream.read(MAX_INPUT_BYTES + 1) != original):
                    raise ValueError("File changed during annotation; refusing write")
            after_read = os.stat(target.name, dir_fd=parent_fd, follow_symlinks=False)
            if (after_read.st_dev, after_read.st_ino, after_read.st_mode, after_read.st_nlink) != (initial.st_dev, initial.st_ino, initial.st_mode, 1):
                raise ValueError("File changed during annotation; refusing write")
        finally:
            if owned_fd:
                os.close(parent_fd)
    except OSError as exc:
        raise ValueError("File changed during annotation; refusing write") from exc


def _apply_annotation(plan: tuple) -> dict[str, Any]:
    target, initial, original, encoded, result, _ = plan
    if encoded == original:
        return result
    _verify_annotation(plan)
    parent_fd = _annotation_parent_fd(plan)
    temporary = None
    try:
        # All mutation uses the same opened directory, even if its pathname is
        # renamed or redirected between the last validation and replacement.
        candidate = f".{target.name}.{secrets.token_hex(16)}"
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent_fd)
        temporary = candidate
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fchmod(stream.fileno(), stat.S_IMODE(initial.st_mode))
            os.fsync(stream.fileno())
        _verify_annotation(plan, parent_fd)
        os.replace(temporary, target.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary = None
        os.fsync(parent_fd)
    finally:
        try:
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(parent_fd)
    result["applied"] = True
    return result


def _annotate_functions(path: str, language: str, apply: bool) -> dict[str, Any]:
    plan = _annotation_plan(path, language)
    return _apply_annotation(plan) if apply else plan[4]


def _annotate_project(path: str, language: str, apply: bool,
                      exclude: list[str]) -> dict[str, Any]:
    root = Path(path).absolute()
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("Project path must be a non-symlink directory")
    language, suffixes = _annotation_language(language)
    if any(not pattern or Path(pattern).is_absolute() or ".." in Path(pattern).parts for pattern in exclude):
        raise ValueError("Exclusions must be nonempty relative glob patterns")

    def excluded(candidate: Path) -> bool:
        relative = candidate.relative_to(root).as_posix()
        return any(fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(candidate.name, pattern)
                   for pattern in exclude)

    def walk_error(error: OSError) -> None:
        raise error

    plans = []
    total_bytes = 0
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        parent = Path(directory)
        dirs[:] = sorted(name for name in dirs if name not in _ANNOTATION_SKIP_DIRS
                         and not name.endswith(".egg-info")
                         and not (parent / name).is_symlink() and not excluded(parent / name))
        for name in sorted(files):
            target = parent / name
            if target.suffix.lower() not in suffixes or excluded(target) or target.is_symlink():
                continue
            plan = _annotation_plan(str(target), language)
            total_bytes += len(plan[2]) + len(plan[3])
            if len(plans) >= 10000 or total_bytes > 64 * 1024 * 1024:
                raise ValueError("Project annotation exceeds the 10000 file or 64 MiB planning limit")
            plans.append(plan)
    if apply:
        # Validate the entire batch before the first write; each replacement is
        # atomic, but filesystem errors during commit can leave a partial batch.
        for plan in plans:
            _verify_annotation(plan)
        for plan in plans:
            _apply_annotation(plan)
    results = [plan[4] for plan in plans]
    return {"path": str(root), "language": language, "files": results,
            "applied": any(result["applied"] for result in results),
            "changedFiles": sum(plan[2] != plan[3] for plan in plans)}


def _removed_mcp_command(argv: list[str]) -> bool:
    """Recognize the retired subcommand, never a shared option's value."""
    index = 0
    while index < len(argv):
        option = argv[index]
        if option in ("--state", "--project-dir", "--scope"):
            index += 2
        elif any(option.startswith(name + "=") for name in ("--state", "--project-dir", "--scope")):
            index += 1
        else:
            return option == "mcp"
    return False


def _ctxf_arguments(argv: list[str]) -> list[str]:
    """Insert the default fold command after any leading shared options."""
    commands = {"rpc", "call", *ACTIONS, "annotate-functions"}
    index = 0
    while index < len(argv):
        option = argv[index]
        if option in commands or option in ("-h", "--help"):
            return argv
        if option in ("--state", "--project-dir", "--scope"):
            if index + 1 >= len(argv):
                return argv  # Let argparse explain the missing option value.
            index += 2
        elif any(option.startswith(name + "=") for name in ("--state", "--project-dir", "--scope")):
            index += 1
        else:
            break
    return [*argv[:index], "fold", *argv[index:]]


def _raw_read(client: Client, request: dict) -> str:
    """Collect all pages before writing stdout, unless a range was requested."""
    if "limit" in request:
        return client.call(request)["text"]
    parts = []
    offset = request.get("offset", 0)
    identity = None
    while True:
        page = client.call({**request, "offset": offset, "limit": 24000})
        current = (page["id"], page["sha256"], page["totalChars"])
        if identity is not None and identity != current:
            raise FoldingError("storage", "Archive changed during recovery")
        identity = current
        if page["offset"] != offset:
            raise FoldingError("storage", "Invalid recovery page")
        parts.append(page["text"])
        following = page["nextOffset"]
        if following is None:
            if offset + len(page["text"]) != page["totalChars"]:
                raise FoldingError("storage", "Incomplete recovery page")
            return "".join(parts)
        if following != offset + len(page["text"]) or following <= offset:
            raise FoldingError("storage", "Invalid recovery continuation")
        offset = following


def _write_raw(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def _run_cli(argv: list[str] | None = None, *, ctxf: bool = False) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if _removed_mcp_command(argv):
        sys.stderr.write("MCP support was removed; use ctxf CLI commands or SDK RPC.\n")
        return 2
    parser = _parser(ctxf=ctxf)
    if ctxf:
        argv = _ctxf_arguments(argv)
    args = parser.parse_args(argv)
    if ctxf and args.command == "rpc" and hasattr(args, "scope"):
        parser.error("--scope belongs to each RPC request, not the server command")
    if args.command == "annotate-functions":
        try:
            target = Path(args.path)
            if stat.S_ISDIR(target.lstat().st_mode):
                result = _annotate_project(args.path, args.language, args.apply, args.exclude)
            else:
                if args.exclude:
                    raise ValueError("--exclude requires a project directory")
                result = _annotate_functions(args.path, args.language, args.apply)
            _emit({"result": result})
            return 0
        except (OSError, UnicodeError, ValueError) as exc:
            _emit({"error": {"code": "annotation_failed", "message": str(exc)}})
            return 1
    if not args.state:
        parser.error("--state is required")
    raw_output = args.command == "fold" or (args.command == "read" and args.raw)

    def failure(response: dict) -> int:
        if raw_output:
            sys.stderr.write(_json(response) + "\n")
            sys.stderr.flush()
        else:
            _emit(response)
        return 1

    try:
        with Client(args.state, project_dir=args.project_dir) as client:
            if args.command == "rpc":
                return serve_rpc(client, sys.stdin.buffer)
            request = _request(args)
            if ctxf:
                request.setdefault("scope", getattr(args, "scope", "default"))
            if args.command == "read" and args.raw:
                _write_raw(_raw_read(client, request))
                return 0
            response = _call(client, request)
            if "error" in response:
                return failure(response)
            if args.command == "fold":
                if args.json:
                    _emit(response["result"])
                else:
                    _write_raw(response["result"]["text"])
                return 0
            _emit(response)
            return 0
    except (FoldingError, InputError) as exc:
        return failure({"error": _error(exc)})
    except BrokenPipeError:
        # A short buffered write may fail again during Python's exit flush.
        # Redirect the descriptor so closing a downstream pipe stays silent.
        try:
            sink = os.open(os.devnull, os.O_WRONLY)
            try:
                os.dup2(sink, sys.stdout.fileno())
            finally:
                os.close(sink)
        except (OSError, ValueError):
            pass
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception:
        return failure({"error": {"code": "internal_error", "message": "Unable to open or operate the context archive"}})


def main(argv: list[str] | None = None) -> int:
    """Compatibility entry point with explicit state and JSON management output."""
    return _run_cli(argv)


def ctxf_main(argv: list[str] | None = None) -> int:
    """Pipe-friendly entry point with a persistent default archive and namespace."""
    return _run_cli(argv, ctxf=True)
