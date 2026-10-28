"""Sibling region expansion replaces the removed nested-fold contract."""
from pathlib import Path
import tempfile
import unittest

from context_folding import Client, FoldingError


def source_document():
    return "".join(f"// @context-fold begin {name}\n" + (name + " = 1;\n") * 70
                   + f"// @context-fold end {name}\n" for name in ("left", "right"))


class ExpansionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.client = Client(Path(self.directory.name) / "archive.sqlite", config={"folding": {"delay_requests": 0}})
        self.addCleanup(self.client.close)

    def test_expansion_preserves_siblings_and_exact_original(self):
        source = source_document()
        view = self.client.read_source("s", text=source, expand=["left"], limit=24000)
        self.assertEqual([r["name"] for r in view["foldedRegions"]], ["right"])
        self.assertEqual(self.client.resolve("s", view["text"])["value"], source)
        self.assertEqual([r["name"] for r in self.client.read_source("s", id=view["id"])["foldedRegions"]], ["right"])

    def test_unknown_selector_and_mode_roll_back(self):
        self.client.annotate("s", text=source_document())
        before = self.client._db.execute("SELECT data FROM scopes").fetchall()
        for fields in ({"expand": ["absent"]}, {"expandMode": "all"}, {"expand": [True]}):
            with self.assertRaises(FoldingError):
                self.client.read_source("s", text=source_document(), **fields)
            self.assertEqual(before, self.client._db.execute("SELECT data FROM scopes").fetchall())

    def test_nested_markers_preserve_all_text(self):
        source = "// @context-fold begin outer\n" + source_document() + "// @context-fold end outer\n"
        view = self.client.read_source("s", text=source, limit=24000)
        self.assertEqual(view["text"], source)
        self.assertEqual(view["foldedRegions"], [])


if __name__ == "__main__":
    unittest.main()
