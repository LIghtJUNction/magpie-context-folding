import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from context_folding.core import Client, FoldingError


class ClientIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "archive.sqlite"
        self.client = Client(self.database)
        self.addCleanup(self.client.close)
        self.clock = patch("context_folding.core.time.time", return_value=1000)
        self.time = self.clock.start()
        self.addCleanup(self.clock.stop)

    def call(self, action, **fields):
        return self.client.call(dict(scope="test", action=action, **fields))

    def put(self, text, **fields):
        return self.call("put", text=text, **fields)

    def stored(self):
        connection = sqlite3.connect(self.database)
        try:
            row = connection.execute("SELECT data FROM scopes WHERE scope='test'").fetchone()
            return row[0] if row else None
        finally:
            connection.close()

    def nodes(self):
        state = json.loads(self.stored())
        return {item["id"]: item for item in state["entries"] + state["groups"]}

    def mark(self, item, disposition="foldable", **fields):
        return self.call("mark", id=item["id"], disposition=disposition,
                         **({"summary": "Historical result"} if disposition == "foldable" else {}), **fields)

    def rendered(self, item, **fields):
        return self.call("render", ids=[item["id"]], **fields)["entries"][0]

    def test_file_revert_creates_acyclic_monotonic_versions_and_identical_reads_reuse_head(self):
        source = {"path": "/project/input.txt", "range": "full"}
        first = self.put("A", source=source)
        second = self.put("B", source=source)
        reverted = self.put("A", source=source)
        repeated = self.put("A", source=source)
        self.assertEqual([item["version"]["number"] for item in (first, second, reverted)], [1, 2, 3])
        self.assertNotEqual(first["id"], reverted["id"])
        self.assertEqual(reverted, repeated)
        self.assertEqual(second["version"]["previousId"], first["id"])
        self.assertEqual(reverted["version"]["previousId"], second["id"])
        self.assertEqual(self.call("status")["entries"], 3)
        for item, expected in ((first, "A"), (second, "B"), (reverted, "A")):
            self.assertEqual(self.call("read", id=item["id"])["text"], expected)

    def test_source_path_range_and_scope_are_independent(self):
        first = self.put("same", source={"path": "/p/a", "range": "1:2"})
        others = [self.put("same", source=source) for source in (
            {"path": "/p/b", "range": "1:2"}, {"path": "/p/a", "range": "3:4"})]
        self.assertEqual(len({item["version"]["series"] for item in [first] + others}), 3)
        self.assertTrue(all(item["version"]["number"] == 1 for item in others))
        with self.assertRaises(FoldingError):
            self.client.call(dict(scope="other", action="read", id=first["id"]))
        self.assertEqual(self.call("read", id=first["id"])["text"], "same")




    def test_resolve_failure_rolls_back_read_counters_and_timestamps(self):
        item = self.put("original")
        before = self.stored()
        self.time.return_value = 2000
        with self.assertRaises(FoldingError):
            self.call("resolve", value=[item["reference"], "[[cf:v1:" + "0" * 24 + "]]"])
        self.assertEqual(self.stored(), before)
        with self.assertRaises(FoldingError):
            self.call("resolve", value=[item["reference"], "[[cf:v9:invalid]]"])
        self.assertEqual(self.stored(), before)

    def test_resolve_one_pass_nested_json_and_literal_keys(self):
        inner = self.put("original inner")
        outer = self.put("Archive contains " + inner["reference"])
        request = {outer["reference"]: [outer["reference"], "prefix " + inner["reference"], None, True, 3, 2.5]}
        result = self.call("resolve", value=request)
        self.assertEqual(result["resolved"], 2)
        self.assertEqual(result["value"][outer["reference"]],
                         ["Archive contains " + inner["reference"], "prefix original inner", None, True, 3, 2.5])
        self.assertEqual(self.nodes()[inner["id"]]["reads"], 1)
        self.assertEqual(self.nodes()[outer["id"]]["reads"], 1)

    def test_resolve_requires_strict_json_and_bounds_depth(self):
        for value in (float("nan"), float("inf"), {1: "value"}, ("tuple",), {"set"}, object()):
            with self.subTest(value=type(value)), self.assertRaises(FoldingError):
                self.call("resolve", value=value)
        value = "leaf"
        for _ in range(66):
            value = [value]
        with self.assertRaises(FoldingError):
            self.call("resolve", value=value)
        with self.assertRaises(FoldingError):
            self.call("resolve", value=[None] * 100001)

    def test_resolve_aggregate_utf8_budget_rolls_back(self):
        item = self.put("界" * 30)
        before = self.stored()
        # A lowered runtime limit exercises aggregate byte accounting without
        # allocating multi-megabyte fixtures. Each individual value fits.
        with patch("context_folding.core.MAX_TEXT", 32):
            with self.assertRaises(FoldingError):
                self.call("resolve", value=[item["reference"], item["reference"]])
            self.assertEqual(self.stored(), before)
            with self.assertRaises(FoldingError):
                self.call("resolve", value={"long-key" * 20: "x"})
        self.assertEqual(self.stored(), before)




    def test_gc_requires_explicit_configuration_for_automatic_collection(self):
        item = self.put("cold")
        self.call("roots", ids=[])
        self.time.return_value = 100 * 86400
        self.call("status")
        self.assertNotIn("trashedAt", self.nodes()[item["id"]])
        self.call("gc", mode="configure", config={"strength": "aggressive", "idleSeconds": 1})
        self.assertNotIn("trashedAt", self.nodes()[item["id"]])
        self.call("status")
        self.assertNotIn("trashedAt", self.nodes()[item["id"]])
        self.call("gc", mode="collect")
        self.assertIn("trashedAt", self.nodes()[item["id"]])
        self.call("gc", mode="restore", ids=[item["id"]])
        self.assertNotIn("trashedAt", self.nodes()[item["id"]])
        self.call("roots", ids=[item["id"]])
        self.assertEqual(self.call("read", id=item["id"])["text"], "cold")





    def test_roots_and_version_dependencies_survive_gc_and_purge(self):
        source = {"path": "/p/versioned"}
        old = self.put("old", source=source)
        head = self.put("new", source=source)
        self.call("roots", ids=[head["id"]])
        self.time.return_value = 100 * 86400
        self.assertEqual(self.call("gc", mode="collect")["trashed"], [])
        with self.assertRaises(FoldingError):
            self.call("gc", mode="trash", ids=[old["id"]])
        self.call("roots", ids=[])
        self.assertEqual(set(self.call("gc", mode="collect")["trashed"]), {old["id"], head["id"]})
        self.call("roots", ids=[head["id"]])
        self.assertTrue(all("trashedAt" not in item for item in self.nodes().values()))
        self.assertEqual(self.call("read", id=old["id"])["text"], "old")
        self.assertEqual(self.call("gc", mode="purge")["purged"], [])

    def test_repeated_put_restores_trashed_version_dependency_closure(self):
        source = {"path": "/p/versioned"}
        old = self.put("old", source=source)
        head = self.put("new", source=source)
        self.call("roots", ids=[])
        self.call("gc", mode="trash", ids=[old["id"], head["id"]])
        repeated = self.put("new", source=source)
        self.assertEqual(repeated["id"], head["id"])
        self.assertTrue(all("trashedAt" not in item for item in self.nodes().values()))
        self.assertEqual(self.call("read", id=old["id"])["text"], "old")

    def test_paste_unicode_slice_exclusive_destination_and_private_creation(self):
        item = self.put("甲乙🙂z")
        path = Path(self.temporary.name) / "pasted.txt"
        seen_modes = []
        original_fdopen = os.fdopen
        def inspect_creation(fd, *args, **kwargs):
            seen_modes.append(os.fstat(fd).st_mode & 0o777)
            return original_fdopen(fd, *args, **kwargs)
        with patch("context_folding.core.os.fdopen", side_effect=inspect_creation):
            result = self.call("paste", id=item["id"], offset=1, limit=2, path=str(path))
        self.assertEqual(path.read_text(), "乙🙂")
        self.assertEqual(result["chars"], 2)
        self.assertEqual(result["bytes"], len("乙🙂".encode()))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(seen_modes, [0o600])
        before = self.stored()
        with self.assertRaises(FoldingError):
            self.call("paste", id=item["id"], path=str(path))
        self.assertEqual(path.read_text(), "乙🙂")
        self.assertEqual(self.stored(), before)


if __name__ == "__main__":
    unittest.main()
