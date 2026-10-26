"""Local reversible archive. Offsets count Unicode code points."""
from __future__ import annotations

import math
import hashlib
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from collections import Counter
from typing import Any

REFERENCE = re.compile(r"\[\[cf:v1:([a-f0-9]{24})\]\]")
MAX_STATE = 64 * 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024


class FoldingError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _error(message: str) -> None:
    raise FoldingError("invalid_request", message)


def _string(value: Any, name: str, maximum: int = 2000) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        _error(f"Invalid {name}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        _error(f"Invalid Unicode in {name}")
    return value


def _integer(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        _error(f"Invalid {name}")
    return value


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _ref(node_id: str) -> str:
    return f"[[cf:v1:{node_id}]]"


def _nodes(snapshot: dict) -> dict:
    return {node["id"]: node for node in snapshot["entries"] + snapshot["groups"]}


def _entry(snapshot: dict, node_id: Any, trash: bool = False) -> dict:
    _string(node_id, "id", 100)
    node = _nodes(snapshot).get(node_id)
    if node is None or (node.get("trashedAt") is not None and not trash):
        raise FoldingError("not_found", "Archive item unavailable in this scope")
    return node


def _ids(value: Any, minimum: int = 0) -> list[str]:
    if not isinstance(value, list) or not minimum <= len(value) <= 10000:
        _error("Invalid ids")
    for item in value:
        _string(item, "id", 100)
    if len(set(value)) != len(value):
        _error("Duplicate ids")
    return value


def _latest(snapshot: dict) -> set[str]:
    heads: dict[str, dict] = {}
    for entry in snapshot["entries"]:
        version = entry.get("version")
        if version and version["number"] > heads.get(version["series"], {}).get("number", 0):
            heads[version["series"]] = {**version, "id": entry["id"]}
    return {head["id"] for head in heads.values()}


def _restore(snapshot: dict, node_id: str) -> None:
    node = _entry(snapshot, node_id)
    node.pop("folded", None)
    node["manual"] = True
    if "children" in node:
        node["enabled"] = False
    else:
        node["mark"] = {"disposition": "unmarked"}
    parents = {child: group for group in snapshot["groups"] for child in group["children"]}
    while node_id in parents:
        parent = parents[node_id]
        parent["enabled"] = False
        parent.pop("folded", None)
        node_id = parent["id"]


def _text(node: dict) -> str:
    if "children" in node:
        return json.dumps({key: node[key] for key in ("id", "summary", "children")}, ensure_ascii=False)
    return node["text"]


class Client:
    """Thread-safe SDK; local scope names are namespaces, not authentication."""
    def __init__(self, state: str | Path, *, project_dir: str | Path | None = None, config: dict | None = None):
        from .config import ConfigError, load_config
        try:
            self.config = load_config(project_dir, overrides=config)
        except ConfigError as exc:
            raise FoldingError("config", str(exc)) from None
        self._lock = threading.RLock()
        path = Path(state).expanduser().absolute()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            raise FoldingError("storage", "State path must not be a symbolic link")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self._db = sqlite3.connect(path, timeout=10, check_same_thread=False)
        self._db.execute("PRAGMA secure_delete=ON")
        self._db.execute("CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self._db.commit()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        with self._lock:
            self._db.close()

    def call(self, request: dict) -> Any:
        if not isinstance(request, dict):
            _error("Expected an object")
        scope = _string(request.get("scope"), "scope", 200)
        _string(request.get("action"), "action", 40)
        with self._lock:
            try:
                self._db.execute("BEGIN IMMEDIATE")
                row = self._db.execute("SELECT data FROM scopes WHERE scope=?", (scope,)).fetchone()
                snapshot = json.loads(row[0]) if row else {"entries": [], "groups": [], "roots": [], "config": {}}
                now = time.time()
                # TOML supplies a per-client default; only gc configure persists policy.
                gc_default = "gc" not in snapshot["config"] and self.config["gc"]["enabled"]
                if gc_default:
                    fields = {"strength": "strength", "idle_seconds": "idleSeconds", "max_uses": "maxUses",
                              "retention_seconds": "retentionSeconds", "auto_purge": "autoPurge"}
                    snapshot["config"]["gc"] = {dest: self.config["gc"][src] for src, dest in fields.items()}
                result = self._dispatch(snapshot, request, now)
                from .lifecycle import maintain_lifecycle
                maintain_lifecycle(snapshot, now, collect=request["action"] not in ("gc", "skills", "restore"))
                if gc_default and not (request["action"] == "gc" and request.get("mode") == "configure"):
                    del snapshot["config"]["gc"]
                encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
                if len(encoded.encode()) > MAX_STATE:
                    raise FoldingError("quota", "Scope quota exceeded")
                total = self._db.execute("SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM scopes WHERE scope<>?", (scope,)).fetchone()[0]
                if total + len(encoded.encode()) > MAX_STATE * 4:
                    raise FoldingError("quota", "Archive quota exceeded")
                self._db.execute("INSERT INTO scopes VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data", (scope, encoded))
                self._db.commit()
                return result
            except FoldingError:
                self._db.rollback()
                raise
            except (ValueError, TypeError, KeyError, RecursionError):
                self._db.rollback()
                raise FoldingError("invalid_request", "Invalid operation or arguments") from None
            except (sqlite3.Error, OSError):
                self._db.rollback()
                raise FoldingError("storage", "Archive or destination unavailable") from None

    def put(self, scope: str, text: str, **options):
        return self.call({**options, "action": "put", "scope": scope, "text": text})

    def read(self, scope: str, id: str, **options):
        return self.call({**options, "action": "read", "scope": scope, "id": id})

    def list(self, scope: str, **options):
        return self.call({**options, "action": "list", "scope": scope})

    def mark(self, scope: str, id: str, disposition: str, **options):
        return self.call({**options, "action": "mark", "scope": scope, "id": id, "disposition": disposition})

    def render(self, scope: str, ids: list[str], **options):
        return self.call({**options, "action": "render", "scope": scope, "ids": ids})

    def resolve(self, scope: str, value: Any):
        return self.call({"action": "resolve", "scope": scope, "value": value})

    def annotate(self, scope: str, **options):
        return self.call({**options, "action": "annotate", "scope": scope})

    def read_source(self, scope: str, **options):
        return self.call({**options, "action": "read-source", "scope": scope})

    def _source(self, snapshot: dict, request: dict, now: float) -> dict:
        from .annotations import comment_styles, discover_source, select_regions
        if "files" in request:
            files = request["files"]
            if not isinstance(files, list) or not 1 <= len(files) <= 100 or any(not isinstance(f, dict) for f in files):
                _error("Invalid source batch")
            if any(key in request for key in ("text", "path", "id")) or any("files" in f for f in files):
                _error("Ambiguous source batch")
            defaults = {k: v for k, v in request.items() if k != "files"}
            return {"files": [self._source(snapshot, {**defaults, **item, "action": request["action"], "scope": request["scope"]}, now) for item in files]}
        inputs = [key for key in ("text", "path", "id") if key in request]
        if len(inputs) != 1:
            _error("Supply exactly one source text, path or id")
        language = request.get("language")
        if language is not None:
            _string(language, "language", 100)
        if "id" in request:
            node = _entry(snapshot, request["id"])
            if "text" not in node:
                _error("Source must be an entry")
            text = node["text"]
            path = node.get("source", {}).get("path")
        else:
            path = request.get("path")
            if path is not None:
                _string(path, "path", 4096)
                source_path = Path(path)
                if not source_path.is_absolute() or not source_path.is_file():
                    _error("Source path must be an absolute regular file")
                with source_path.open("rb") as source_file:
                    data = source_file.read(MAX_TEXT * 4 + 1)
                if len(data) > MAX_TEXT * 4:
                    _error("Source too large")
                try:
                    text = data.decode("utf-8")
                except UnicodeError:
                    _error("Source must be UTF-8")
            else:
                text = request["text"]
            _string(text, "text", MAX_TEXT)
            options = {"action": "put", "scope": request["scope"], "text": text}
            if path:
                options["source"] = {"path": str(Path(path).absolute()), "range": "full"}
            node = _entry(snapshot, self._put(snapshot, options, now)["id"])
        if not self.config["annotations"]["enabled"] and request["action"] == "read-source":
            return self._read(snapshot, {**request, "action": "read", "id": node["id"], "mode": request.get("mode", "original")}, now)
        if language is not None:
            language = "python" if language.lower() == "py" else language.lower()
        annotation = node.get("annotation")
        # Decisions belong to this immutable original, even when a parser/style
        # change temporarily stops discovering their regions. Import legacy marks.
        manual = {(r["name"], r["start"], r["end"]): r["disposition"]
                  for r in node.get("annotationMarks", [])}
        if annotation:
            manual.update({(r["name"], r["start"], r["end"]): r["disposition"]
                           for r in annotation["regions"] if r.get("manual")})
        styles = comment_styles(request["commentStyles"]) if "commentStyles" in request else (
            annotation.get("commentStyles", []) if annotation else [])
        if annotation is None or (language is not None and annotation["language"] != language) or styles != annotation.get("commentStyles", []):
            annotation = discover_source(text, language or (annotation["language"] if annotation else None), path, styles)
            # Payloads and the exact original commit together in Client.call.
            for region in annotation["regions"]:
                disposition = manual.get((region["name"], region["start"], region["end"]))
                if disposition is not None:
                    region.update(disposition=disposition, manual=True)
                result = self._put(snapshot, {"scope": request["scope"], "text": text[region["start"]:region["end"]]}, now)
                region.update(archiveId=result["id"], reference=result["reference"])
            node["annotation"] = annotation
        keep = select_regions(annotation["regions"], request.get("keep", []))
        for region in annotation["regions"]:
            if region["id"] in keep:
                region["disposition"] = "keep"
                region["manual"] = True
        marks = request.get("marks", [])
        if not isinstance(marks, list) or len(marks) > 10000:
            _error("Invalid source marks")
        for mark in marks:
            if not isinstance(mark, dict) or mark.get("disposition") not in ("foldable", "keep", "unmarked"):
                _error("Invalid source mark")
            selected = select_regions(annotation["regions"], [mark.get("id", mark.get("name"))])
            for region in annotation["regions"]:
                if region["id"] in selected:
                    region["disposition"] = mark["disposition"]
                    region["manual"] = True
        manual.update({(r["name"], r["start"], r["end"]): r["disposition"]
                       for r in annotation["regions"] if r.get("manual")})
        if manual:
            node["annotationMarks"] = [{"name": name, "start": start, "end": end,
                                        "disposition": disposition}
                                       for (name, start, end), disposition in manual.items()]
        if request["action"] == "read-source":
            return self._read(snapshot, {**request, "action": "read", "id": node["id"]}, now)
        return {"id": node["id"], "reference": _ref(node["id"]),
                "sha256": hashlib.sha256(text.encode()).hexdigest(), **annotation}

    def _dispatch(self, snapshot: dict, request: dict, now: float) -> Any:
        action = request["action"]
        if action in ("annotate", "read-source"):
            return self._source(snapshot, request, now)
        if action == "put":
            return self._put(snapshot, request, now)
        if action in ("gc", "roots", "pin", "skills"):
            from .lifecycle import dispatch_lifecycle
            return dispatch_lifecycle(snapshot, request, now)
        if action == "list":
            return self._browse(snapshot, request)
        if action == "mark":
            marks = request.get("marks", [request])
            if not isinstance(marks, list) or not 1 <= len(marks) <= 100:
                _error("Invalid marks")
            for mark in marks:
                if not isinstance(mark, dict):
                    _error("Invalid mark")
                node = _entry(snapshot, mark.get("id"))
                disposition = mark.get("disposition")
                if disposition not in ("foldable", "keep", "unmarked"):
                    _error("Invalid disposition")
                if disposition == "foldable":
                    summary = _string(mark.get("summary"), "summary").strip()
                    if not summary:
                        _error("Empty summary")
                    node["manual"] = True
                    if "children" in node:
                        node.update(summary=summary, enabled=True)
                    else:
                        node["mark"] = {"disposition": disposition, "summary": summary}
                else:
                    _restore(snapshot, node["id"])
                    if "text" in node:
                        node["mark"] = {"disposition": disposition}
            return {"marked": len(marks)}
        if action == "restore":
            _restore(snapshot, request.get("id"))
            return {"restored": True}
        if action == "group":
            return self._group(snapshot, request, now)
        if action == "render":
            return self._render(snapshot, request, now)
        if action == "resolve":
            return self._resolve(snapshot, request, now)
        if action in ("read", "paste"):
            return self._read(snapshot, request, now)
        if action == "status":
            return {"entries": len(snapshot["entries"]), "groups": len(snapshot["groups"]),
                    "roots": len(snapshot["roots"]), "folded": sum("folded" in n for n in _nodes(snapshot).values()),
                    "trashed": sum(n.get("trashedAt") is not None for n in _nodes(snapshot).values()),
                    "offsetUnit": "unicode-code-points"}
        _error("Unknown action")

    def _put(self, snapshot: dict, request: dict, now: float) -> dict:
        text = _string(request.get("text"), "text", MAX_TEXT)
        role = request.get("role", "tool")
        if role not in ("user", "assistant", "tool"):
            _error("Invalid role")
        source = request.get("source")
        if source is not None:
            if not isinstance(source, dict):
                _error("Invalid source")
            source = {"path": _string(source.get("path"), "source path", 4096),
                      "range": _string(source.get("range", "full"), "source range", 200)}
        series = _hash([source["path"], source["range"]])[:24] if source else None
        previous = max((n for n in snapshot["entries"] if series is not None and
                        n.get("version", {}).get("series") == series),
                       key=lambda n: n["version"]["number"], default=None)
        node_id = _hash([request["scope"], role, source, text])[:24]
        # A reverted file is a new observation; consecutive identical reads reuse
        # the current head. Keep the version graph acyclic and its originals intact.
        if previous is not None:
            if previous["text"] == text and previous["role"] == role:
                node_id = previous["id"]
            elif node_id in _nodes(snapshot):
                node_id = _hash([node_id, previous["id"], previous["version"]["number"] + 1])[:24]
        existing = _nodes(snapshot).get(node_id)
        if existing:
            if existing.get("text") != text:
                _error("Archive ID collision")
            existing.pop("trashedAt", None)
            existing["lastUsedAt"] = now
            if node_id not in snapshot["roots"]:
                snapshot["roots"].append(node_id)
            return {"id": node_id, "reference": _ref(node_id), "version": existing.get("version")}
        entry = {"id": node_id, "text": text, "role": role, "createdAt": now,
                 "lastUsedAt": now, "reads": 0, "folds": 0, "mark": {"disposition": "unmarked"}}
        kind = "file" if source else "similar"
        if source:
            entry["source"] = source
        else:
            if role != "user" and 1024 <= len(text) <= 262144:
                right = Counter(text.splitlines())
                best = 0.92
                for candidate in snapshot["entries"][-64:]:
                    if candidate["role"] != role or candidate.get("source") or candidate.get("trashedAt") is not None:
                        continue
                    left = Counter(candidate["text"].splitlines())
                    if min(len(left), len(right)) < 8:
                        continue
                    overlap = sum((len(line) + 1) * count for line, count in (left & right).items())
                    score = overlap / (max(len(text), len(candidate["text"])) + 1)
                    if score >= best:
                        best, previous = score, candidate
                if previous:
                    series = previous.get("version", {}).get("series", _hash([previous["id"]])[:24])
                    previous.setdefault("version", {"series": series, "number": 1, "kind": kind})
                    previous = max((n for n in snapshot["entries"] if
                                    n.get("version", {}).get("series") == series),
                                   key=lambda n: n["version"]["number"])
        if series is not None:
            entry["version"] = {"series": series, "number": previous["version"]["number"] + 1 if previous else 1, "kind": kind}
            if previous:
                entry["version"]["previousId"] = previous["id"]
                if not previous.get("manual") and previous["mark"]["disposition"] != "keep":
                    remaining = Counter(text.splitlines())
                    removed = []
                    for line in previous["text"].splitlines():
                        if remaining[line]:
                            remaining[line] -= 1
                        else:
                            removed.append(line)
                    delta = json.dumps(removed, ensure_ascii=False)
                    if len(delta) <= 1400:
                        qualifier = "Old file observation" if source else "Similar earlier observation; similarity is not supersession"
                        previous["mark"] = {"disposition": "foldable", "summary": f"{qualifier}; newer version {entry['version']['number']}. Old-only lines: {delta}"}
        snapshot["entries"].append(entry)
        snapshot["roots"].append(node_id)
        return {"id": node_id, "reference": _ref(node_id), "version": entry.get("version")}

    def _group(self, snapshot: dict, request: dict, now: float) -> dict:
        children = _ids(request.get("ids"), 2)
        if len(children) > 100:
            _error("Too many group children")
        summary = _string(request.get("summary"), "summary").strip()
        if not summary:
            _error("Empty summary")
        parents = {child for group in snapshot["groups"] for child in group["children"]}
        latest = _latest(snapshot)
        pending = list(children)
        while pending:
            node = _entry(snapshot, pending.pop())
            if "children" in node:
                pending.extend(node["children"])
            elif node["role"] == "user" or node["mark"]["disposition"] == "keep" or node["id"] in latest:
                _error("Protected entry cannot be grouped")
        node_id = _hash([request["scope"], children, summary])[:24]
        existing = _nodes(snapshot).get(node_id)
        if existing:
            existing["enabled"] = True
            return {"id": node_id, "reference": _ref(node_id)}
        if parents.intersection(children):
            _error("Group children must be root nodes")
        snapshot["groups"].append({"id": node_id, "children": children, "summary": summary, "enabled": True,
                                   "createdAt": now, "lastUsedAt": now, "reads": 0, "folds": 0})
        return {"id": node_id, "reference": _ref(node_id)}

    def _render(self, snapshot: dict, request: dict, now: float) -> dict:
        ids = _ids(request.get("ids"))
        protected = set(_ids(request.get("protected", [])))
        latest = _latest(snapshot)
        nodes = [_entry(snapshot, node_id) for node_id in ids]
        def descendants(node):
            members, seen, pending = [], set(), [node]
            while pending:
                current = pending.pop()
                if current["id"] in seen:
                    _error("Overlapping or cyclic group")
                seen.add(current["id"])
                members.append(current)
                pending.extend(_entry(snapshot, child) for child in reversed(current.get("children", [])))
            return members
        output = []
        occupied = set()
        before = after = 0
        for node in nodes:
            descendants_ = descendants(node)
            member_ids = {n["id"] for n in descendants_}
            if occupied & member_ids:
                _error("Overlapping render selections")
            occupied.update(member_ids)
            members = [n for n in descendants_ if "children" not in n]
            original = (json.dumps([{key: n[key] for key in ("id", "role", "text")} for n in members],
                                   ensure_ascii=False, separators=(",", ":"))
                        if "children" in node else node["text"])
            safe = not (member_ids & protected) and all(
                n["role"] != "user" and n["mark"]["disposition"] != "keep" and n["id"] not in latest
                and not (n.get("manual") and n["mark"]["disposition"] == "unmarked") for n in members)
            safe = safe and all(n.get("enabled", True) for n in descendants_ if "children" in n)
            enabled = node.get("enabled", False) if "children" in node else node["mark"]["disposition"] == "foldable"
            summary = node.get("summary", node.get("mark", {}).get("summary", ""))
            folded = _ref(node["id"]) + " " + summary
            use = enabled and safe and len(folded) < len(original)
            if use:
                node["folded"] = folded
                node["folds"] = node.get("folds", 0) + 1
            else:
                node.pop("folded", None)
            node["lastUsedAt"] = now
            value = folded if use else original
            output.append({"id": node["id"], "text": value, "folded": use})
            before += len(original)
            after += len(value)
        return {"entries": output, "beforeChars": before, "afterChars": after}

    def _resolve(self, snapshot: dict, request: dict, now: float) -> dict:
        if "value" not in request:
            _error("Missing value")
        count = size = visited = 0
        def charge(amount):
            nonlocal size
            size += amount
            if size > MAX_TEXT * 4:
                _error("Resolved value too large")
        def visit(value, depth=0):
            nonlocal count, visited
            visited += 1
            if depth > 64 or visited > 100000:
                _error("Value nesting or item limit exceeded")
            charge(1)
            if isinstance(value, str):
                _string(value, "value", MAX_TEXT * 4) if value else None
                parts, start = [], 0
                for match in REFERENCE.finditer(value):
                    literal = value[start:match.start()]
                    if "[[cf:" in literal:
                        _error("Malformed or unsupported reference")
                    node = _entry(snapshot, match.group(1))
                    if "children" in node:
                        _error("Group manifests cannot be substituted into tool parameters")
                    charge(len(literal.encode("utf-8")) + len(node["text"].encode("utf-8")))
                    parts.extend((literal, node["text"]))
                    node["reads"] += 1
                    node["lastUsedAt"] = now
                    count += 1
                    start = match.end()
                tail = value[start:]
                if "[[cf:" in tail:
                    _error("Malformed or unsupported reference")
                charge(len(tail.encode("utf-8")))
                parts.append(tail)
                # One pass: archived text is data, never recursively interpreted.
                return "".join(parts)
            if isinstance(value, list):
                return [visit(item, depth + 1) for item in value]
            if isinstance(value, dict):
                result = {}
                for key, item in value.items():
                    if not isinstance(key, str):
                        _error("JSON object keys must be strings")
                    charge(len(key.encode("utf-8")))
                    result[key] = visit(item, depth + 1)
                return result
            if value is None or type(value) is bool:
                return value
            if type(value) in (int, float):
                if type(value) is float and not math.isfinite(value):
                    _error("Invalid JSON number")
                charge(len(str(value)))
                return value
            _error("Expected a JSON value")
        return {"value": visit(request["value"]), "resolved": count}

    def _read(self, snapshot: dict, request: dict, now: float) -> dict:
        node = _entry(snapshot, request.get("id"))
        text = _text(node)
        original = text
        source_view = {}
        default_fold = self.config["annotations"]["enabled"] and self.config["annotations"]["default_fold"]
        mode = request.get("mode", "folded" if node.get("annotation") and request["action"] == "read" and default_fold else "original")
        if mode not in ("folded", "original"):
            _error("Invalid read mode")
        if node.get("annotation") and request["action"] == "read":
            from .annotations import compact_source, select_regions
            expand_mode = request.get("expandMode", "recursive")
            if expand_mode not in ("single", "recursive"):
                _error("Invalid source expand mode")
            select_regions(node["annotation"]["regions"], request.get("expand", []))
            if mode == "folded":
                annotation = {**node["annotation"], "regions": [dict(r) for r in node["annotation"]["regions"]]}
                for region in annotation["regions"]:
                    if not region.get("manual") and any(fnmatchcase(region["name"], pattern) for pattern in self.config["annotations"]["keep"]):
                        region["disposition"] = "keep"
                view = compact_source(text, annotation, request.get("expand", []),
                                      node["mark"]["disposition"] == "keep" or
                                      bool(node.get("manual") and node["mark"]["disposition"] == "unmarked"),
                                      expand_mode=expand_mode)
                text = view.pop("text")
                source_view = view
            source_view.update(mode=mode, reference=_ref(node["id"]),
                               originalChars=len(original), originalSha256=hashlib.sha256(original.encode()).hexdigest(),
                               parser=node["annotation"]["parser"], limitations=node["annotation"]["limitations"])
        offset = _integer(request.get("offset", 0), "offset", 0, len(text))
        limit = _integer(request.get("limit", len(text) or 1) if request["action"] == "paste" else request.get("limit", 4000), "limit", 1, MAX_TEXT if request["action"] == "paste" else 24000)
        end = min(len(text), offset + limit)
        part = text[offset:end]
        node["reads"] += 1
        node["lastUsedAt"] = now
        result = {"id": node["id"], "offset": offset, "nextOffset": end if end < len(text) else None,
                  "totalChars": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()}
        if request["action"] == "paste":
            path = Path(_string(request.get("path"), "path", 4096))
            if not path.is_absolute():
                _error("Destination must be absolute")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as destination:
                destination.write(part)
            return {**result, "path": str(path), "chars": len(part), "bytes": len(part.encode()), "sha256": hashlib.sha256(part.encode()).hexdigest()}
        return {**result, **source_view, "text": part, "version": node.get("version"), "latestVersion": node["id"] in _latest(snapshot)}

    def _browse(self, snapshot: dict, request: dict) -> dict:
        depth = _integer(request.get("depth", 1), "depth", 0, 8)
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 20), "limit", 1, 100)
        sort = request.get("sort", "chronological")
        order = request.get("order", "asc")
        if sort not in ("chronological", "size", "id", "version") or order not in ("asc", "desc"):
            _error("Invalid sort or order")
        nodes = {key: value for key, value in _nodes(snapshot).items() if value.get("trashedAt") is None}
        parents = {child: group["id"] for group in snapshot["groups"] if group.get("trashedAt") is None for child in group["children"]}
        included = None
        query = request.get("query")
        if query is not None:
            _string(query, "query", 200)
            included = set()
            for node in nodes.values():
                if query.casefold() in (node["id"] + _text(node) + str(node.get("source", {})) + str(node.get("mark", {}))).casefold():
                    node_id = node["id"]
                    while node_id and node_id not in included:
                        included.add(node_id)
                        node_id = parents.get(node_id)
        def key(node_id):
            node = nodes[node_id]
            primary = {"chronological": node.get("createdAt", 0), "size": len(_text(node)), "id": node_id,
                       "version": (node.get("version", {}).get("series", ""), node.get("version", {}).get("number", 0))}[sort]
            return primary, node_id
        roots = [request["id"]] if "id" in request else [node_id for node_id in nodes if node_id not in parents]
        if any(node_id not in nodes for node_id in roots):
            _error("Unknown subtree")
        output = []
        latest = _latest(snapshot)
        def walk(ids, level):
            for node_id in sorted(ids, key=key, reverse=order == "desc"):
                if included is not None and node_id not in included:
                    continue
                node = nodes[node_id]
                output.append({"id": node_id, "parentId": parents.get(node_id), "depth": level,
                               "role": node.get("role", "group"), "chars": len(_text(node)),
                               "childCount": len(node.get("children", [])), "folded": "folded" in node,
                               "disposition": node.get("mark", {}).get("disposition", "foldable" if node.get("enabled") else "unmarked"),
                               "summary": node.get("summary", node.get("mark", {}).get("summary", ""))[:240],
                               "version": node.get("version"), "latestVersion": node_id in latest})
                if level < depth:
                    walk(node.get("children", []), level + 1)
        walk(roots, 0)
        page = output[offset:offset + limit]
        return {"entries": page, "total": len(output), "nextOffset": offset + len(page) if offset + len(page) < len(output) else None}
