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

REFERENCE = re.compile(r"\[\[cf:(v1|v2|v3):([a-f0-9]{12,64})\]\]")
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
    return f"[[cf:{'v3' if len(node_id) == 64 else 'v1'}:{node_id}]]"


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


def _entry(snapshot: dict, node_id: Any, trash: bool = False, *, content_hash: bool = False,
           exact: bool = False, occurrence: bool = False) -> dict:
    _string(node_id, "id", 100)
    node = None if content_hash else _nodes(snapshot).get(node_id)
    if node is None and not exact and re.fullmatch(r"[a-f0-9]{12,64}", node_id):
        matches = [n for n in snapshot["entries"] if _content_hash(n).startswith(node_id)
                   and (trash or n.get("trashedAt") is None)]
        if len({n["text"] for n in matches}) > 1:
            raise FoldingError("ambiguous_hash", "Ambiguous content hash; supply a longer prefix")
        if occurrence and len(matches) > 1:
            raise FoldingError("ambiguous_occurrence", "Content occurs more than once; use a node ID from list/search")
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
    node = _entry(snapshot, node_id, occurrence=True)
    node_id = node["id"]
    node.pop("folded", None)
    node["manual"] = True
    if "children" in node:
        node["enabled"] = False
    else:
        node["mark"] = {"disposition": "unmarked"}
    nodes = _nodes(snapshot)
    parents = {child: group for group in snapshot["groups"] for child in group["children"]}
    parents.update({entry["id"]: nodes[entry["parentId"]]
                    for entry in snapshot["entries"] if entry.get("parentId") in nodes})
    seen = set()
    while node_id in parents:
        if node_id in seen:
            raise FoldingError("storage", "Cyclic archived parent relation")
        seen.add(node_id)
        parent = parents[node_id]
        if "children" in parent:
            parent["enabled"] = False
        elif "annotation" not in parent:
            parent["manual"] = True
            parent["mark"] = {"disposition": "keep"}
        parent.pop("folded", None)
        node_id = parent["id"]

    # Source projections store their fold decisions on the owning annotation.
    restored = seen | {node["id"]}
    for owner in snapshot["entries"]:
        for region in owner.get("annotation", {}).get("regions", []):
            if region.get("archiveId") in restored:
                region.update(disposition="keep", manual=True)


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
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.execute("CREATE TABLE IF NOT EXISTS scopes (scope TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, text TEXT NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS blob_refs (scope TEXT NOT NULL REFERENCES scopes(scope) ON DELETE CASCADE, hash TEXT NOT NULL REFERENCES blobs(hash), PRIMARY KEY(scope,hash))")
        self._db.execute("CREATE INDEX IF NOT EXISTS blob_refs_hash ON blob_refs(hash)")
        self._db.commit()

    def _decode(self, stored: dict) -> dict:
        """Legacy inline payloads stay readable; only successful writes migrate."""
        cache = {}
        for entry in stored["entries"]:
            if "text" in entry:
                continue
            digest = entry.get("textHash")
            if not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None:
                raise FoldingError("storage", "Invalid archived payload hash")
            if digest not in cache:
                row = self._db.execute("SELECT text FROM blobs WHERE hash=?", (digest,)).fetchone()
                if row is None or hashlib.sha256(row[0].encode("utf-8")).hexdigest() != digest:
                    raise FoldingError("storage", "Archive payload missing or hash mismatch")
                cache[digest] = row[0]
            entry["text"] = cache[digest]
        return stored

    @staticmethod
    def _encode(snapshot: dict) -> tuple[str, dict[str, str]]:
        blobs = {}
        entries = []
        for entry in snapshot["entries"]:
            text = entry["text"]
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if digest in blobs and blobs[digest] != text:
                raise FoldingError("hash_collision", "Different originals have the same content hash")
            blobs[digest] = text
            entries.append({**{key: value for key, value in entry.items() if key != "text"}, "textHash": digest})
        encoded = json.dumps({**snapshot, "storageVersion": 2, "entries": entries}, ensure_ascii=False, separators=(",", ":"))
        return encoded, blobs

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
                query = request["action"] in ("read", "list", "search", "grep", "meta", "status")
                self._db.execute("BEGIN" if query else "BEGIN IMMEDIATE")
                row = self._db.execute("SELECT data FROM scopes WHERE scope=?", (scope,)).fetchone()
                snapshot = self._decode(json.loads(row[0])) if row else {"entries": [], "groups": [], "roots": [], "config": {}}
                now = time.time()
                # TOML supplies a per-client default; only gc configure persists policy.
                gc_default = "gc" not in snapshot["config"] and self.config["gc"]["enabled"]
                if gc_default:
                    fields = {"strength": "strength", "idle_seconds": "idleSeconds", "max_uses": "maxUses",
                              "retention_seconds": "retentionSeconds", "auto_purge": "autoPurge"}
                    snapshot["config"]["gc"] = {dest: self.config["gc"][src] for src, dest in fields.items()}
                result = self._dispatch(snapshot, request, now)
                if query:
                    # Inspection never runs GC, renews retention, or restores folds.
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
                encoded, blobs = self._encode(snapshot)
                # Lowering the next-write quota must not make existing originals
                # unreadable. Recovery cannot add archived payloads.
                recovery = request["action"] in ("read", "paste", "resolve", "restore")
                ceiling = MAX_STATE if recovery else min(MAX_STATE, self.config["folding"]["max_session_bytes"])
                payload_bytes = len(encoded.encode()) + sum(len(text.encode()) for text in blobs.values())
                if payload_bytes > ceiling:
                    raise FoldingError("quota", "Scope quota exceeded")
                for digest, text in blobs.items():
                    existing = self._db.execute("SELECT text FROM blobs WHERE hash=?", (digest,)).fetchone()
                    if existing is not None and existing[0] != text:
                        raise FoldingError("hash_collision", "Archive content hash collision")
                    self._db.execute("INSERT OR IGNORE INTO blobs VALUES (?,?)", (digest, text))
                self._db.execute("INSERT INTO scopes VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data", (scope, encoded))
                self._db.execute("DELETE FROM blob_refs WHERE scope=?", (scope,))
                self._db.executemany("INSERT INTO blob_refs VALUES (?,?)", ((scope, digest) for digest in blobs))
                self._db.execute("DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.hash=blobs.hash)")
                total = self._db.execute("SELECT (SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM scopes) + (SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM blobs)").fetchone()[0]
                if total > MAX_STATE * 4:
                    raise FoldingError("quota", "Archive quota exceeded")
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

    def search(self, scope: str, query: str, **options):
        return self.call({**options, "action": "search", "scope": scope, "query": query})

    def grep(self, scope: str, query: str, **options):
        return self.search(scope, query, **options)

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
            node = _entry(snapshot, request["id"], occurrence=True)
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
            if "occurrence" in request:
                options["occurrence"] = _string(request["occurrence"], "occurrence", 200)
            if "sourceId" in request:
                options["sourceId"] = _string(request["sourceId"], "sourceId", 200)
            if path:
                options["source"] = {"path": str(Path(path).absolute()), "range": "full"}
            node = _entry(snapshot, self._put(snapshot, options, now)["id"])
        if (not self.config["folding"]["enabled"] or not self.config["annotations"]["enabled"]) and request["action"] == "read-source":
            return self._read(snapshot, {**request, "action": "read", "id": node["id"], "mode": request.get("mode", "original")}, now)
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
        if annotation is None or annotation.get("version") != 3 or (language is not None and annotation["language"] != language) or styles != annotation.get("commentStyles", []):
            annotation = discover_source(text, language or (annotation["language"] if annotation else None), path, styles)
            annotation["version"] = 3
            self._prepare_regions(annotation, text, request["scope"],
                                  request.get("sourceId", path or request.get("occurrence", "input")),
                                  owner=node["id"])
            # Payloads and the exact original commit together in Client.call.
            for region in annotation["regions"]:
                disposition = manual.get((region["name"], region["start"], region["end"]))
                if disposition is not None:
                    region.update(disposition=disposition, manual=True)
            self._save_regions(snapshot, annotation["regions"], text, now, owner=node["id"])
            node["annotation"] = annotation
        for region in annotation["regions"]:
            region["reference"] = _ref(region["archiveId"])
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
            return self._read(snapshot, {**request, "action": "read", "id": node["id"], "_sourceProjection": True}, now)
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
        if action in ("search", "grep"):
            return self._search(snapshot, request)
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
        if action in ("read", "paste"):
            return self._read(snapshot, request, now)
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
        if set(request) - {"action", "scope", "text", "language", "commentStyles", "sourceId"}:
            _error("fold accepts only scope, text, language, commentStyles and sourceId")
        text = request.get("text")
        if text != "":
            _string(text, "text", MAX_TEXT)
        language = request.get("language")
        if language is not None:
            _string(language, "language", 100)
        annotation = discover_source(text, language, styles=request.get("commentStyles"))
        source_id = _string(request["sourceId"], "sourceId", 200) if "sourceId" in request else "input"
        self._prepare_regions(annotation, text, request["scope"], source_id)
        view = compact_source(text, annotation, allow_reference_literals=True)
        selected = {item["id"] for item in view["foldedRegions"]}
        spans = [(region["start"], region["end"]) for region in annotation["regions"] if region["id"] in selected]
        needed = [region for region in annotation["regions"]
                  if any(start <= region["start"] and region["end"] <= end for start, end in spans)]
        # Store selected nodes and their actual contained regions, even when a
        # short child would not save bytes on its own.
        needed_ids = {region["id"] for region in needed}
        for region in needed:
            if region["parentId"] not in needed_ids:
                region["parentId"] = None
        self._save_regions(snapshot, needed, text, now, published=selected)
        by_location = {r["id"]: r for r in needed}
        references = []
        for item in view["foldedRegions"]:
            region = by_location[item["id"]]
            references.append({"id": region["id"], "nodeId": region["id"], "label": region["name"],
                               "sha256": region["sha256"], "contentHash": region["sha256"],
                               "reference": region["reference"], "archiveId": region["id"]})
        return {"scope": request["scope"], "text": view["text"], "references": references}

    @staticmethod
    def _prepare_regions(annotation: dict, text: str, scope: str, source_id: str, *, owner: str | None = None) -> None:
        source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        regions = annotation["regions"]
        parents = []
        for region in regions:
            while parents and region["start"] >= parents[-1]["end"]:
                parents.pop()
            if parents and region["end"] > parents[-1]["end"]:
                _error("Fold ranges must be disjoint or fully nested")
            parent_id = parents[-1]["id"] if parents else owner
            # A parser/style change may reveal a new containing region at the
            # same source offsets. Keep the old occurrence graph recoverable.
            identifier = _hash(["fold-node-v3", scope, source_id, owner, source_hash,
                                region["start"], region["end"], parent_id])
            region.update(id=identifier, archiveId=identifier, reference=_ref(identifier),
                          parentId=parent_id,
                          sourceRange={"sourceId": source_id, "sourceHash": source_hash,
                                       "start": region["start"], "end": region["end"],
                                       "offsetUnit": "unicode-code-points"})
            parents.append(region)

    @staticmethod
    def _save_regions(snapshot: dict, regions: list[dict], text: str, now: float, *, owner: str | None = None,
                      published: set[str] | None = None) -> None:
        nodes = _nodes(snapshot)
        for region in regions:
            identifier = region["id"]
            payload = text[region["start"]:region["end"]]
            node = nodes.get(identifier)
            if node is None:
                node = {"id": identifier, "text": payload, "role": nodes[owner]["role"] if owner else "tool",
                        "createdAt": now, "lastUsedAt": now, "reads": 0, "folds": 0,
                        "mark": {"disposition": "unmarked"}, "label": region["name"],
                        "parentId": region["parentId"], "sourceRange": region["sourceRange"]}
                snapshot["entries"].append(node)
                nodes[identifier] = node
            elif node["text"] != payload or node.get("sourceRange") != region["sourceRange"] or node.get("parentId") != region["parentId"]:
                raise FoldingError("hash_collision", "Archive occurrence ID collision")
            node.pop("trashedAt", None)
            if published and identifier in published:
                node["folded"] = region["reference"]
            if region["parentId"] is None and identifier not in snapshot["roots"]:
                snapshot["roots"].append(identifier)

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
        occurrence = request.get("occurrence")
        source_id = request.get("sourceId")
        for name, value in (("occurrence", occurrence), ("sourceId", source_id)):
            if value is not None:
                _string(value, name, 200)
        identity = [occurrence, source_id] if occurrence is not None or source_id is not None else None
        series = (_hash([source["path"], source["range"]] + ([identity] if identity is not None else []))[:24]
                  if source else None)
        previous = max((n for n in snapshot["entries"] if series is not None and
                        n.get("version", {}).get("series") == series),
                       key=lambda n: n["version"]["number"], default=None)
        node_id = (_hash([request["scope"], role, source, text, identity]) if identity is not None
                   else _hash([request["scope"], role, source, text])[:24])
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
                    if (version == "v1" and len(identifier) != 24) or (version == "v3" and len(identifier) != 64):
                        _error("Malformed or unsupported reference")
                    node = _entry(snapshot, identifier, content_hash=version == "v2", exact=version == "v3")
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
        if node.get("annotation") and node["annotation"].get("version") not in (2, 3):
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
                                          expand_mode=expand_mode)
                except ReferenceLiteralError as exc:
                    raise FoldingError("invalid_request", str(exc)) from None
                text = view.pop("text")
                source_view = view
                if request.get("_sourceProjection"):
                    for region in view["foldedRegions"]:
                        _entry(snapshot, region["id"])["folded"] = region["reference"]
            source_view.update(mode=mode, reference=_ref(node["id"]),
                               originalChars=len(original), originalSha256=hashlib.sha256(original.encode()).hexdigest(),
                               parser=node["annotation"]["parser"], limitations=node["annotation"]["limitations"],
                               foldedRegions=source_view.get("foldedRegions", []),
                               delayReason=None if ready else "host-request-cycle-required" if occurrence is None else "waiting-for-request-cycle")
        offset = _integer(request.get("offset", 0), "offset", 0, len(text))
        limit = _integer(request.get("limit", len(text) or 1) if request["action"] == "paste" else request.get("limit", 4000), "limit", 1, MAX_TEXT if request["action"] == "paste" else 24000)
        end = min(len(text), offset + limit)
        part = text[offset:end]
        if request["action"] != "read" or request.get("_sourceProjection"):
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
        metadata = self._metadata(snapshot, node)
        identifier = request.get("id", "")
        if identifier != node["id"] and re.fullmatch(r"[a-f0-9]{12,64}", identifier):
            matching = [item["id"] for item in snapshot["entries"] if item.get("trashedAt") is None
                        and _content_hash(item).startswith(identifier)]
            if len(matching) > 1:
                # Legacy hashes identify bytes, not one occurrence's location.
                metadata.update(ambiguousOccurrence=True, matchingNodeIds=matching[:20],
                                matchingNodeCount=len(matching), matchingNodeIdsTruncated=len(matching) > 20,
                                parentId=None, sourceRange=None)
        return {**metadata, **result, **source_view, "text": part,
                "offsetUnit": "unicode-code-points", "version": node.get("version"), "latestVersion": node["id"] in _latest(snapshot)}

    @staticmethod
    def _relations(snapshot: dict) -> tuple[dict, dict, dict]:
        nodes = {key: value for key, value in _nodes(snapshot).items() if value.get("trashedAt") is None}
        parents = {child: group["id"] for group in snapshot["groups"]
                   if group.get("trashedAt") is None for child in group["children"] if child in nodes}
        for identifier, node in nodes.items():
            parent = node.get("parentId")
            if parent is not None:
                if parent not in nodes or parent == identifier:
                    raise FoldingError("storage", "Invalid archived parent relation")
                if identifier in parents and parents[identifier] != parent:
                    raise FoldingError("storage", "Multiple archived parents")
                parents[identifier] = parent
        children = {identifier: [] for identifier in nodes}
        for child, parent in parents.items():
            children[parent].append(child)
        # Validate once and then traverse iteratively, including very deep input.
        checked = set()
        for identifier in nodes:
            pending, current = set(), identifier
            while current in parents and current not in checked:
                if current in pending:
                    raise FoldingError("storage", "Cyclic archived parent relation")
                pending.add(current)
                current = parents[current]
            checked.update(pending)
        for identifiers in children.values():
            identifiers.sort(key=lambda identifier: (nodes[identifier].get("sourceRange", {}).get("start", 0),
                                                      nodes[identifier].get("createdAt", 0), identifier))
        return nodes, parents, children

    def _metadata(self, snapshot: dict, node: dict, relations=None) -> dict:
        nodes, parents, children = relations or self._relations(snapshot)
        text = _text(node)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return {"id": node["id"], "nodeId": node["id"], "sha256": digest, "contentHash": digest,
                "reference": _ref(node["id"]), "label": node.get("label", node.get("source", {}).get("path", "")),
                "parentId": parents.get(node["id"]), "sourceRange": node.get("sourceRange"),
                "chars": len(text), "bytes": len(text.encode("utf-8")),
                "childCount": len(children.get(node["id"], [])), "role": node.get("role", "group"),
                "folded": "folded" in node, "offsetUnit": "unicode-code-points"}

    def _query_nodes(self, snapshot: dict, request: dict, *, search=False) -> tuple[list, tuple]:
        relations = self._relations(snapshot)
        nodes, parents, children = relations
        if "id" in request and "parentId" in request:
            _error("Supply id or parentId, not both")
        recursive = request.get("recursive", search)
        if type(recursive) is not bool:
            _error("recursive must be boolean")
        depth = (_integer(request["depth"], "depth", 0, 10000) if "depth" in request
                 else None if recursive else 0)
        sort, order = request.get("sort", "chronological"), request.get("order", "asc")
        if sort not in ("chronological", "size", "id", "version") or order not in ("asc", "desc"):
            _error("Invalid sort or order")
        def key(identifier):
            node = nodes[identifier]
            primary = {"chronological": (node.get("createdAt", 0), node.get("sourceRange", {}).get("start", 0)),
                       "size": len(_text(node)), "id": identifier,
                       "version": (node.get("version", {}).get("series", ""), node.get("version", {}).get("number", 0))}[sort]
            return primary, identifier
        if "id" in request:
            roots = [_entry(snapshot, request["id"], occurrence=True)["id"]]
        elif "parentId" in request:
            parent = _entry(snapshot, request["parentId"], occurrence=True)["id"]
            roots = list(children[parent])
        else:
            roots = [identifier for identifier in nodes if identifier not in parents]
        roots.sort(key=key, reverse=order == "desc")
        pending = [(identifier, 0) for identifier in reversed(roots)]
        output = []
        while pending:
            identifier, level = pending.pop()
            output.append((nodes[identifier], level))
            if depth is None or level < depth:
                # Source positions, rather than payload hashes, order siblings.
                child_ids = children[identifier]
                if sort != "chronological" or order != "asc":
                    child_ids = sorted(child_ids, key=key, reverse=order == "desc")
                pending.extend((child, level + 1) for child in reversed(child_ids))
        return output, relations

    def _browse(self, snapshot: dict, request: dict) -> dict:
        if set(request) - {"action", "scope", "id", "parentId", "recursive", "depth", "offset", "limit", "sort", "order", "query"}:
            _error("Invalid list field")
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 20), "limit", 1, 100)
        output, relations = self._query_nodes(snapshot, request)
        query = request.get("query")
        if query is not None:
            _string(query, "query", 2000)
            output = [(node, level) for node, level in output
                      if query.casefold() in (node["id"] + _text(node) + node.get("label", "")).casefold()]
        page = output[offset:offset + limit]
        return {"entries": [{**self._metadata(snapshot, node, relations), "depth": level}
                            for node, level in page], "total": len(output),
                "nextOffset": offset + len(page) if offset + len(page) < len(output) else None,
                "offsetUnit": "unicode-code-points"}

    def _meta(self, snapshot: dict, request: dict) -> dict:
        if set(request) - {"action", "scope", "id", "offset", "limit"}:
            _error("meta accepts id, offset and limit")
        node = _entry(snapshot, request.get("id"), occurrence=True)
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 20), "limit", 1, 100)
        relations = self._relations(snapshot)
        children = relations[2][node["id"]]
        page = children[offset:offset + limit]
        return {**self._metadata(snapshot, node, relations), "children": page,
                "nextOffset": offset + len(page) if offset + len(page) < len(children) else None}

    def _search(self, snapshot: dict, request: dict) -> dict:
        if set(request) - {"action", "scope", "query", "id", "parentId", "recursive", "caseSensitive", "offset", "limit"}:
            _error("Invalid search field")
        query = _string(request.get("query"), "query", 2000)
        sensitive = request.get("caseSensitive", True)
        if type(sensitive) is not bool:
            _error("caseSensitive must be boolean")
        offset = _integer(request.get("offset", 0), "offset", 0, 10000000)
        limit = _integer(request.get("limit", 20), "limit", 1, 100)
        output, relations = self._query_nodes(snapshot, request, search=True)
        pattern = re.compile(re.escape(query), 0 if sensitive else re.IGNORECASE)
        matches, skipped = [], 0
        for node, _ in output:
            text = _text(node)
            for match in pattern.finditer(text):
                if skipped < offset:
                    skipped += 1
                    continue
                if len(matches) == limit:
                    return {"matches": matches, "nextOffset": offset + len(matches), "offsetUnit": "unicode-code-points"}
                position = match.start()
                start = max(0, position - 60)
                metadata = self._metadata(snapshot, node, relations)
                matches.append({**metadata, "offset": position, "length": match.end() - position,
                                "line": len(re.findall(r"\r\n|\r|\n", text[:position])) + 1,
                                "text": text[start:min(len(text), start + 240)], "textOffset": start})
        return {"matches": matches, "nextOffset": None, "offsetUnit": "unicode-code-points"}
