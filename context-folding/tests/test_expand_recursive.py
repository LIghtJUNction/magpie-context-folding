"""Selective source expansion preserves surrounding folds and exact originals."""
from pathlib import Path
import tempfile
import unittest

from context_folding import Client, FoldingError


def source_document(newline="\n", trailing=False):
    lines = [
        "// 根区域说明：保留 Unicode ☃",
        "// @context-fold begin root",
        'root_before = "' + "r" * 80 + '";',
        "// 左侧说明保持原样",
        "// @context-fold begin left",
        'left_before = "' + "l" * 80 + '";',
        "// 叶子区域说明",
        "// @context-fold begin leaf",
        'leaf_payload = "' + "叶" * 80 + '";',
        "// @context-fold end leaf",
        'left_after = "' + "a" * 80 + '";',
        "// @context-fold end left",
        "// 兄弟区域说明",
        "// @context-fold begin right",
        'right_payload = "' + "s" * 80 + '";',
        "// @context-fold end right",
        'root_after = "' + "z" * 80 + '";',
        "// @context-fold end root",
        "// 独立区域说明",
        "// @context-fold begin other",
        'other_payload = "' + "o" * 80 + '";',
        "// @context-fold end other",
        "tail();",
    ]
    return newline.join(lines) + (newline if trailing else "")


class RecursiveExpansionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.client = Client(Path(self.directory.name) / "state.sqlite")
        self.addCleanup(self.client.close)
        self.source = source_document()
        self.stored = self.client.annotate("expand", text=self.source, language="explicit")
        self.regions = {r["name"]: r for r in self.stored["regions"]}

    def read(self, **options):
        return self.client.read_source("expand", id=self.stored["id"], **{"limit": 24000, **options})

    def assert_lossless(self, view, original=None):
        self.assertEqual(self.client.resolve("expand", view["text"])["value"],
                         self.source if original is None else original)

    def test_single_root_opens_only_that_region(self):
        view = self.read(expand=["root"], expandMode="single")
        self.assertIn("root_before", view["text"])
        self.assertIn("root_after", view["text"])
        self.assertNotIn("left_before", view["text"])
        self.assertNotIn("right_payload", view["text"])
        self.assertEqual({r["name"] for r in view["foldedRegions"]}, {"left", "right", "other"})
        self.assert_lossless(view)

    def test_single_deep_target_reveals_ancestors_keeps_siblings_folded(self):
        view = self.read(expand=[self.regions["left"]["id"]], expandMode="single")
        for visible in ("root_before", "root_after", "left_before", "left_after"):
            self.assertIn(visible, view["text"])
        for folded in ("leaf_payload", "right_payload", "other_payload"):
            self.assertNotIn(folded, view["text"])
        self.assertEqual({r["name"] for r in view["foldedRegions"]}, {"leaf", "right", "other"})
        self.assert_lossless(view)

    def test_recursive_deep_target_preserves_other_regions_and_legacy_default(self):
        recursive = self.read(expand=["left"], expandMode="recursive")
        legacy = self.read(expand=["left"])
        self.assertEqual(recursive["text"], legacy["text"])
        self.assertIn("leaf_payload", recursive["text"])
        self.assertIn("root_before", recursive["text"])
        self.assertNotIn("right_payload", recursive["text"])
        self.assertNotIn("other_payload", recursive["text"])
        self.assertEqual({r["name"] for r in recursive["foldedRegions"]}, {"right", "other"})
        self.assert_lossless(recursive)

    def test_leaf_expansion_opens_all_ancestors_without_siblings(self):
        for mode in ("single", "recursive"):
            with self.subTest(mode=mode):
                view = self.read(expand=["leaf"], expandMode=mode)
                self.assertIn("leaf_payload", view["text"])
                self.assertIn("left_before", view["text"])
                self.assertIn("root_before", view["text"])
                self.assertNotIn("right_payload", view["text"])
                self.assertNotIn("other_payload", view["text"])
                self.assert_lossless(view)

    def test_descriptions_and_marker_boundaries_survive_expansion(self):
        folded = self.read()
        self.assertIn("// 根区域说明：保留 Unicode ☃\n// @context-fold begin root\n", folded["text"])
        self.assertIn("// 独立区域说明\n// @context-fold begin other\n", folded["text"])
        self.assertNotIn("// 左侧说明保持原样", folded["text"])
        self.assertNotIn("// 叶子区域说明", folded["text"])
        self.assert_lossless(folded)
        for mode in ("single", "recursive"):
            view = self.read(expand=["left"], expandMode=mode)
            for description, marker in (("左侧说明保持原样", "left"), ("叶子区域说明", "leaf"), ("兄弟区域说明", "right")):
                self.assertIn(f"// {description}\n// @context-fold begin {marker}\n", view["text"])
                self.assertEqual(view["text"].count(f"// {description}\n"), 1)
            self.assert_lossless(view)

    def test_wildcard_multiple_targets_and_empty_selection(self):
        for mode in ("single", "recursive"):
            self.assertEqual(self.read(expand=["*"], expandMode=mode)["text"], self.source)
            self.assertEqual(self.read(expand=[], expandMode=mode)["text"], self.read()["text"])
        view = self.read(expand=["root", "left", "leaf"], expandMode="single")
        self.assertIn("leaf_payload", view["text"])
        self.assertNotIn("right_payload", view["text"])
        self.assert_lossless(view)

    def test_invalid_modes_and_unknown_selectors_are_atomic(self):
        before = self.client._db.execute("SELECT data FROM scopes WHERE scope='expand'").fetchone()
        for options in ({"expandMode": "all"}, {"expandMode": None}, {"expandMode": True},
                        {"expandMode": []}, {"expandMode": {}},
                        {"expand": ["unknown"], "expandMode": "single"},
                        {"expand": ["left", "unknown"], "expandMode": "recursive"},
                        {"expand": "left", "expandMode": "single"},
                        {"expand": [None], "expandMode": "recursive"},
                        {"expand": ["unknown"], "mode": "original", "expandMode": "single"}):
            with self.subTest(options=options), self.assertRaises(FoldingError) as raised:
                self.read(**options)
            self.assertEqual(raised.exception.code, "invalid_request")
            self.assertEqual(self.client._db.execute("SELECT data FROM scopes WHERE scope='expand'").fetchone(), before)

    def test_original_mode_and_persistent_keep_take_precedence(self):
        self.assertEqual(self.read(mode="original", expand=["left"], expandMode="single")["text"], self.source)
        self.client.annotate("expand", id=self.stored["id"], keep=["left"])
        view = self.read(expand=["root"], expandMode="single")
        self.assertIn("leaf_payload", view["text"])
        self.assertNotIn("right_payload", view["text"])
        self.assert_lossless(view)
        self.client.mark("expand", self.stored["id"], "keep")
        self.assertEqual(self.read(expand=["root"], expandMode="single")["text"], self.source)

    def test_line_endings_no_final_newline_and_raw_read_api(self):
        for newline in ("\n", "\r\n", "\r"):
            for trailing in (False, True):
                with self.subTest(newline=repr(newline), trailing=trailing):
                    source = source_document(newline, trailing)
                    stored = self.client.annotate("expand", text=source, language="explicit")
                    for mode in ("single", "recursive"):
                        view = self.client.read("expand", stored["id"], expand=["left"], expandMode=mode, limit=24000)
                        self.assertTrue(view["text"].endswith("tail();" + (newline if trailing else "")))
                        self.assertIn("// 左侧说明保持原样" + newline + "// @context-fold begin left" + newline, view["text"])
                        self.assert_lossless(view, source)
                        self.assertEqual(view["originalChars"], len(source))
                    self.assertEqual(self.client.read("expand", stored["id"], expand=["*"], expandMode="single")["text"], source)

    def test_many_levels_expand_without_touching_adjacent_region(self):
        depth = 80
        lines = []
        for level in range(depth):
            lines.extend((f"// @context-fold begin level{level}", f'padding_{level} = "' + "p" * 60 + '";'))
        lines.append('deepest_payload = "' + "d" * 80 + '";')
        lines.extend(f"// @context-fold end level{level}" for level in reversed(range(depth)))
        lines.extend(("// @context-fold begin adjacent", 'adjacent_payload = "' + "a" * 80 + '";',
                      "// @context-fold end adjacent"))
        source = "\n".join(lines)
        stored = self.client.annotate("expand", text=source, language="explicit")
        for mode in ("single", "recursive"):
            view = self.client.read_source("expand", id=stored["id"], expand=[f"level{depth - 1}"],
                                           expandMode=mode, limit=24000)
            self.assertIn("deepest_payload", view["text"])
            self.assertIn("padding_0", view["text"])
            self.assertNotIn("adjacent_payload", view["text"])
            self.assertIsNone(view["nextOffset"])
            self.assert_lossless(view, source)

    def test_expanded_view_pagination_uses_view_character_boundaries(self):
        options = {"expand": ["left"], "expandMode": "single"}
        full = self.read(**options)
        chunks, offset = [], 0
        while True:
            page = self.read(**options, offset=offset, limit=17)
            chunks.append(page["text"])
            self.assertEqual(page["totalChars"], len(full["text"]))
            self.assertEqual(page["offset"], offset)
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual("".join(chunks), full["text"])
        self.assertEqual(self.read(**options, offset=len(full["text"]))["text"], "")

    def test_batch_default_and_per_file_mode_override(self):
        batch = self.client.read_source("expand", expand=["left"], expandMode="single", files=[
            {"id": self.stored["id"]}, {"id": self.stored["id"], "expandMode": "recursive"}])
        self.assertNotIn("leaf_payload", batch["files"][0]["text"])
        self.assertIn("leaf_payload", batch["files"][1]["text"])
        for view in batch["files"]:
            self.assert_lossless(view)


if __name__ == "__main__":
    unittest.main()
