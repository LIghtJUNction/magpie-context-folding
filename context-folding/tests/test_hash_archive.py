"""Occurrence identity, durable hash payloads and non-mutating archive queries."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError


def block(label, text):
    return f"@context-fold begin {label}\n{text}\n@context-fold end {label}"


class HashArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / ".git").mkdir()
        self.path = self.directory / "archive.sqlite3"
        self.client = Client(self.path, project_dir=self.directory)
        self.addCleanup(self.client.close)

    def call(self, action, **fields):
        return self.client.call({"scope": "s", "action": action, **fields})

    def rows(self):
        return self.client._db.execute("SELECT scope,data FROM scopes ORDER BY scope").fetchall()

    def tree(self):
        return self.call("list", recursive=True, limit=100)["entries"]

    def test_duplicate_siblings_have_distinct_nodes_and_one_payload(self):
        body = "same needle 原文🙂\n" * 30
        source = block("one", body) + "\n" + block("two", body)
        result = self.client.fold("s", source, sourceId="message-1")
        first, second = result["references"]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(first["reference"], f"[[cf:v3:{first['id']}]]")
        self.assertEqual(len(first["id"]), 64)
        self.assertEqual(self.client._db.execute("SELECT COUNT(*) FROM blobs").fetchone()[0], 1)
        stored = json.loads(self.rows()[0][1])
        self.assertTrue(all("text" not in entry and "textHash" in entry for entry in stored["entries"]))
        self.assertEqual(self.client.resolve("s", result["text"])["value"], source)
        nodes = self.tree()
        self.assertEqual([node["label"] for node in nodes], ["one", "two"])
        self.assertLess(nodes[0]["sourceRange"]["start"], nodes[1]["sourceRange"]["start"])

    def test_identical_children_under_distinct_parents_keep_both_paths(self):
        body = "repeat evidence " * 30
        source = block("left", "left prefix\n" + block("child", body)) + "\n" + block("right", "right prefix\n" + block("child", body))
        result = self.client.fold("s", source)
        nodes = self.tree()
        parents = {node["label"]: node for node in nodes if node["label"] in ("left", "right")}
        children = [node for node in nodes if node["label"] == "child"]
        self.assertEqual(len(nodes), 4)
        self.assertEqual(len({child["id"] for child in children}), 2)
        self.assertEqual({child["parentId"] for child in children}, {parent["id"] for parent in parents.values()})
        self.assertEqual(len({child["sha256"] for child in children}), 1)
        page = self.call("list", parentId=parents["left"]["id"])
        self.assertEqual(len(page["entries"]), 1)
        self.assertEqual(page["entries"][0]["parentId"], parents["left"]["id"])
        raw = self.client.read("s", parents["left"]["id"], limit=24000)["text"]
        self.assertEqual(raw.count(body), 1)
        self.assertEqual(self.client.resolve("s", result["text"])["value"], source)

    def test_source_identity_retries_and_revisions(self):
        source = block("same", "old evidence " * 30)
        first = self.client.fold("s", source, sourceId="message-1")
        retry = self.client.fold("s", source, sourceId="message-1")
        other = self.client.fold("s", source, sourceId="message-2")
        changed = self.client.fold("s", source.replace("old evidence", "new evidence"), sourceId="message-1")
        self.assertEqual(first["references"], retry["references"])
        self.assertEqual(len({run["references"][0]["id"] for run in (first, other, changed)}), 3)
        self.assertEqual(self.client.fold("default", source)["references"], self.client.fold("default", source)["references"])

    def test_content_hash_cannot_silently_select_one_occurrence_for_navigation(self):
        body = "shared content needle " * 30
        result = self.client.fold("s", block("left", body) + "\n" + block("right", body))
        digest = result["references"][0]["sha256"]
        for action, fields in (("meta", {"id": digest}), ("list", {"id": digest}),
                               ("list", {"parentId": digest}), ("search", {"query": "needle", "id": digest}),
                               ("restore", {"id": digest})):
            with self.subTest(action=action, fields=fields), self.assertRaises(FoldingError) as raised:
                self.call(action, **fields)
            self.assertEqual(raised.exception.code, "ambiguous_occurrence")
        view = self.client.read("s", digest)
        self.assertEqual(view["text"], body)
        self.assertTrue(view["ambiguousOccurrence"])
        self.assertIsNone(view["parentId"])
        self.assertIsNone(view["sourceRange"])
        self.assertEqual(view["matchingNodeCount"], 2)
        self.assertEqual(set(view["matchingNodeIds"]), {item["id"] for item in result["references"]})
        self.assertEqual(self.client.resolve("s", f"[[cf:v2:{digest}]]")["value"], body)
        for index in range(21):
            self.client.fold("s", block("copy", body), sourceId=f"copy-{index}")
        many = self.client.read("s", digest)
        self.assertEqual(many["matchingNodeCount"], 23)
        self.assertEqual(len(many["matchingNodeIds"]), 20)
        self.assertTrue(many["matchingNodeIdsTruncated"])

    def test_read_source_occurrences_and_paths_do_not_share_instances(self):
        source = "\n".join("# " + line if line.startswith("@context-fold") else line for line in block("scope", "value = 1\n" * 30).splitlines())
        a = self.client.read_source("s", text=source, language="python", occurrence="tool-call-a", requestCycle=0)
        b = self.client.read_source("s", text=source, language="python", occurrence="tool-call-b", requestCycle=0)
        self.assertNotEqual(a["id"], b["id"])
        a_children = self.call("list", parentId=a["id"])["entries"]
        b_children = self.call("list", parentId=b["id"])["entries"]
        self.assertEqual(len(a_children), 1)
        self.assertEqual(len(b_children), 1)
        self.assertNotEqual(a_children[0]["id"], b_children[0]["id"])

    def test_parser_change_preserves_old_occurrence_graph_and_original(self):
        body = "inner body\n" * 30
        source = "@@ @context-fold begin outer\n<!-- @context-fold begin child -->\n" + body + "<!-- @context-fold end child -->\n@@ @context-fold end outer\n"
        first = self.client.annotate("s", text=source, language="explicit", sourceId="source")
        child = first["regions"][0]["archiveId"]
        old_meta = self.call("meta", id=child)
        second = self.client.annotate("s", text=source, language="explicit", sourceId="source", commentStyles=[{"start": "@@"}])
        outer, nested = second["regions"]
        self.assertEqual(outer["name"], "outer")
        self.assertEqual(nested["parentId"], outer["archiveId"])
        self.assertNotEqual(child, nested["archiveId"])
        self.assertEqual(self.call("meta", id=child), old_meta)
        self.assertEqual(self.client.read("s", child)["text"], self.client.read("s", nested["archiveId"])["text"])
        repeated = self.client.annotate("s", text=source, language="explicit", sourceId="source", commentStyles=[{"start": "@@"}])
        self.assertEqual([r["archiveId"] for r in repeated["regions"]], [r["archiveId"] for r in second["regions"]])

    def test_queries_are_read_only_paginated_and_scope_bound(self):
        source = block("parent", "prefix\n" + block("child", "needle🙂 evidence\n" * 40))
        folded = self.client.fold("s", source)
        parent = folded["references"][0]["id"]
        before = self.rows()
        changes = self.client._db.total_changes
        self.client.read("s", parent, limit=17)
        self.call("list", limit=1)
        self.call("meta", id=parent, limit=1)
        matches = self.call("search", query="needle🙂", id=parent, limit=1)
        self.assertIsNotNone(matches["nextOffset"])
        hit = matches["matches"][0]
        raw = self.client.read("s", hit["id"], offset=hit["offset"], limit=len("needle🙂"))
        self.assertEqual(raw["text"], "needle🙂")
        next_page = self.call("search", query="needle🙂", id=parent, limit=1, offset=matches["nextOffset"])
        self.assertNotEqual((hit["id"], hit["offset"]), (next_page["matches"][0]["id"], next_page["matches"][0]["offset"]))
        self.call("status")
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.client._db.total_changes, changes)
        with self.assertRaises(FoldingError):
            self.client.read("other", parent)
        self.assertEqual(self.client.call({"action": "search", "scope": "other", "query": "needle"})["matches"], [])
        self.assertEqual(self.rows(), before)

    def test_old_snapshot_and_v1_v2_references_migrate_without_rekeying(self):
        text = "legacy original🙂"
        identifier = "a" * 24
        entry = {"id": identifier, "text": text, "role": "tool", "createdAt": 1, "lastUsedAt": 1, "reads": 0, "folds": 0, "mark": {"disposition": "unmarked"}}
        snapshot = {"entries": [entry], "groups": [], "roots": [identifier], "config": {}}
        encoded = json.dumps(snapshot)
        self.client._db.execute("INSERT INTO scopes VALUES (?,?)", ("s", encoded))
        self.client._db.commit()
        self.assertEqual(self.client.read("s", identifier)["text"], text)
        self.assertEqual(self.rows()[0][1], encoded, "reading must not migrate or write")
        sha = hashlib.sha256(text.encode()).hexdigest()
        for reference in (f"[[cf:v1:{identifier}]]", f"[[cf:v2:{sha[:12]}]]"):
            self.assertEqual(self.client.resolve("s", reference)["value"], text)
        migrated = json.loads(self.rows()[0][1])
        self.assertEqual(migrated["entries"][0]["id"], identifier)
        self.assertNotIn("text", migrated["entries"][0])
        self.assertEqual(self.client._db.execute("SELECT text FROM blobs WHERE hash=?", (sha,)).fetchone()[0], text)

    def test_failed_write_rolls_back_metadata_and_blobs(self):
        original = self.client.fold("s", block("original", "saved original " * 40))
        before = self.rows()
        blobs = self.client._db.execute("SELECT * FROM blobs ORDER BY hash").fetchall()
        with patch("context_folding.core.MAX_STATE", 100):
            with self.assertRaises(FoldingError):
                self.client.fold("s", block("new", "new original " * 40))
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.client._db.execute("SELECT * FROM blobs ORDER BY hash").fetchall(), blobs)
        self.assertTrue(self.client.read("s", original["references"][0]["id"])["text"].startswith("saved"))

    def test_corrupt_payload_hash_fails_without_modifying_state(self):
        result = self.client.fold("s", block("saved", "saved original " * 40))
        self.client._db.execute("UPDATE blobs SET text='tampered'")
        self.client._db.commit()
        before = self.rows()
        with self.assertRaises(FoldingError) as raised:
            self.client.read("s", result["references"][0]["id"])
        self.assertEqual(raised.exception.code, "storage")
        self.assertEqual(self.rows(), before)

    def test_sql_write_failure_does_not_publish_or_leave_partial_payloads(self):
        self.client.fold("s", block("saved", "saved original " * 40))
        before = self.rows()
        blobs = self.client._db.execute("SELECT * FROM blobs ORDER BY hash").fetchall()
        self.client._db.execute("CREATE TRIGGER fail_links BEFORE INSERT ON blob_refs BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        self.client._db.commit()
        with self.assertRaises(FoldingError) as raised:
            self.client.fold("s", block("new", "new original " * 40))
        self.assertEqual(raised.exception.code, "storage")
        self.assertEqual(self.rows(), before)
        self.assertEqual(self.client._db.execute("SELECT * FROM blobs ORDER BY hash").fetchall(), blobs)

    def test_real_cli_search_and_parent_browsing(self):
        result = self.client.fold("s", block("parent", block("child", "Alpha原文🙂 " * 30)))
        parent = result["references"][0]["id"]
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "python"))
        def run(*args):
            result = subprocess.run([sys.executable, "-m", "context_folding", "--state", str(self.path),
                                     *args, "--scope", "s"], env=env, cwd=self.directory,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result.stdout)["result"]
        children = run("list", "--parent", parent)["entries"]
        self.assertEqual(len(children), 1)
        hit = run("search", "--id", children[0]["id"], "--query", "alpha原文🙂", "--ignore-case", "--limit", "1")["matches"][0]
        self.assertEqual(run("read", "--id", hit["id"], "--offset", str(hit["offset"]), "--limit", str(hit["length"]))["text"], "Alpha原文🙂")

    def test_nested_originals_survive_root_changes_and_gc(self):
        folded = self.client.fold("s", block("parent", block("child", "live child " * 30)))
        nodes = self.tree()
        parent = folded["references"][0]["id"]
        child = next(node["id"] for node in nodes if node["parentId"] == parent)
        self.call("roots", ids=[])
        self.call("gc", mode="configure", config={"strength": "aggressive", "idleSeconds": 0, "maxUses": 0, "retentionSeconds": 0, "autoPurge": True})
        self.call("gc", mode="collect")
        self.assertTrue(self.client.read("s", child)["text"].startswith("live child"))
        self.assertEqual(self.call("meta", id=parent)["children"], [child])


if __name__ == "__main__":
    unittest.main()
