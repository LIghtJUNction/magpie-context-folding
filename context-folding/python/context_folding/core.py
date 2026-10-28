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
from typing import Any

REFERENCE = re.compile(r"\[\[cf:(v1|v2):([a-f0-9]{12,64})\]\]")
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


def _content_hash(node: dict) -> str:
    return hashlib.sha256(node["text"].encode("utf-8")).hexdigest()


def _short_hash(snapshot: dict, full: str) -> str:
    texts = {}
    for node in snapshot["entries"]:
        sha256 = _content_hash(node)
        if sha256 in texts and texts[sha256] != node["text"]:
            raise FoldingError("hash_collision", "Different originals have the same content hash")
        texts[sha256] = node["text"]
    hashes = texts.keys()
    length = 12
    while any(other != full and other.startswith(full[:length]) for other in hashes):
        length += 2
    return full[:length]


def _entry(snapshot: dict, node_id: Any, trash: bool = False, *, content_hash: bool = False) -> dict:
    _string(node_id, "id", 100)
    node = None if content_hash else _nodes(snapshot).get(node_id)
    if node is None and re.fullmatch(r"[a-f0-9]{12,64}", node_id):
        matches = [n for n in snapshot["entries"] if _content_hash(n).startswith(node_id)
                   and (trash or n.get("trashedAt") is None)]
        if len({n["text"] for n in matches}) > 1:
            raise FoldingError("ambiguous_hash", "Ambiguous content hash; supply a longer prefix")
        node = next(iter(matches), None)
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
                query = request["action"] in ("read", "list", "grep", "meta", "status")
                self._db.execute("BEGIN" if query else "BEGIN IMMEDIATE")
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
                if query:
                    # Inspection is a snapshot query. It never renews retention,
                    # pins a payload, changes fold decisions or runs collection.
                    self._db.rollback()
                    return result
                if request["action"] == "fold" and not result["references"]:
                    # A literal/no-benefit pass creates no archive or lifecycle
                    # writes and is not blocked by a quota for new payloads.
                    self._db.rollback()
                    return result
                from .lifecycle import maintain_lifecycle
                maintain_lifecycle(snapshot, now, collect=request["action"] not in ("gc", "skills", "restore"))
                if gc_default and not (request["action"] == "gc" and request.get("mode") == "configure"):
                    del snapshot["config"]["gc"]
                encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
                # Lowering the next-write quota must not make existing originals
                # unreadable. Recovery cannot add archived payloads.
                recovery = request["action"] in ("read", "paste", "resolve", "restore")
                ceiling = MAX_STATE if recovery else min(MAX_STATE, self.config["folding"]["max_session_bytes"])
                if len(encoded.encode()) > ceiling:
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

    def fold(self, scope: str, text: str, **options):
        """Immediately fold explicitly annotated text in one durable transaction."""
        return self.call({**options, "action": "fold", "scope": scope, "text": text})

    def read(self, scope: str, id: str, **options):
        return self.call({**options, "action": "read", "scope": scope, "id": id})

    def list(self, scope: str, **options):
        return self.call({**options, "action": "list", "scope": scope})

    def grep(self, scope: str, query: str, **options):
        return self.call({**options, "action": "grep", "scope": scope, "query": query})

    def meta(self, scope: str, id: str, **options):
        return self.call({**options, "action": "meta", "scope": scope, "id": id})

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
            results = []
            for index, item in enumerate(files):
                fields = {**defaults, **item, "action": request["action"], "scope": request["scope"]}
                if "occurrence" in defaults and "occurrence" not in item:
                    # Batch positions are separate appearances even when their
                    # content is equal. Reorders safely restart affected delays.
                    fields["occurrence"] = _hash([defaults["occurrence"], "file", index])
                results.append(self._source(snapshot, fields, now))
            return {"files": results}
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
        if (not self.config["folding"]["enabled"] or not self.config["annotations"]["enabled"]) and request["action"] == "read-source":
            return self._source_read(snapshot, {**request, "action": "read", "id": node["id"], "mode": request.get("mode", "original")}, now)
        if language is not None:
            from .javascript import normalize_language
            language = "python" if language.lower() == "py" else normalize_language(language)
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
        if annotation is None or annotation.get("version") != 2 or annotation.get("graphVersion") != 1 or (language is not None and annotation["language"] != language) or styles != annotation.get("commentStyles", []):
            annotation = discover_source(text, language or (annotation["language"] if annotation else None), path, styles,
                                         include_reference_regions=True)
            annotation["version"] = 2
            annotation["graphVersion"] = 1
            # Payloads and the exact original commit together in Client.call.
            annotation = self._archive_regions(snapshot, annotation, text, request["scope"], now, source=True)
            for region in annotation["regions"]:
                disposition = manual.get((region["name"], region["start"], region["end"]))
                if disposition is not None:
                    region.update(disposition=disposition, manual=True)
            node["annotation"] = annotation
            node["foldChildren"] = self._region_children(annotation["regions"], None, 0)
        for region in annotation["regions"]:
            region["reference"] = f"[[cf:v2:{_short_hash(snapshot, region['sha256'])}]]"
        keep = select_regions(annotation["regions"], request.get("keep", []))
        keep |= select_regions(annotation["regions"], request.get("expand", []))
        for region in annotation["regions"]:
            if region["id"] in keep:
                region["disposition"] = "keep"
                region["manual"] = True
        if "marks" in request:
            _error("Source marks were removed; use explicit annotations and expand/keep selectors")
        manual.update({(r["name"], r["start"], r["end"]): r["disposition"]
                       for r in annotation["regions"] if r.get("manual")})
        if manual:
            node["annotationMarks"] = [{"name": name, "start": start, "end": end,
                                        "disposition": disposition}
                                       for (name, start, end), disposition in manual.items()]
        if request["action"] == "read-source":
            return self._source_read(snapshot, {**request, "action": "read", "id": node["id"], "_sourceProjection": True}, now)
        return {"id": node["id"], "reference": _ref(node["id"]),
                "sha256": hashlib.sha256(text.encode()).hexdigest(), **annotation}

    def _dispatch(self, snapshot: dict, request: dict, now: float) -> Any:
        action = request["action"]
        if action == "fold":
            return self._fold(snapshot, request, now)
        if action in ("annotate", "read-source"):
            return self._source(snapshot, request, now)
        if action == "put":
            return self._put(snapshot, request, now)
        if action in ("gc", "roots", "pin", "skills"):
            from .lifecycle import dispatch_lifecycle
            return dispatch_lifecycle(snapshot, request, now)
        if action == "list":
            return self._browse(snapshot, request)
        if action == "grep":
            return self._grep(snapshot, request)
        if action == "meta":
            return self._meta(snapshot, request)
        if action in ("mark", "group"):
            _error("mark/group were removed; use explicit @context-fold begin/end annotations")
        if action == "restore":
            _restore(snapshot, request.get("id"))
            return {"restored": True}
        if action == "render":
            return self._render(snapshot, request, now)
        if action == "resolve":
            return self._resolve(snapshot, request, now)
        if action == "read":
            return self._read(snapshot, request)
        if action == "paste":
            return self._source_read(snapshot, request, now)
        if action == "status":
            return {"entries": len(snapshot["entries"]), "groups": len(snapshot["groups"]),
                    "roots": len(snapshot["roots"]), "folded": sum("folded" in n for n in _nodes(snapshot).values()),
                    "trashed": sum(n.get("trashedAt") is not None for n in _nodes(snapshot).values()),
                    "offsetUnit": "unicode-code-points"}
        _error("Unknown action")

    def _fold(self, snapshot: dict, request: dict, now: float) -> dict:
        """An explicit operation, independent of host-driven projection cycles.

        The caller publishes this complete projection only after Client.call has
        committed every referenced original. Existing references remain literal.
        """
        from .annotations import compact_source, discover_source
        if set(request) - {"action", "scope", "text", "language", "commentStyles"}:
            _error("fold accepts only scope, text, language and commentStyles")
        text = request.get("text")
        if text != "":
            _string(text, "text", MAX_TEXT)
        language = request.get("language")
        if language is not None:
            _string(language, "language", 100)
        annotation = discover_source(text, language, styles=request.get("commentStyles"),
                                     include_reference_regions=True)
        annotation = self._archive_regions(snapshot, annotation, text, request["scope"], now)
        view = compact_source(text, annotation, allow_reference_literals=True)
        by_location = {(r["id"], r["startLine"], r["endLine"]): r for r in annotation["regions"]}
        references = []
        for item in view["foldedRegions"]:
            region = by_location[item["id"], item["startLine"], item["endLine"]]
            references.append({"id": region["sha256"], "label": region["name"],
                               "sha256": region["sha256"], "reference": region["reference"],
                               "archiveId": region["archiveId"]})
        return {"scope": request["scope"], "text": view["text"], "references": references}

    @staticmethod
    def _region_children(regions: list[dict], parent_start: int | None, base: int) -> list[dict]:
        return [{"id": child["archiveId"], "sha256": child["sha256"], "label": child["name"],
                 "start": child["start"] - base, "end": child["end"] - base,
                 "reference": child["reference"]}
                for child in regions if child.get("parentStart") == parent_start]

    def _archive_regions(self, snapshot: dict, annotation: dict, text: str, scope: str,
                         now: float, *, source: bool = False) -> dict:
        """Archive the explicit region tree without expanding any input reference.

        A standalone, known reference in a nested region is a child edge. Unknown
        or ambiguous literals invalidate that region and its containing regions;
        other complete regions remain eligible. Bodies keep their input bytes.
        """
        from .annotations import compact_source
        regions = annotation["regions"]
        children: dict[int | None, list[dict]] = {}
        for region in regions:
            children.setdefault(region.get("parentStart"), []).append(region)
        accepted = set()
        for region in reversed(regions):
            start, end = region["start"], region["end"]
            payload = text[start:end]
            if "[[cf:" not in payload:
                accepted.add(start)
                continue
            literal = REFERENCE.fullmatch(payload.strip(" \t"))
            if literal:
                version, identifier = literal.groups()
                if version == "v1" and len(identifier) != 24:
                    continue
                try:
                    node = _entry(snapshot, identifier, content_hash=version == "v2")
                except FoldingError as exc:
                    if exc.code not in ("not_found", "ambiguous_hash"):
                        raise
                    continue
                if "text" not in node:
                    continue
                region.update(archiveId=node["id"], sha256=_content_hash(node), alreadyFolded=True)
                accepted.add(start)
                continue
            cursor = start
            valid = True
            for child in children.get(start, []):
                if child["start"] not in accepted or "[[cf:" in text[cursor:child["start"]]:
                    valid = False
                    break
                cursor = child["end"]
            if valid and "[[cf:" not in text[cursor:end]:
                accepted.add(start)
        regions = [region for region in regions if region["start"] in accepted]
        # A valid child of an incomplete/invalid parent is still independent.
        parents = []
        for region in regions:
            while parents and region["start"] >= parents[-1]["end"]:
                parents.pop()
            parent = parents[-1] if parents and region["end"] <= parents[-1]["end"] else None
            region["parentId"] = parent["id"] if parent else None
            region["parentStart"] = parent["start"] if parent else None
            parents.append(region)
        catalog = {"entries": [*snapshot["entries"], *({"text": text[r["start"]:r["end"]]}
                    for r in regions if not r.get("alreadyFolded"))]}
        for region in regions:
            region["reference"] = f"[[cf:v2:{_short_hash(catalog, region['sha256'])}]]"
        annotation = {**annotation, "regions": regions}
        if not source:
            projection = compact_source(text, annotation, allow_reference_literals=True)
            selected = {(item["id"], item["startLine"], item["endLine"])
                        for item in projection["foldedRegions"]}
            spans = [(region["start"], region["end"]) for region in regions
                     if (region["id"], region["startLine"], region["endLine"]) in selected]
            needed = []
            cursor = 0
            for region in regions:
                while cursor < len(spans) and region["start"] >= spans[cursor][1]:
                    cursor += 1
                if cursor < len(spans) and spans[cursor][0] <= region["start"] and region["end"] <= spans[cursor][1]:
                    needed.append(region)
            regions = needed
            annotation["regions"] = regions
        for region in regions:
            if not region.get("alreadyFolded"):
                archived = self._put(snapshot, {"scope": scope, "text": text[region["start"]:region["end"]]}, now)
                region["archiveId"] = archived["id"]
            node = _entry(snapshot, region["archiveId"])
            node.setdefault("label", region["name"])
            if not source:
                # Published child views may outlive a host's current roots list.
                node["folded"] = region["reference"]
        for region in regions:
            if not region.get("alreadyFolded"):
                node = _entry(snapshot, region["archiveId"])
                node["foldChildren"] = self._region_children(regions, region["start"], region["start"])
        return annotation

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
        if series is not None:
            entry["version"] = {"series": series, "number": previous["version"]["number"] + 1 if previous else 1, "kind": kind}
            if previous:
                entry["version"]["previousId"] = previous["id"]
        snapshot["entries"].append(entry)
        snapshot["roots"].append(node_id)
        return {"id": node_id, "reference": _ref(node_id), "version": entry.get("version")}

    def _render(self, snapshot: dict, request: dict, now: float) -> dict:
        """Project only explicit annotations; legacy marks/groups never choose text."""
        ids = _ids(request.get("ids"))
        protected = set(_ids(request.get("protected", [])))
        output = []
        before = after = 0
        for identifier in ids:
            node = _entry(snapshot, identifier)
            original = _text(node)
            if "children" in node or identifier in protected or node["role"] == "user":
                value = original
            else:
                fields = {**request, "action": "read-source", "id": identifier, "limit": 24000}
                fields.pop("ids", None)
                if "occurrence" in fields:
                    fields["occurrence"] = _hash([fields["occurrence"], identifier])
                view = self._source(snapshot, fields, now)
                if view["nextOffset"] is not None:
                    # Render has no paging contract; avoid publishing a truncated projection.
                    value = original
                else:
                    value = view["text"]
            output.append({"id": identifier, "text": value, "folded": value != original})
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
                    version, identifier = match.groups()
                    if version == "v1" and len(identifier) != 24:
                        _error("Malformed or unsupported reference")
                    node = _entry(snapshot, identifier, content_hash=version == "v2")
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

    def _source_read(self, snapshot: dict, request: dict, now: float) -> dict:
        node = _entry(snapshot, request.get("id"))
        text = _text(node)
        original = text
        source_view = {}
        if "peek" in request and type(request["peek"]) is not bool:
            _error("peek must be boolean")
        default_fold = self.config["folding"]["enabled"] and self.config["annotations"]["enabled"] and self.config["annotations"]["default_fold"]
        mode = request.get("mode", "folded" if request.get("_sourceProjection") and node.get("annotation") and default_fold else "original")
        ready = self.config["folding"]["delay_requests"] == 0
        occurrence, cycle = request.get("occurrence"), request.get("requestCycle")
        if (occurrence is None) != (cycle is None):
            _error("Source projection requires occurrence and requestCycle together")
        if occurrence is not None:
            _string(occurrence, "occurrence", 200)
            _integer(cycle, "requestCycle", 0, 9007199254740991)
            observations = snapshot.setdefault("sourceOccurrences", {})
            previous = observations.get(occurrence)
            if previous and cycle < previous["lastCycle"]:
                _error("requestCycle cannot move backwards")
            if previous is None or previous["id"] != node["id"]:
                previous = {"id": node["id"], "firstCycle": cycle, "lastCycle": cycle}
                observations[occurrence] = previous
            # A retry with the same cycle does not consume delay. The host owns
            # request-cycle progression; a new read must use a fresh occurrence.
            previous["lastCycle"] = cycle
            ready = cycle - previous["firstCycle"] >= self.config["folding"]["delay_requests"]
        if mode == "folded" and (not ready or not self.config["folding"]["enabled"] or not self.config["annotations"]["enabled"]):
            mode = "original"
        if mode not in ("folded", "original"):
            _error("Invalid read mode")
        if node.get("annotation") and node["annotation"].get("version") != 2:
            # Legacy AST-discovered regions remain recoverable, never newly folded.
            mode = "original"
        if node.get("annotation") and request["action"] == "read":
            from .annotations import ReferenceLiteralError, compact_source, select_regions
            expand_mode = request.get("expandMode", "recursive")
            if expand_mode not in ("single", "recursive"):
                _error("Invalid source expand mode")
            select_regions(node["annotation"]["regions"], request.get("expand", []))
            if mode == "folded":
                annotation = {**node["annotation"], "regions": [dict(r) for r in node["annotation"]["regions"]]}
                for region in annotation["regions"]:
                    if not region.get("manual") and any(fnmatchcase(region["name"], pattern) for pattern in self.config["annotations"]["keep"]):
                        region["disposition"] = "keep"
                try:
                    view = compact_source(text, annotation, request.get("expand", []),
                                          node["mark"]["disposition"] == "keep" or
                                          bool(node.get("manual") and node["mark"]["disposition"] == "unmarked"),
                                          expand_mode=expand_mode, allow_reference_literals=True)
                except ReferenceLiteralError as exc:
                    raise FoldingError("invalid_request", str(exc)) from None
                text = view.pop("text")
                source_view = view
                published = {(region["id"], region["startLine"], region["endLine"])
                             for region in view["foldedRegions"]}
                for region in annotation["regions"]:
                    if (region["id"], region["startLine"], region["endLine"]) in published:
                        _entry(snapshot, region["archiveId"])["folded"] = region["reference"]
            source_view.update(mode=mode, reference=_ref(node["id"]),
                               originalChars=len(original), originalSha256=hashlib.sha256(original.encode()).hexdigest(),
                               parser=node["annotation"]["parser"], limitations=node["annotation"]["limitations"],
                               foldedRegions=source_view.get("foldedRegions", []),
                               delayReason=None if ready else "host-request-cycle-required" if occurrence is None else "waiting-for-request-cycle")
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

    @staticmethod
    def _child_edges(node: dict) -> list[dict]:
        if "foldChildren" in node:
            return node["foldChildren"]
        # Old v2 source snapshots already name archived bodies. Only explicit
        # regions participate; old AST-based archives are not new fold choices.
        annotation = node.get("annotation", {})
        if annotation.get("version") == 2:
            return [{"id": region["archiveId"], "sha256": region["sha256"],
                     "label": region["name"], "start": region["start"], "end": region["end"]}
                    for region in annotation.get("regions", [])
                    if region.get("parentId") is None and "archiveId" in region]
        return []

    def _view(self, snapshot: dict, node: dict) -> str:
        """Render one archived layer; child data is never recursively loaded."""
        text = _text(node)
        if "text" not in node:
            return text
        chunks, cursor = [], 0
        for edge in sorted(self._child_edges(node), key=lambda edge: edge["start"]):
            start, end = edge["start"], edge["end"]
            if (type(start) is not int or type(end) is not int
                    or not cursor <= start < end <= len(text)):
                raise FoldingError("storage", "Invalid archived child range")
            child = _entry(snapshot, edge["id"])
            if "text" not in child or _content_hash(child) != edge["sha256"]:
                raise FoldingError("storage", "Invalid archived child identity")
            reference = f"[[cf:v2:{_short_hash(snapshot, edge['sha256'])}]]"
            chunks.extend((text[cursor:start], reference))
            cursor = end
        chunks.append(text[cursor:])
        return "".join(chunks)

    @staticmethod
    def _label(node: dict) -> str:
        return node.get("label", node.get("source", {}).get("path", ""))

    def _metadata(self, snapshot: dict, node: dict) -> dict:
        text = _text(node)
        sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
        children = ([edge["id"] for edge in self._child_edges(node)]
                    if "text" in node else list(node.get("children", [])))
        return {"id": node["id"], "sha256": sha256, "label": self._label(node),
                "reference": f"[[cf:v2:{_short_hash(snapshot, sha256)}]]" if "text" in node else _ref(node["id"]),
                "chars": len(text), "bytes": len(text.encode("utf-8")), "childCount": len(children)}

    def _query_graph(self, snapshot: dict, request: dict, depth: int | None) -> list[tuple[dict, str | None, int]]:
        nodes = {key: node for key, node in _nodes(snapshot).items() if node.get("trashedAt") is None}
        children = {key: ([edge["id"] for edge in self._child_edges(node)] if "text" in node
                          else list(node.get("children", []))) for key, node in nodes.items()}
        parents = {}
        for key, ids in children.items():
            for child in ids:
                if child not in nodes:
                    raise FoldingError("storage", "Archived child unavailable")
                parents.setdefault(child, key)
        sort, order = request.get("sort", "chronological"), request.get("order", "asc")
        if sort not in ("chronological", "size", "id", "version") or order not in ("asc", "desc"):
            _error("Invalid sort or order")

        def key(node_id):
            node = nodes[node_id]
            primary = {"chronological": node.get("createdAt", 0), "size": len(_text(node)), "id": node_id,
                       "version": (node.get("version", {}).get("series", ""), node.get("version", {}).get("number", 0))}[sort]
            return primary, node_id

        if "id" in request:
            roots = [_entry(snapshot, request["id"])["id"]]
            fallback = []
        else:
            roots = sorted((identifier for identifier in nodes if identifier not in parents), key=key, reverse=order == "desc")
            # Legacy/corrupt cyclic graphs must be discoverable without looping.
            reachable, pending = set(), list(roots)
            while pending:
                identifier = pending.pop()
                if identifier in reachable:
                    continue
                reachable.add(identifier)
                pending.extend(children[identifier])
            fallback = sorted(set(nodes) - reachable, key=key, reverse=order == "desc")
        seen, output = set(), []
        pending = [(identifier, parents.get(identifier), 0) for identifier in reversed(roots + fallback)]
        while pending:
            identifier, parent, level = pending.pop()
            if identifier in seen:
                continue
            seen.add(identifier)
            node = nodes[identifier]
            output.append((node, parent, level))
            if depth is None or level < depth:
                pending.extend((child, identifier, level + 1)
                               for child in reversed(children[identifier]))
        return output

    def _read(self, snapshot: dict, request: dict) -> dict:
        allowed = {"action", "scope", "id", "offset", "limit", "startLine", "endLine", "peek"}
        if set(request) - allowed:
            _error("read is a bounded view query; use offset/limit or startLine/endLine")
        if "peek" in request and type(request["peek"]) is not bool:
            _error("peek must be boolean")
        node = _entry(snapshot, request.get("id"))
        text = self._view(snapshot, node)
        from .annotations import _source_lines
        lines = _source_lines(text)
        starts = [0]
        for line in lines:
            starts.append(starts[-1] + len(line))
        limit = _integer(request.get("limit", 1200), "limit", 1, 24000)
        if "startLine" in request or "endLine" in request:
            if "offset" in request:
                _error("Line ranges cannot be combined with offset")
            first = _integer(request.get("startLine", 1), "startLine", 1, max(1, len(lines)))
            last = _integer(request.get("endLine", len(lines) or 1), "endLine", first, max(1, len(lines)))
            offset = starts[min(first - 1, len(lines))]
            stop = starts[min(last, len(lines))]
        else:
            offset = _integer(request.get("offset", 0), "offset", 0, len(text))
            stop = len(text)
        end = min(stop, offset + limit)
        import bisect
        first_line = min(len(lines) + 1, bisect.bisect_right(starts, offset)) if lines else 0
        last_line = bisect.bisect_right(starts, end - 1) if end > offset else first_line - 1
        metadata = self._metadata(snapshot, node)
        return {"id": node["id"], "label": metadata["label"], "text": text[offset:end],
                "offset": offset, "nextOffset": end if end < stop else None,
                "totalChars": len(text), "totalLines": len(lines),
                "startLine": first_line, "endLine": max(0, last_line),
                "sha256": metadata["sha256"], "viewSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "childCount": metadata["childCount"]}

    def _meta(self, snapshot: dict, request: dict) -> dict:
        if set(request) - {"action", "scope", "id", "offset", "limit"}:
            _error("meta accepts id, offset and limit")
        node = _entry(snapshot, request.get("id"))
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 10), "limit", 1, 100)
        children = ([edge["id"] for edge in self._child_edges(node)] if "text" in node else list(node.get("children", [])))
        page = children[offset:offset + limit]
        return {**self._metadata(snapshot, node), "children": page,
                "nextOffset": offset + len(page) if offset + len(page) < len(children) else None}

    def _browse(self, snapshot: dict, request: dict) -> dict:
        allowed = {"action", "scope", "id", "depth", "recursive", "offset", "limit", "sort", "order", "query"}
        if set(request) - allowed:
            _error("Invalid list field")
        recursive = request.get("recursive", False)
        if type(recursive) is not bool:
            _error("recursive must be boolean")
        depth = (_integer(request["depth"], "depth", 0, 64) if "depth" in request
                 else None if recursive else 1)
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 10), "limit", 1, 100)
        rows = self._query_graph(snapshot, request, depth)
        query = request.get("query")
        if query is not None:
            _string(query, "query", 200)
            rows = [(node, parent, level) for node, parent, level in rows
                    if query.casefold() in (node["id"] + self._label(node) + self._view(snapshot, node)).casefold()]
        page = rows[offset:offset + limit]
        return {"entries": [{**self._metadata(snapshot, node), "parentId": parent, "depth": level}
                            for node, parent, level in page],
                "total": len(rows), "nextOffset": offset + len(page) if offset + len(page) < len(rows) else None}

    def _grep(self, snapshot: dict, request: dict) -> dict:
        allowed = {"action", "scope", "query", "id", "recursive", "context", "offset", "limit"}
        if set(request) - allowed:
            _error("Invalid grep field")
        query = _string(request.get("query"), "query", 2000)
        if "\r" in query or "\n" in query:
            _error("grep query must fit on one physical line")
        recursive = request.get("recursive", True)
        if type(recursive) is not bool:
            _error("recursive must be boolean")
        context = _integer(request.get("context", 0), "context", 0, 3)
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 10), "limit", 1, 100)
        from .annotations import _source_lines
        matches = []
        count = 0
        for node, _, _ in self._query_graph(snapshot, request, None if recursive else 0):
            lines = [line.rstrip("\r\n") for line in _source_lines(self._view(snapshot, node))]
            for index, line in enumerate(lines):
                position = line.find(query)
                if position < 0:
                    continue
                if count < offset:
                    count += 1
                    continue
                if len(matches) == limit:
                    return {"matches": matches, "nextOffset": offset + len(matches)}
                start = max(0, min(position - 40, len(line) - 160))
                hit = {"id": node["id"], "label": self._label(node), "line": index + 1,
                       "text": line[start:start + 160], "textOffset": start}
                if context:
                    hit["context"] = [{"line": other + 1, "text": lines[other][:160], "textOffset": 0}
                                      for other in range(max(0, index - context), min(len(lines), index + context + 1))
                                      if other != index]
                matches.append(hit)
                count += 1
        return {"matches": matches, "nextOffset": None}
