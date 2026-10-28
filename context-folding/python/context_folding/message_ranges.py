"""Select conversation spans without inventing roles or separating tool pairs."""
from __future__ import annotations

from copy import deepcopy
import json

from .core import MAX_TEXT, _error, _integer


def _tool_ids(message: dict) -> tuple[list[str], list[str]]:
    calls, results = [], []
    for call in message.get("tool_calls", []):
        if not isinstance(call, dict) or not isinstance(call.get("id"), str):
            _error("Invalid tool call")
        calls.append(call["id"])
    if message.get("role") == "tool":
        identifier = message.get("tool_call_id")
        if not isinstance(identifier, str) or not identifier:
            _error("Tool result requires tool_call_id")
        results.append(identifier)
    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                _error("Invalid structured message")
            if part.get("type") in ("tool_use", "tool_result"):
                call = part["type"] == "tool_use"
                identifier = part.get("id" if call else "tool_use_id")
                if not isinstance(identifier, str) or not identifier:
                    _error("Invalid tool block identifier")
                (calls if call else results).append(identifier)
    if message.get("function_call") or message.get("role") == "function":
        _error("Legacy function messages require a host adapter with explicit call IDs")
    return calls, results


def select_messages(messages, region) -> dict:
    if not isinstance(messages, list) or not 1 <= len(messages) <= 10000:
        _error("messages must be a nonempty array")
    if any(not isinstance(message, dict) or message.get("role") not in ("system", "developer", "user", "assistant", "tool", "function") for message in messages):
        _error("Invalid conversation message")
    try:
        serialized = json.dumps(messages, ensure_ascii=False, allow_nan=False)
        if len(serialized.encode("utf-8")) > MAX_TEXT * 4:
            _error("Conversation exceeds the input limit")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _error("messages must contain valid UTF-8 JSON values")
    if not isinstance(region, dict) or set(region) != {"start", "end"}:
        _error("range requires start and end positions")

    def position(value, name):
        if not isinstance(value, dict) or set(value) - {"message", "offset"} or "message" not in value:
            _error(f"Invalid {name} position")
        index = _integer(value["message"], name + " message", 0, len(messages))
        content = messages[index].get("content") if index < len(messages) else None
        offset = _integer(value.get("offset", 0), name + " offset", 0, len(content) if isinstance(content, str) else 0)
        if index < len(messages) and isinstance(content, str) and offset == len(content) and offset:
            index, offset = index + 1, 0
        return index, offset

    start, end = position(region["start"], "start"), position(region["end"], "end")
    if start >= end:
        _error("range must be nonempty and ordered")
    before = deepcopy(messages[:start[0]])
    after = deepcopy(messages[end[0]:])
    if start[1]:
        before.append({**deepcopy(messages[start[0]]), "content": messages[start[0]]["content"][:start[1]]})
    if end[1]:
        after[0]["content"] = messages[end[0]]["content"][end[1]:]
    selected, partial, rows = set(), set(), []
    for index, message in enumerate(messages):
        if index < start[0] or index > end[0] or (index == end[0] and end[1] == 0):
            continue
        if message["role"] in ("system", "developer"):
            _error("Policy messages must remain outside the folded conversation range")
        content = message.get("content")
        low = start[1] if index == start[0] else 0
        high = end[1] if index == end[0] else len(content) if isinstance(content, str) else None
        cut = bool(low or (isinstance(content, str) and high != len(content)))
        calls, results = _tool_ids(message)
        if cut and (calls or results):
            _error("A tool-bearing message cannot be split")
        selected.add(index)
        if cut:
            partial.add(index)
        original = deepcopy(message)
        if isinstance(content, str):
            original["content"] = content[low:high]
        rows.append({"messageIndex": index, "startOffset": low, "endOffset": high,
                     "offsetUnit": "unicode-code-points", "message": original})
    dependencies: dict[str, dict[str, list[int]]] = {}
    for index, message in enumerate(messages):
        calls, results = _tool_ids(message)
        for kind, identifiers in (("calls", calls), ("results", results)):
            for identifier in identifiers:
                dependencies.setdefault(identifier, {"calls": [], "results": []})[kind].append(index)
    for dependency in dependencies.values():
        indices = dependency["calls"] + dependency["results"]
        if any(index in selected for index in indices):
            if len(dependency["calls"]) != 1 or not dependency["results"] or not all(index in selected and index not in partial for index in indices):
                _error("Range must include a complete tool call and all of its results")
    return {"before": before, "after": after, "rows": rows,
            "range": {"start": {"message": start[0], "offset": start[1]},
                      "end": {"message": end[0], "offset": end[1]}}}
