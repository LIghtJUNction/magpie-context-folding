"""Recoverable archive collection and explicitly authored skill exports.

The caller owns transaction/persistence. Every operation validates before mutating
its snapshot; raw archive contents are never used as executable skill text.
"""

import hashlib
import json
import math
import os
import re
import time


_LIMIT = 100_000
_MAX_SECONDS = 315_576_000
_PRESETS = {
    "off": (30 * 86400, 2, 30 * 86400),
    "conservative": (30 * 86400, 2, 30 * 86400),
    "balanced": (7 * 86400, 5, 7 * 86400),
    "aggressive": (86400, 10, 86400),
}
_CONFIG_KEYS = {"strength", "idleSeconds", "maxUses", "retentionSeconds", "autoPurge"}


def _fail(message="Invalid lifecycle request"):
    raise ValueError(message) from None


def _number(value, maximum=1e12):
    return (
        type(value) in (int, float)
        and 0 <= value <= maximum
        and math.isfinite(value)
    )


def _id(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and "\x00" not in value


def _ids(value):
    if not isinstance(value, list) or len(value) > _LIMIT or not all(map(_id, value)):
        _fail()
    return set(value)


def _config(stored, updates=None):
    if not isinstance(stored, dict) or (updates is not None and not isinstance(updates, dict)):
        _fail("Invalid lifecycle configuration")
    updates = {} if updates is None else updates
    if set(stored) - _CONFIG_KEYS or set(updates) - _CONFIG_KEYS:
        _fail("Invalid lifecycle configuration")
    strength = updates.get("strength", stored.get("strength", "conservative"))
    if not isinstance(strength, str) or strength not in _PRESETS:
        _fail("Invalid lifecycle configuration")
    idle, uses, retention = _PRESETS[strength]
    result = dict(strength=strength, idleSeconds=idle, maxUses=uses,
                  retentionSeconds=retention, autoPurge=False)
    # Changing strength selects the preset; overrides supplied in the same call win.
    if "strength" not in updates or strength == stored.get("strength"):
        result.update(stored)
    else:
        result["autoPurge"] = stored.get("autoPurge", False)
    result.update(updates)
    if (not _number(result["idleSeconds"], _MAX_SECONDS)
            or not _number(result["retentionSeconds"], _MAX_SECONDS)
            or type(result["maxUses"]) is not int
            or not 0 <= result["maxUses"] <= 1_000_000_000
            or type(result["autoPurge"]) is not bool):
        _fail("Invalid lifecycle configuration")
    return result


def _graph(snapshot):
    if not isinstance(snapshot, dict):
        _fail("Invalid lifecycle snapshot")
    entries, groups = snapshot.get("entries", []), snapshot.get("groups", [])
    if (not isinstance(entries, list) or not isinstance(groups, list)
            or len(entries) + len(groups) > _LIMIT):
        _fail("Invalid lifecycle snapshot")
    records, edges, live = {}, {}, set()
    edge_count = 0
    for collection, is_group in ((entries, False), (groups, True)):
        for item in collection:
            if not isinstance(item, dict) or not _id(item.get("id")):
                _fail("Invalid lifecycle snapshot")
            key = item["id"]
            if key in records:
                _fail("Invalid lifecycle snapshot")
            for field in ("createdAt", "lastUsedAt", "trashedAt"):
                if field in item and not _number(item[field]):
                    _fail("Invalid lifecycle snapshot")
            for field in ("reads", "folds"):
                if field in item and (type(item[field]) is not int or not 0 <= item[field] <= 1_000_000_000):
                    _fail("Invalid lifecycle snapshot")
            mark = item.get("mark", {})
            if not isinstance(mark, dict):
                _fail("Invalid lifecycle snapshot")
            refs = _ids(item.get("children", [])) if is_group else set()
            if not is_group and "annotation" in item:
                refs.update(_ids(list({region["archiveId"] for region in item["annotation"]["regions"]})))
            if not is_group and "foldChildren" in item:
                refs.update(_ids(list({child["id"] for child in item["foldChildren"]})))
            version = item.get("version", {})
            if not isinstance(version, dict):
                _fail("Invalid lifecycle snapshot")
            if "previousId" in version:
                if not _id(version["previousId"]):
                    _fail("Invalid lifecycle snapshot")
                refs.add(version["previousId"])
            edge_count += len(refs)
            if edge_count > _LIMIT * 10:
                _fail("Invalid lifecycle snapshot")
            records[key], edges[key] = item, refs
            if (item.get("pinned") is True or mark.get("disposition") == "keep"
                    or bool(item.get("folded"))):
                live.add(key)
    roots = _ids(snapshot.get("roots", []))
    if not roots <= records.keys() or any(not refs <= records.keys() for refs in edges.values()):
        _fail("Invalid lifecycle snapshot")
    live.update(roots)
    return records, edges, live


def _walk(roots, edges):
    seen, pending = set(), list(roots)
    while pending:
        key = pending.pop()
        if key not in seen:
            seen.add(key)
            pending.extend(edges[key] - seen)
    return seen


def _restore(records, ids):
    restored = []
    for key in sorted(ids):
        if "trashedAt" in records[key]:
            del records[key]["trashedAt"]
            restored.append(key)
    return restored


def _purgeable(candidates, records, edges):
    # Retained trash must remain recoverable too. A cycle can be removed together,
    # but an item referenced by any retained record cannot be removed by itself.
    return candidates - _walk(set(records) - candidates, edges)


def _remove(snapshot, ids):
    snapshot["entries"] = [item for item in snapshot.get("entries", []) if item["id"] not in ids]
    snapshot["groups"] = [item for item in snapshot.get("groups", []) if item["id"] not in ids]


def _status(records, live, config):
    return {
        "config": config,
        "active": sum("trashedAt" not in item for item in records.values()),
        "trash": sorted(key for key, item in records.items() if "trashedAt" in item),
        "protected": sorted(live),
    }


def _export(item, request, now):
    name, description, body, path = (request.get(field) for field in ("name", "description", "body", "path"))
    if (not isinstance(name, str) or len(name) > 64
            or re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) is None
            or not isinstance(description, str) or not description.strip()
            or len(description) > 1024 or "\x00" in description
            or not isinstance(body, str) or not body.strip()
            or len(body) > 1_000_000 or "\x00" in body
            or not isinstance(path, str) or not path.startswith("/")
            or len(path) > 4096 or "\x00" in path
            or path == "/" or os.path.normpath(path) != path):
        _fail("Invalid skill export request")
    is_group = "children" in item
    try:
        text = (json.dumps({key: item.get(key) for key in ("id", "children", "summary")},
                           ensure_ascii=True, sort_keys=True, separators=(",", ":"))
                if is_group else item.get("text"))
        if not isinstance(text, str):
            _fail("Invalid lifecycle snapshot")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    except (UnicodeError, TypeError, RecursionError):
        _fail("Invalid lifecycle snapshot")
    manifest = {
        "id": item["id"], "kind": "group" if is_group else "entry", "sha256": digest,
        "createdAt": item.get("createdAt"), "lastUsedAt": item.get("lastUsedAt"),
        "reads": item.get("reads", 0), "folds": item.get("folds", 0),
        "source": item.get("source"), "version": item.get("version"),
        "exportedAt": now,
    }
    if is_group:
        manifest["children"] = item["children"].copy()
    try:
        encoded_manifest = json.dumps(manifest, ensure_ascii=True, allow_nan=False)
        content = ("---\nname: " + json.dumps(name) + "\ndescription: "
                   + json.dumps(description, ensure_ascii=True)
                   + "\nsource_manifest: " + encoded_manifest + "\n---\n\n" + body + "\n").encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail("Invalid skill export request")
    if len(content) > 2_000_000:
        _fail("Invalid skill export request")
    parent_fd = directory_fd = None
    created = wrote = False
    leaf = os.path.basename(path)
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent_fd = os.open("/", flags)
        # Open each component without following symlinks. The final directory must
        # be new, including when an existing empty directory was supplied.
        for part in os.path.dirname(path).split("/"):
            if part:
                next_fd = os.open(part, flags, dir_fd=parent_fd)
                os.close(parent_fd)
                parent_fd = next_fd
        os.mkdir(leaf, mode=0o700, dir_fd=parent_fd)
        created = True
        directory_fd = os.open(leaf, flags, dir_fd=parent_fd)
        fd = os.open("SKILL.md", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory_fd)
        wrote = True
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except (OSError, ValueError):
        if wrote and directory_fd is not None:
            try:
                os.unlink("SKILL.md", dir_fd=directory_fd)
            except OSError:
                pass
        if created and parent_fd is not None:
            try:
                os.rmdir(leaf, dir_fd=parent_fd)
            except OSError:
                pass
        _fail("Skill export failed")
    finally:
        for opened_fd in (directory_fd, parent_fd):
            if opened_fd is not None:
                try:
                    os.close(opened_fd)
                except OSError:
                    pass
    return {"id": item["id"], "path": path + "/SKILL.md", "name": name,
            "sourceManifest": manifest}


def maintain_lifecycle(snapshot, now=None, *, collect=True):
    """Repair live dependency closures after core operations, then optionally GC.

    Call before persisting in the same write transaction. Pass collect=False for
    explicit GC/skill/restore requests so restoring trash is not immediately undone.
    Automatic collection requires GC configuration supplied by the caller.
    """
    now = time.time() if now is None else now
    if not _number(now):
        _fail()
    records, edges, roots = _graph(snapshot)
    container = snapshot.get("config", {})
    if not isinstance(container, dict):
        _fail("Invalid lifecycle configuration")
    config = _config(container.get("gc", {}))
    restored = _restore(records, _walk(roots, edges))
    result = {"restored": restored, "trashed": [], "purged": []}
    if collect and "gc" in container and config["strength"] != "off":
        collected = dispatch_lifecycle(snapshot, {"action": "gc", "mode": "collect"}, now)
        collected["restored"] = sorted(set(collected["restored"]) | set(restored))
        return collected
    return result


def dispatch_lifecycle(snapshot, request, now=None):
    """Apply a validated lifecycle request, mutating the caller's snapshot."""
    if not isinstance(request, dict):
        _fail()
    now = time.time() if now is None else now
    if not _number(now):
        _fail()
    records, edges, roots = _graph(snapshot)
    live = _walk(roots, edges)
    container = snapshot.get("config", {})
    if not isinstance(container, dict):
        _fail("Invalid lifecycle configuration")
    config = _config(container.get("gc", {}))
    action = request.get("action")
    if action == "roots":
        ids = _ids(request.get("ids"))
        if not ids <= records.keys():
            _fail("Unknown lifecycle item")
        restored = _restore(records, _walk(ids, edges))
        snapshot["roots"] = sorted(ids)
        return {"roots": sorted(ids), "restored": restored}
    if action == "pin":
        key, pinned = request.get("id"), request.get("pinned")
        if not _id(key) or type(pinned) is not bool:
            _fail()
        if key not in records:
            _fail("Unknown lifecycle item")
        restored = _restore(records, _walk({key}, edges)) if pinned else []
        records[key]["pinned"] = pinned
        return {"id": key, "pinned": pinned, "restored": restored}
    if action == "skills":
        if request.get("mode") == "candidates":
            candidates = [
                {"id": key, "reads": item.get("reads", 0), "folds": item.get("folds", 0),
                 "lastUsedAt": item.get("lastUsedAt", item.get("createdAt", 0))}
                for key, item in records.items()
                if "trashedAt" not in item
                and (item.get("reads", 0) >= 3 or item.get("folds", 0) >= 3)
            ]
            candidates.sort(key=lambda item: (-item["folds"], -item["reads"], item["id"]))
            return {"candidates": candidates}
        if request.get("mode") == "export":
            key = request.get("id")
            if not _id(key):
                _fail("Invalid skill export request")
            if key not in records:
                _fail("Unknown lifecycle item")
            return _export(records[key], request, now)
        _fail()
    if action != "gc":
        _fail()
    mode = request.get("mode")
    if mode == "configure":
        if not isinstance(request.get("config", {}), dict):
            _fail("Invalid lifecycle configuration")
        config = _config(container.get("gc", {}), request.get("config", {}))
        snapshot.setdefault("config", {})["gc"] = config
        return {"config": config.copy()}
    if mode == "status":
        return _status(records, live, config)
    if mode not in ("collect", "trash", "restore", "purge"):
        _fail()
    if "config" in request:
        _fail()
    if mode == "collect" and "ids" in request:
        _fail()
    ids = _ids(request["ids"]) if "ids" in request else None
    if ids is not None and not ids <= records.keys():
        _fail("Unknown lifecycle item")
    if mode in ("trash", "restore") and ids is None:
        _fail()
    if mode == "restore":
        restored = _restore(records, _walk(ids, edges))
        return {"restored": restored}
    if mode == "trash":
        if ids & live:
            _fail("Cannot trash live lifecycle items")
        retained = {key for key, item in records.items() if "trashedAt" not in item} - ids
        if ids & _walk(retained, edges):
            _fail("Cannot trash referenced lifecycle items")
        trashed = []
        for key in sorted(ids):
            if "trashedAt" not in records[key]:
                records[key]["trashedAt"] = now
                trashed.append(key)
        return {"trashed": trashed}
    if mode == "purge":
        ids = {key for key, item in records.items() if "trashedAt" in item} if ids is None else ids
        if ids & live or any("trashedAt" not in records[key] for key in ids):
            _fail("Cannot purge active lifecycle items")
        safe = _purgeable(ids, records, edges)
        if safe != ids:
            _fail("Cannot purge referenced lifecycle items")
        _remove(snapshot, ids)
        return {"purged": sorted(ids)}
    if config["strength"] == "off":
        return {"trashed": [], "restored": [], "purged": []}
    restored = _restore(records, live)
    candidates = set()
    active = {key for key, item in records.items() if "trashedAt" not in item}
    for key in active - live:
        item = records[key]
        # Unknown age is not evidence that an item is cold.
        age = max(item.get("createdAt", now), item.get("lastUsedAt", item.get("createdAt", now)))
        uses = item.get("reads", 0) + item.get("folds", 0)
        if now - age >= config["idleSeconds"] and uses <= config["maxUses"]:
            candidates.add(key)
    # A retained recent group/version must still be readable with its ancestors.
    candidates -= _walk(active - candidates, edges)
    trashed = sorted(candidates)
    for key in trashed:
        records[key]["trashedAt"] = now
    purged = set()
    if config["autoPurge"]:
        expired = {key for key, item in records.items()
                   if "trashedAt" in item and key not in live
                   and now - item["trashedAt"] >= config["retentionSeconds"]}
        purged = _purgeable(expired, records, edges)
        _remove(snapshot, purged)
    return {"trashed": sorted(trashed), "restored": restored, "purged": sorted(purged)}
