"""Local CLI, JSON Lines RPC, and MCP stdio transport."""
from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any, BinaryIO

from .core import Client, FoldingError

MAX_INPUT_BYTES = 8 * 1024 * 1024
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
ACTIONS = ("put", "list", "mark", "read", "render", "group", "restore", "resolve", "paste", "status", "gc", "roots", "pin", "skills", "annotate", "read-source")
TOOL_SCHEMA = {
    "type": "object",
    "required": ["action", "scope"],
    "properties": {
        "action": {"type": "string", "enum": list(ACTIONS)},
        "scope": {"type": "string", "minLength": 1, "maxLength": 200},
        "text": {"type": "string"},
        "language": {"type": "string"},
        "keep": {"type": "array", "items": {"type": "string"}},
        "expand": {"type": "array", "items": {"type": "string"}},
        "files": {"type": "array", "minItems": 1, "maxItems": 100, "items": {"type": "object"}},
        "id": {"type": "string"},
        "ids": {"type": "array", "items": {"type": "string"}},
        "role": {"type": "string"},
        "source": {"type": "object"},
        "summary": {"type": "string"},
        "disposition": {"type": "string", "enum": ["foldable", "keep", "unmarked"]},
        "protected": {"type": "array", "items": {"type": "string"}},
        "value": {},
        "query": {"type": "string"},
        "path": {"type": "string"},
        "marks": {"type": "array", "items": {"type": "object"}},
        "mode": {"type": "string"},
        "config": {"type": "object"},
        "body": {"type": "string"},
        "description": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1},
        "offset": {"type": "integer", "minimum": 0},
        "depth": {"type": "integer", "minimum": 0, "maximum": 8},
        "sort": {"type": "string", "enum": ["chronological", "size", "id", "version"]},
        "order": {"type": "string", "enum": ["asc", "desc"]},
        "name": {"type": "string"},
        "pinned": {"type": "boolean"},
    },
    "additionalProperties": True,
}
TOOL = {
    "name": "context_folding",
    "description": "Archive, fold and restore scoped context. Resolve references immediately before executing other tools; the host must perform that step.",
    "inputSchema": TOOL_SCHEMA,
}


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


def _rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class MCPServer:
    def __init__(self, client: Client):
        self.client = client
        self.initialized = False

    def handle(self, request: Any) -> dict[str, Any] | None:
        if not isinstance(request, dict):
            return _rpc_error(None, -32600, "Invalid Request")
        request_id = request.get("id")
        valid_id = request_id is None or isinstance(request_id, str) or (
            isinstance(request_id, (int, float)) and not isinstance(request_id, bool)
            and (not isinstance(request_id, float) or math.isfinite(request_id))
        )
        if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str) or not valid_id:
            return _rpc_error(None, -32600, "Invalid Request")
        # All notifications are silent, including unknown extensions. They may
        # never invoke archive operations or consume a request/response slot.
        if "id" not in request:
            return None
        method = request["method"]
        params = request.get("params", {})
        if not isinstance(params, dict):
            return _rpc_error(request_id, -32602, "Params must be an object")
        if method == "initialize":
            if not isinstance(params.get("protocolVersion"), str) or not params["protocolVersion"]:
                return _rpc_error(request_id, -32602, "protocolVersion must be a nonempty string")
            if not isinstance(params.get("capabilities"), dict) or not isinstance(params.get("clientInfo"), dict):
                return _rpc_error(request_id, -32602, "capabilities and clientInfo must be objects")
            version = params["protocolVersion"]
            result = {
                "protocolVersion": version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "context-folding", "version": "0.1.0"},
                "instructions": "Call resolve immediately before dispatching other tools. This MCP server cannot intercept calls to other tools.",
            }
            self.initialized = True
        elif method == "ping":
            result = {}
        elif not self.initialized:
            return _rpc_error(request_id, -32000, "Initialize the server first")
        elif method == "tools/list":
            result = {"tools": [TOOL]}
        elif method == "tools/call":
            if params.get("name") != TOOL["name"]:
                return _rpc_error(request_id, -32602, "Unknown tool")
            arguments = params.get("arguments", {})
            if not isinstance(arguments, dict):
                return _rpc_error(request_id, -32602, "Tool arguments must be an object")
            response = _call(self.client, arguments)
            failed = "error" in response
            result = {
                "content": [{"type": "text", "text": _json(response if failed else response["result"])}],
                "isError": failed,
            }
        else:
            return _rpc_error(request_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve_mcp(client: Client, stream: BinaryIO) -> int:
    server = MCPServer(client)
    for frame in _lines(stream):
        try:
            if isinstance(frame, InputError):
                raise frame
            response = server.handle(_loads(frame))
        except InputError as exc:
            response = _rpc_error(None, -32600 if exc.code == "input_too_large" else -32700, exc.message)
        except Exception:
            response = _rpc_error(None, -32603, "Internal error")
        if response is not None:
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local reversible context archive; no model calls.")
    parser.add_argument("--state", help="SQLite state file (also accepted after the command)")
    parser.add_argument("--project-dir", help="Project settings discovery directory (default: current directory)")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("rpc", "mcp", "call", *ACTIONS):
        sub = commands.add_parser(command)
        sub.add_argument("--state", default=argparse.SUPPRESS, help="SQLite state file")
        sub.add_argument("--project-dir", default=argparse.SUPPRESS, help="Project settings discovery directory")
        if command in ("rpc", "mcp"):
            continue
        sub.add_argument("--json", metavar="JSON", help="Request object; '-' reads JSON stdin")
        if command == "call":
            continue
        sub.add_argument("--scope", required=True)
        for name in ("id", "text", "summary", "role", "disposition", "query", "name", "description", "path", "mode", "body", "sort", "order", "language"):
            sub.add_argument("--" + name, default=argparse.SUPPRESS)
        for name in ("ids", "protected", "keep", "expand"):
            sub.add_argument("--" + name, nargs="*", default=argparse.SUPPRESS)
        for name in ("source", "value", "config", "marks", "files"):
            sub.add_argument("--" + name, default=argparse.SUPPRESS, help="JSON value; '-' reads JSON stdin")
        for name in ("limit", "offset", "depth"):
            sub.add_argument("--" + name, type=int, default=argparse.SUPPRESS)
        sub.add_argument("--pinned", action=argparse.BooleanOptionalAction, default=argparse.SUPPRESS)
    return parser


def _request(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "call":
        return _object(_loads(_read_stdin()) if args.json in (None, "-") else _argument_json(args.json))
    json_fields = ("source", "value", "config", "marks", "files")
    text_fields = ("text", "summary", "body")
    stdin_used = False

    def input_value(raw: str, is_json: bool) -> Any:
        nonlocal stdin_used
        if raw == "-":
            if stdin_used:
                raise InputError("invalid_request", "Only one input may read stdin")
            stdin_used = True
        return (_loads(_read_stdin()) if raw == "-" else _argument_json(raw)) if is_json else _text(raw)

    request = {} if args.json is None else _object(input_value(args.json, True))
    excluded = ("command", "state", "project_dir", "json", *json_fields, *text_fields)
    request.update({key: value for key, value in vars(args).items() if key not in excluded})
    for key in json_fields + text_fields:
        if hasattr(args, key):
            request[key] = input_value(getattr(args, key), key in json_fields)
    request["action"] = args.command
    if args.command == "put" and "text" not in request:
        request["text"] = input_value("-", False)
    return request


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.state:
        parser.error("--state is required")
    try:
        with Client(args.state, project_dir=args.project_dir) as client:
            if args.command == "rpc":
                return serve_rpc(client, sys.stdin.buffer)
            if args.command == "mcp":
                return serve_mcp(client, sys.stdin.buffer)
            response = _call(client, _request(args))
            _emit(response)
            return 1 if "error" in response else 0
    except (FoldingError, InputError) as exc:
        _emit({"error": _error(exc)})
        return 1
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception:
        _emit({"error": {"code": "internal_error", "message": "Unable to open or operate the context archive"}})
        return 1
