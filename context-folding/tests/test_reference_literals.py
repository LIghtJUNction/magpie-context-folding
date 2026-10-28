from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError
from context_folding.annotations import compact_source, fold_regions


class ReferenceLiteralTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.client = Client(Path(self.temporary.name) / "archive.sqlite", config={"folding": {"delay_requests": 0}})
        self.addCleanup(self.client.close)
        self.reference = self.client.put("s", "UNRELATED ARCHIVED TEXT")["reference"]
        self.literals = (self.reference, "[[cf:v1:" + "0" * 24 + "]]", "[[cf:unsupported]]", "[[cf:")

    def state(self):
        return self.client._db.execute("SELECT scope,data FROM scopes ORDER BY scope").fetchall()

    def source(self, literal, *, visible):
        line = f"literal = {literal!r}\n"
        body = "".join(f"    value_{index} = {index}\n" for index in range(50))
        return (line if visible else "") + "# @context-fold begin work\ndef work():\n" + ("" if visible else "    " + line) + body + "# @context-fold end work\n"

    def test_visible_reference_literals_remain_literal_beside_valid_folds(self):
        for literal in self.literals:
            with self.subTest(literal=literal):
                source = self.source(literal, visible=True)
                view = self.client.read_source("s", text=source, language="python")
                self.assertTrue(view["text"].startswith(f"literal = {literal!r}\n"))
                self.assertEqual(len(view["foldedRegions"]), 1)
                self.assertNotIn("UNRELATED ARCHIVED TEXT", view["text"])
                self.assertEqual(self.client.resolve("s", view["reference"])["value"], source)

    def test_original_mode_and_whole_entry_reference_preserve_literals(self):
        for literal in self.literals:
            with self.subTest(literal=literal):
                source = self.source(literal, visible=True)
                result = self.client.read_source("s", text=source, language="python", mode="original")
                self.assertEqual(result["text"], source)
                self.assertEqual(self.client.resolve("s", result["reference"])["value"], source)
                annotation = self.client.annotate("s", id=result["id"])
                with self.assertRaisesRegex(ValueError, "mode='original'"):
                    compact_source(source, annotation)

    def test_unknown_or_embedded_reference_literals_keep_the_affected_body(self):
        for literal in self.literals:
            with self.subTest(literal=literal):
                source = self.source(literal, visible=False)
                view = self.client.read_source("s", text=source, language="python")
                self.assertEqual(view["foldedRegions"], [])
                self.assertEqual(view["text"], source)

    def test_keep_and_expansion_cannot_expose_ambiguous_literals_in_compact_view(self):
        source = self.source(self.reference, visible=False)
        stored = self.client.annotate("s", text=source, language="python")
        options = [{"expand": ["work"], "expandMode": mode} for mode in ("single", "recursive")]
        options += [{"keep": ["work"]}, *(
            {"marks": [{"name": "work", "disposition": disposition}]}
            for disposition in ("keep", "unmarked"))]
        for fields in options:
            with self.subTest(fields=fields):
                before = self.state()
                with self.assertRaises(FoldingError):
                    self.client.read_source("s", id=stored["id"], **fields)
                self.assertEqual(self.state(), before)
        before = self.state()
        self.assertEqual(self.client.read("s", stored["id"])["text"], source)
        self.assertEqual(self.state(), before)

    def test_adapter_keeps_visible_literals_without_interpreting_them(self):
        region = "# @context-fold begin work\n" + "value = 123\n" * 10 + "# @context-fold end work\n"
        for literal in self.literals:
            for source in (f"literal = {literal!r}\n" + region, region + f"literal = {literal!r}\n"):
                view = fold_regions(self.client, "s", source, language="python")
                self.assertIn(f"literal = {literal!r}\n", view["text"])
                self.assertEqual(len(view["references"]), 1)
                self.assertNotIn("UNRELATED ARCHIVED TEXT", view["text"])

    def test_adapter_preserves_unknown_literals_and_exact_newlines(self):
        for literal in self.literals:
            for newline in ("\n", "\r\n", "\r"):
                with self.subTest(literal=literal, newline=repr(newline)):
                    source = ("# @context-fold begin work\n" + f"literal = {literal!r}\n"
                              + "value = 123\n" * 10 + "# @context-fold end work").replace("\n", newline)
                    folded = fold_regions(self.client, "s", source, language="python")
                    self.assertEqual(folded["references"], [])
                    self.assertEqual(folded["text"], source)


if __name__ == "__main__":
    unittest.main()
