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

    def test_visible_reference_literals_reject_compact_read_and_rollback(self):
        for literal in self.literals:
            with self.subTest(literal=literal):
                source = self.source(literal, visible=True)
                before = self.state()
                with self.assertRaises(FoldingError) as error:
                    self.client.read_source("s", text=source, language="python")
                self.assertEqual(error.exception.code, "invalid_request")
                self.assertEqual(error.exception.message,
                                 "Visible source contains a reserved reference prefix; use mode='original'")
                self.assertNotIn(literal, error.exception.message)
                self.assertNotIn(source, error.exception.message)
                self.assertEqual(self.state(), before)

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

    def test_hidden_literals_roundtrip_once_without_interpreting_payload(self):
        for literal in self.literals:
            with self.subTest(literal=literal):
                source = self.source(literal, visible=False)
                view = self.client.read_source("s", text=source, language="python")
                if "[[cf:v1:" in literal:
                    self.assertEqual(view["foldedRegions"], [])
                    self.assertEqual(view["text"], source)
                else:
                    self.assertEqual(len(view["foldedRegions"]), 1)
                    self.assertEqual(self.client.resolve("s", view["text"])["value"], source)

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
        self.assertEqual(self.client.read("s", stored["id"], mode="original")["text"], source)

    def test_adapter_checks_visible_literals_and_rolls_back_all_writes(self):
        region = "# @context-fold begin work\n" + "value = 123\n" * 50 + "# @context-fold end work\n"
        for literal in self.literals:
            for source in (f"literal = {literal!r}\n" + region, region + f"literal = {literal!r}\n"):
                before = self.state()
                with self.assertRaises(FoldingError):
                    fold_regions(self.client, "s", source, language="python")
                self.assertEqual(self.state(), before)

    def test_legacy_adapter_preserves_hidden_literals_and_exact_newlines(self):
        for literal in self.literals:
            for newline in ("\n", "\r\n", "\r"):
                with self.subTest(literal=literal, newline=repr(newline)):
                    source = ("# @context-fold begin work\n" + f"literal = {literal!r}\n"
                              + "value = 123\n" * 50 + "# @context-fold end work").replace("\n", newline)
                    folded = fold_regions(self.client, "s", source, language="python")
                    if "[[cf:v1:" in literal:
                        self.assertEqual(folded["references"], [])
                        self.assertEqual(folded["text"], source)
                    else:
                        self.assertEqual(len(folded["references"]), 1)
                        self.assertEqual(self.client.resolve("s", folded["text"])["value"], source)


if __name__ == "__main__":
    unittest.main()
