"""Archive inspection is bounded, composable and independent of fold state."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError
from context_folding.annotations import discover_source
from context_folding.core import _content_hash


def block(label, body, newline="\n"):
    return f"@context-fold begin {label}{newline}{body}{newline}@context-fold end {label}{newline}"


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class NestedSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "archive.sqlite3"
        self.client = Client(self.path)
        self.addCleanup(self.client.close)

    def state(self):
        return self.client._db.execute("SELECT scope,data FROM scopes ORDER BY scope").fetchall()

    def nested(self, newline="\n"):
        leaf = newline.join(f"needle 深层 {i} " + "x" * 20 for i in range(35))
        middle = "middle heading" + newline + block("leaf", leaf, newline) + "middle tail"
        outer = "outer heading" + newline + block("middle", middle, newline) + "outer tail"
        return block("outer", outer, newline), {"outer": outer, "middle": middle, "leaf": leaf}

    def test_nested_archive_preserves_raw_hash_and_exposes_one_layer(self):
        text, bodies = self.nested("\r\n")
        folded = self.client.fold("s", text)
        self.assertEqual([r["label"] for r in folded["references"]], ["outer"])
        outer = folded["references"][0]
        self.assertEqual(outer["sha256"], digest(bodies["outer"]))
        self.assertNotIn("middle", folded["text"])
        rows = self.client.list("s", recursive=True)["entries"]
        self.assertEqual([row["label"] for row in rows], ["outer", "middle", "leaf"])
        self.assertEqual([row["depth"] for row in rows], [0, 1, 2])
        self.assertEqual([row["childCount"] for row in rows], [1, 1, 0])
        for index, row in enumerate(rows):
            self.assertEqual(row["sha256"], digest(bodies[row["label"]]))
            self.assertEqual(row["bytes"], len(bodies[row["label"]].encode("utf-8")))
            self.assertEqual(row["parentId"], rows[index - 1]["id"] if index else None)
        parent = self.client.read("s", outer["id"])
        self.assertIn(rows[1]["reference"], parent["text"])
        self.assertNotIn("needle", parent["text"])
        self.assertNotIn("middle heading", parent["text"])
        self.assertIn("\r\n", parent["text"])
        self.assertEqual(parent["viewSha256"], digest(parent["text"]))
        self.assertNotEqual(parent["sha256"], parent["viewSha256"])
        self.assertEqual(self.client.meta("s", outer["id"])["children"], [rows[1]["id"]])
        # Explicit legacy export remains one pass and does not alter the query view.
        self.assertEqual(self.client.resolve("s", outer["reference"])["value"], bodies["outer"])
        self.assertEqual(self.client.read("s", outer["id"])["text"], parent["text"])

    def test_closed_children_survive_unclosed_or_malformed_parent(self):
        child = block("child", "complete child payload " * 30)
        unclosed = "@context-fold begin outer\n" + child
        folded = self.client.fold("s", unclosed)
        self.assertEqual([r["label"] for r in folded["references"]], ["child"])
        self.assertTrue(folded["text"].startswith("@context-fold begin outer\n"))
        malformed = ("@context-fold begin outer\n" + child
                     + "@context-fold end wrong\n@context-fold end outer\n"
                     + block("later", "independent later payload " * 20))
        result = self.client.fold("s", malformed)
        self.assertEqual([r["label"] for r in result["references"]], ["child", "later"])
        self.assertIn("@context-fold end wrong", result["text"])
        with self.assertRaises(ValueError):
            discover_source(malformed, strict=True)
        self.assertEqual(len(discover_source(block("parent", child), strict=True)["regions"]), 2)

    def test_queries_do_not_write_keep_statistics_retention_or_gc(self):
        text, _ = self.nested()
        result = self.client.fold("s", text)
        identifier = result["references"][0]["id"]
        before = self.state()
        with Client(self.path, config={"gc": {"enabled": True, "idle_seconds": 0,
                    "max_uses": 0, "retention_seconds": 0, "auto_purge": True}}) as queries:
            queries.read("s", identifier)
            queries.read("s", identifier, peek=False, startLine=2, endLine=3)
            queries.meta("s", identifier)
            queries.list("s", recursive=True)
            queries.grep("s", "needle", id=identifier, context=1)
            queries.call({"action": "status", "scope": "s"})
        self.assertEqual(self.state(), before)

    def test_read_does_not_change_source_delay_or_future_projection(self):
        text, _ = self.nested()
        initial = self.client.read_source("s", text=text, occurrence="source", requestCycle=4, limit=24000)
        self.assertEqual(initial["text"], text)
        body = self.client.list("s", id=initial["id"], recursive=True)["entries"][1]
        before = self.state()
        self.client.read("s", body["id"])
        self.assertEqual(self.state(), before)
        folded = self.client.read_source("s", text=text, occurrence="source", requestCycle=5, limit=24000)
        self.assertEqual(len(folded["foldedRegions"]), 1)
        self.client.read("s", initial["id"])
        again = self.client.read_source("s", text=text, occurrence="source", requestCycle=6, limit=24000)
        self.assertEqual(again["text"], folded["text"])

    def test_read_default_limit_and_exact_unicode_physical_lines(self):
        body = "第一行\r\n" + "🧪长行" * 600 + "\r\nlast-no-newline"
        folded = self.client.fold("s", block("long", body, "\r\n"))
        identifier = folded["references"][0]["id"]
        page = self.client.read("s", identifier)
        self.assertEqual(page["text"], body[:1200])
        self.assertEqual(page["nextOffset"], 1200)
        self.assertEqual(page["totalLines"], 3)
        self.assertEqual(page["sha256"], digest(body))
        tail = self.client.read("s", identifier, offset=1200, limit=24000)
        self.assertEqual(page["text"] + tail["text"], body)
        line = self.client.read("s", identifier, startLine=3, endLine=3)
        self.assertEqual(line["text"], "last-no-newline")
        self.assertEqual((line["startLine"], line["endLine"]), (3, 3))
        first = self.client.read("s", identifier, startLine=1, endLine=1)
        self.assertEqual(first["text"], "第一行\r\n")
        clipped = self.client.read("s", identifier, startLine=2, endLine=2, limit=8)
        self.assertEqual(clipped["text"], ("🧪长行" * 600)[:8])
        self.assertEqual(clipped["nextOffset"], len("第一行\r\n") + 8)

    def test_grep_searches_each_view_once_and_read_uses_same_lines(self):
        text, _ = self.nested("\r\n")
        root = self.client.fold("s", text)["references"][0]["id"]
        all_rows = self.client.list("s", id=root, recursive=True)["entries"]
        leaf = all_rows[-1]
        found = self.client.grep("s", "needle", id=root)
        self.assertEqual(len(found["matches"]), 10)
        self.assertEqual({hit["id"] for hit in found["matches"]}, {leaf["id"]})
        self.assertEqual(found["nextOffset"], 10)
        following = self.client.grep("s", "needle", id=root, offset=10, limit=100)
        self.assertEqual(len(following["matches"]), 25)
        self.assertIsNone(following["nextOffset"])
        hit = following["matches"][0]
        line = self.client.read("s", hit["id"], startLine=hit["line"], endLine=hit["line"])
        self.assertEqual(line["text"].rstrip("\r\n"), hit["text"])
        self.assertEqual(self.client.grep("s", "needle", id=root, recursive=False)["matches"], [])
        middle = self.client.grep("s", "middle heading", id=all_rows[1]["id"])["matches"]
        self.assertEqual([hit["line"] for hit in middle], [1])

    def test_grep_is_literal_bounded_and_reports_context_offsets(self):
        line = "a" * 700 + "[a.*]" + "z" * 700
        body = "before " + "b" * 500 + "\n" + line + "\nafter " + "c" * 500
        identifier = self.client.fold("s", block("literal", body))["references"][0]["id"]
        hit = self.client.grep("s", "[a.*]", id=identifier, context=1)["matches"][0]
        self.assertEqual(hit["line"], 2)
        self.assertIn("[a.*]", hit["text"])
        self.assertLessEqual(len(hit["text"]), 160)
        self.assertGreater(hit["textOffset"], 0)
        self.assertEqual(hit["text"], line[hit["textOffset"]:hit["textOffset"] + 160])
        self.assertEqual([row["line"] for row in hit["context"]], [1, 3])
        self.assertTrue(all(len(row["text"]) <= 160 for row in hit["context"]))
        self.assertEqual(self.client.grep("s", "a.*z", id=identifier)["matches"], [])

    def test_list_depth_and_metadata_children_have_bounded_pages(self):
        children = "".join(block(f"child-{i}", f"unique payload {i} " * 20) for i in range(13))
        root = self.client.fold("s", block("parent", children))["references"][0]["id"]
        default = self.client.list("s", id=root)
        self.assertEqual(len(default["entries"]), 10)
        self.assertEqual(default["nextOffset"], 10)
        self.assertEqual(default["total"], 14)
        self.assertEqual(len(self.client.list("s", id=root, depth=0)["entries"]), 1)
        second = self.client.list("s", id=root, offset=10)
        self.assertEqual(len(second["entries"]), 4)
        self.assertIsNone(second["nextOffset"])
        meta = self.client.meta("s", root)
        self.assertEqual(meta["childCount"], 13)
        self.assertEqual(len(meta["children"]), 10)
        self.assertEqual(meta["nextOffset"], 10)
        self.assertEqual(len(self.client.meta("s", root, offset=10)["children"]), 3)
        self.assertNotIn("text", meta)
        self.assertNotIn("text", default["entries"][0])

    def test_known_child_reference_can_be_folded_inside_later_closed_parent(self):
        child_body = "archived child detail " * 60
        first = self.client.fold("s", "@context-fold begin parent\nparent head\n" + block("child", child_body))
        child = first["references"][0]
        second_input = first["text"] + "parent tail\n@context-fold end parent\n"
        second = self.client.fold("s", second_input)
        self.assertEqual([r["label"] for r in second["references"]], ["parent"])
        parent = second["references"][0]
        actual_parent_body = second_input.split("\n", 1)[1].rsplit("\n@context-fold end parent", 1)[0]
        self.assertEqual(parent["sha256"], digest(actual_parent_body))
        self.assertEqual(self.client.meta("s", parent["id"])["children"], [child["archiveId"]])
        view = self.client.read("s", parent["id"])["text"]
        self.assertIn(child["reference"], view)
        self.assertNotIn(child_body, view)
        self.assertEqual(self.client.read("s", child["id"], limit=24000)["text"], child_body)
        self.assertEqual(self.client.fold("s", second["text"])["text"], second["text"])

    def test_unknown_child_reference_preserves_parent_and_independent_siblings(self):
        unknown = "[[cf:v2:aaaaaaaaaaaa]]"
        affected = block("parent", "parent head\n" + block("child", unknown) + "parent tail")
        sibling = block("sibling", "fresh independent payload " * 30)
        result = self.client.fold("s", affected + sibling)
        self.assertTrue(result["text"].startswith(affected))
        self.assertEqual([row["label"] for row in result["references"]], ["sibling"])
        self.assertEqual([row["label"] for row in self.client.list("s")["entries"]], ["sibling"])
        other_scope = block("parent", block("child", result["references"][0]["reference"]))
        self.assertEqual(self.client.fold("other", other_scope)["text"], other_scope)

    def test_source_projection_links_known_children_and_keeps_other_literals(self):
        child = self.client.fold("s", block("child", "already stored child " * 40))["references"][0]
        unknown = "[[cf:v2:aaaaaaaaaaaa]]"
        valid = block("parent", "head\n" + block("child", child["reference"]) + "tail")
        affected = block("uncertain", block("unknown", unknown) + "untrusted literal " * 10)
        source = "visible literal [[cf:unsupported]]\n" + valid + affected
        self.assertEqual(self.client.read_source("s", text=source, occurrence="mixed", requestCycle=0,
                                               limit=24000)["text"], source)
        view = self.client.read_source("s", text=source, occurrence="mixed", requestCycle=1, limit=24000)
        self.assertEqual([row["name"] for row in view["foldedRegions"]], ["parent"])
        self.assertTrue(view["text"].startswith("visible literal [[cf:unsupported]]\n"))
        self.assertTrue(view["text"].endswith(affected))
        parent = next(row for row in self.client.list("s", id=view["id"], recursive=True)["entries"]
                      if row["label"] == "parent")
        self.assertEqual(self.client.meta("s", parent["id"])["children"], [child["archiveId"]])
        self.assertIn(child["reference"], self.client.read("s", parent["id"])["text"])

    def test_ambiguous_nested_reference_is_not_archived_as_a_new_payload(self):
        first, second = "first stored original " * 10, "second stored original " * 10
        self.client.put("s", first)
        self.client.put("s", second)
        before = self.state()
        real_hash = _content_hash
        def collided(node):
            if node.get("text") in (first, second):
                return "abcdefabcdef" + ("0" if node["text"] == first else "1") * 52
            return real_hash(node)
        source = block("parent", block("child", "[[cf:v2:abcdefabcdef]]") + "tail " * 30)
        with patch("context_folding.core._content_hash", side_effect=collided):
            result = self.client.fold("s", source)
        self.assertEqual(result["text"], source)
        self.assertEqual(result["references"], [])
        self.assertEqual(self.state(), before)

    def test_reused_children_are_visited_once_without_losing_parent_edges(self):
        child = "shared-child-needle " * 30
        root = self.client.fold("s", block("parent", block("one", child) + block("two", child)))["references"][0]["id"]
        meta = self.client.meta("s", root)
        self.assertEqual(meta["childCount"], 2)
        self.assertEqual(meta["children"][0], meta["children"][1])
        self.assertEqual(len(self.client.list("s", id=root, recursive=True)["entries"]), 2)
        hits = self.client.grep("s", "shared-child-needle", id=root)["matches"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(self.client.read("s", root)["text"].count("[[cf:v2:"), 2)

    def test_recursive_queries_have_cycle_protection(self):
        identifier = self.client.put("s", "cyclic legacy text " * 30)["id"]
        snapshot = json.loads(self.state()[0][1])
        node = snapshot["entries"][0]
        node["foldChildren"] = [{"id": identifier, "sha256": digest(node["text"]),
                                 "label": "self", "start": 0, "end": 10}]
        self.client._db.execute("UPDATE scopes SET data=? WHERE scope='s'", (json.dumps(snapshot),))
        self.client._db.commit()
        self.assertEqual(len(self.client.list("s", recursive=True)["entries"]), 1)
        self.assertEqual(len(self.client.grep("s", "[[cf:v2:")["matches"]), 1)

    def test_folded_parent_and_children_survive_roots_sync_and_aggressive_gc(self):
        text, bodies = self.nested()
        with Client(self.path, config={"gc": {"enabled": True, "idle_seconds": 0,
                    "max_uses": 0, "retention_seconds": 0, "auto_purge": True}}) as client:
            root = client.fold("s", text)["references"][0]["id"]
            client.call({"action": "roots", "scope": "s", "ids": []})
            rows = client.list("s", id=root, recursive=True)["entries"]
            self.assertEqual(len(rows), 3)
            self.assertEqual(client.read("s", rows[-1]["id"], limit=24000)["text"], bodies["leaf"])

    def test_source_published_nested_references_survive_root_updates(self):
        text, _ = self.nested()
        with Client(self.path, config={"folding": {"delay_requests": 0},
                    "gc": {"enabled": True, "idle_seconds": 0, "max_uses": 0,
                           "retention_seconds": 0, "auto_purge": True}}) as client:
            view = client.read_source("s", text=text, limit=24000)
            identifier = view["foldedRegions"][0]["reference"][8:-2]
            client.call({"action": "roots", "scope": "s", "ids": []})
            self.assertEqual(len(client.list("s", id=identifier, recursive=True)["entries"]), 3)
            self.assertNotIn("needle", client.read("s", identifier)["text"])

    def test_no_benefit_and_failed_nested_archive_do_not_publish_refs(self):
        with Client(self.path, config={"folding": {"max_session_bytes": 1}}) as limited:
            short = block("tiny", "x")
            self.assertEqual(limited.fold("s", short), {"scope": "s", "text": short, "references": []})
            self.assertEqual(self.state(), [])
            text, _ = self.nested()
            with self.assertRaises(FoldingError) as caught:
                limited.fold("s", text)
            self.assertEqual(caught.exception.code, "quota")
            self.assertEqual(self.state(), [])

    def test_invalid_query_arguments_are_atomic(self):
        root = self.client.fold("s", block("data", "body data " * 100))["references"][0]["id"]
        before = self.state()
        bad = [
            {"action": "read", "id": root, "offset": 0, "startLine": 1},
            {"action": "read", "id": root, "startLine": 0},
            {"action": "read", "id": root, "limit": 24001},
            {"action": "read", "id": root, "mode": "original"},
            {"action": "grep", "query": ""},
            {"action": "grep", "query": "body", "context": 4},
            {"action": "grep", "query": "body", "recursive": 1},
            {"action": "list", "depth": 65},
            {"action": "meta", "id": root, "limit": False},
        ]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(FoldingError):
                self.client.call({"scope": "s", **request})
            self.assertEqual(self.state(), before)


if __name__ == "__main__":
    unittest.main()
