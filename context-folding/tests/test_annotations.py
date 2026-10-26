import re
import tempfile
import unittest
from pathlib import Path

from context_folding.annotations import fold_regions


class MemoryClient:
    """Minimal deterministic put/resolve contract for adapter tests."""
    def __init__(self):
        self.entries = {}
        self.calls = []

    def call(self, request):
        self.calls.append(request)
        if request["action"] == "put":
            identifier = f"entry-{len(self.entries) + 1}"
            self.entries[identifier] = request["text"]
            return {"id": identifier, "reference": f"[[cf:v1:{identifier}]]"}
        if request["action"] == "resolve":
            def replace(match):
                return self.entries[match.group(1)]
            return {"value": re.sub(r"\[\[cf:v1:([^]]+)\]\]", replace, request["value"])}
        raise AssertionError("unexpected request action")


def document(count=257, style="#", newline="\n", name="region", prefix="", suffix=""):
    def marker(operation):
        body = f"@context-fold {operation} {name}"
        if style == "/*":
            return f"/* {body} */{newline}"
        if style == "<!--":
            return f"<!-- {body} -->{newline}"
        return f"{style} {body}{newline}"
    return prefix + marker("begin") + "".join(f"原文 ☃ {index}{newline}" for index in range(count)) + marker("end") + suffix


class AnnotationTests(unittest.TestCase):
    def test_default_folds_only_strictly_more_than_256_lines(self):
        client = MemoryClient()
        for count in (0, 1, 255, 256):
            text = document(count)
            result = fold_regions(client, "scope", text)
            self.assertEqual(result["text"], text)
            self.assertEqual(result["references"], [])
            self.assertEqual(result["skipped"][0]["reason"], "below_threshold")
        self.assertEqual(client.calls, [])
        folded = fold_regions(client, "scope", document(257))
        self.assertEqual(len(folded["references"]), 1)
        self.assertEqual(folded["references"][0]["lines"], 257)
        self.assertEqual(client.calls[0]["scope"], "scope")
        self.assertNotIn("[[cf:v1:", client.calls[0]["text"])

    def test_styles_unicode_newlines_round_trip_and_boundaries(self):
        for style in ("//", "#", "--", ";", "/*", "<!--"):
            for newline in ("\n", "\r\n", "\r"):
                with self.subTest(style=style, newline=newline):
                    client = MemoryClient()
                    text = document(style=style, newline=newline, name="历史", prefix="prefix" + newline, suffix="suffix")
                    folded = fold_regions(client, "s", text)
                    self.assertEqual(len(folded["references"]), 1)
                    restored = client.call({"action": "resolve", "scope": "s", "value": folded["text"]})["value"]
                    self.assertEqual(restored, text)
                    self.assertIn("@context-fold begin 历史", folded["text"])
                    self.assertIn("@context-fold end 历史", folded["text"])
                    self.assertTrue(folded["text"].startswith("prefix" + newline))
                    self.assertTrue(folded["text"].endswith("suffix"))

    def test_multiple_regions_keep_short_and_surrounding_text(self):
        client = MemoryClient()
        text = document(2, name="short") + "between\n" + document(4, name="long") + document(5, name="last")
        folded = fold_regions(client, "s", text, min_lines=2)
        self.assertEqual([item["name"] for item in folded["references"]], ["long", "last"])
        self.assertEqual([item["name"] for item in folded["skipped"]], ["short"])
        self.assertIn(document(2, name="short") + "between\n", folded["text"])
        self.assertEqual(client.call({"action": "resolve", "value": folded["text"]})["value"], text)

    def test_malformed_input_is_unchanged_without_archive_writes(self):
        valid = document(3, name="valid")
        invalid = (
            "# @context-fold begin a\ntext\n",
            "# @context-fold end a\n",
            "# @context-fold begin a\ntext\n# @context-fold end b\n",
            "# @context-fold begin a\n# @context-fold begin b\n# @context-fold end b\n# @context-fold end a\n",
            "# @context-fold begin a\n// @context-fold end a\n",
            "# @context-fold begin\n",
            "# @context-fold end a extra\n",
        )
        for broken in invalid:
            with self.subTest(broken=broken):
                client = MemoryClient()
                text = valid + broken
                folded = fold_regions(client, "s", text, min_lines=0)
                self.assertEqual(folded["text"], text)
                self.assertEqual(folded["references"], [])
                self.assertTrue(folded["skipped"])
                self.assertEqual(client.calls, [])

    def test_inline_markers_strings_and_unmarked_functions_unchanged(self):
        text = 'def f():\n    return "# @context-fold begin a"\n' + "\n" * 300
        text += 'statement() # @context-fold begin a\nstatement() # @context-fold end a\n'
        client = MemoryClient()
        self.assertEqual(fold_regions(client, "s", text)["text"], text)
        self.assertEqual(client.calls, [])

    def test_python_multiline_string_markers_do_not_archive(self):
        text = 'value = """\n' + document(3) + '"""\n'
        client = MemoryClient()
        folded = fold_regions(client, "s", text, language="python", min_lines=0)
        self.assertEqual(folded["text"], text)
        self.assertEqual(folded["references"], [])
        self.assertEqual(client.calls, [])
        real = document(3)
        self.assertEqual(len(fold_regions(client, "s", real, language="py", min_lines=0)["references"]), 1)

    def test_real_engine_round_trip(self):
        from context_folding.core import Client
        with tempfile.TemporaryDirectory() as directory:
            with Client(Path(directory) / "state.sqlite") as client:
                text = document(257, style="//", newline="\r\n", prefix="before\r\n", suffix="after")
                folded = fold_regions(client, "real-engine", text)
                self.assertEqual(len(folded["references"]), 1)
                restored = client.call({"action": "resolve", "scope": "real-engine", "value": folded["text"]})
                self.assertEqual(restored["value"], text)

    def test_validation_and_invalid_python_tokens(self):
        client = MemoryClient()
        for threshold in (-1, True, 1.5):
            with self.assertRaises(ValueError):
                fold_regions(client, "s", "", min_lines=threshold)
        text = 'value = """unterminated\n' + document(3)
        self.assertEqual(fold_regions(client, "s", text, language="python", min_lines=0)["text"], text)
        self.assertEqual(client.calls, [])


class SourceIntegrationTests(unittest.TestCase):
    SOURCE = ('@decorator\r\nasync def outer(value):\r\n'
              '    def inner():\r\n' + ''.join(f'        value_{n} = "原文 ☃ {n}"\r\n' for n in range(12)) +
              '        return value_0\r\n'
              '    if value:\r\n' + ''.join(f'        branch_{n} = {n}\r\n' for n in range(12)) +
              '    return inner()\r\n'
              'def other():\r\n' + ''.join(f'    item_{n} = {n}\r\n' for n in range(12)) + '    return item_0')

    def setUp(self):
        from context_folding import Client
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.client = Client(Path(self.directory.name) / "state.sqlite")
        self.addCleanup(self.client.close)

    def test_automatic_annotation_default_read_exact_recovery_and_expansion(self):
        result = self.client.annotate("s", text=self.SOURCE, language="python")
        self.assertEqual(result["parser"], "python-ast")
        self.assertEqual({r["name"] for r in result["regions"]}, {"outer", "outer.inner", "outer.if@17", "other"})
        view = self.client.read("s", result["id"])
        self.assertLess(len(view["text"]), len(self.SOURCE))
        self.assertEqual(view["mode"], "folded")
        self.assertIn('@decorator\r\nasync def outer(value):\r\n', view["text"])
        self.assertEqual(self.client.resolve("s", view["text"])["value"], self.SOURCE)
        self.assertEqual(self.client.read("s", result["id"], mode="original")["text"], self.SOURCE)
        child = self.client.read("s", result["id"], expand=["outer.inner"])
        self.assertIn('value_11', child["text"])
        self.assertNotIn('branch_11', child["text"])
        all_expanded = self.client.read("s", result["id"], expand=["*"])
        self.assertEqual(all_expanded["text"], self.SOURCE)
        destination = Path(self.directory.name) / "restored.py"
        self.client.call({"action": "paste", "scope": "s", "id": result["id"], "path": str(destination)})
        self.assertEqual(destination.read_bytes(), self.SOURCE.encode())

    def test_python_physical_lines_and_decorated_first_child(self):
        for newline in ("\n", "\r\n", "\r"):
            with self.subTest(newline=repr(newline)):
                source = newline.join([
                    'banner = "separator and\u0085text"',
                    'def outer():', '    @decorator', '    def inner():',
                    *[f'        item_{n} = {n}' for n in range(20)],
                    '        return item_0', '    return inner()',
                ])
                stored = self.client.annotate("s", text=source, language="python")
                outer = next(r for r in stored["regions"] if r["name"] == "outer")
                self.assertEqual(outer["startLine"], 3)
                view = self.client.read("s", stored["id"])
                self.assertNotIn('@decorator', view["text"])
                self.assertIn('banner = "separator and\u0085text"' + newline + 'def outer():' + newline, view["text"])
                self.assertEqual(self.client.resolve("s", view["text"])["value"], source)
                expanded = self.client.read("s", stored["id"], expand=["outer.inner"])
                self.assertEqual(expanded["text"], source)

    def test_keep_overrides_persist_reannotation_and_raw_mark(self):
        stored = self.client.annotate("s", text=self.SOURCE, language="py", keep=["outer.inner"])
        reread = self.client.read_source("s", id=stored["id"])
        self.assertIn("value_11", reread["text"])
        self.assertNotIn("item_11", reread["text"])
        repeated = self.client.annotate("s", text=self.SOURCE, language="python")
        self.assertEqual(next(r for r in repeated["regions"] if r["name"] == "outer.inner")["disposition"], "keep")
        self.client.annotate("s", id=stored["id"], marks=[{"name": "outer.inner", "disposition": "foldable"}])
        self.assertNotIn("value_11", self.client.read("s", stored["id"])["text"])
        self.client.mark("s", stored["id"], "keep")
        self.assertEqual(self.client.read("s", stored["id"])["text"], self.SOURCE)

    def test_paths_read_only_atomic_batch_and_schema(self):
        from context_folding import FoldingError
        from context_folding.cli import TOOL_SCHEMA
        import json
        path = Path(self.directory.name) / "source.py"
        path.write_bytes(self.SOURCE.encode())
        batch = self.client.read_source("s", files=[{"path": str(path)}, {"text": "const x = 1;", "language": "javascript"}])
        self.assertEqual(batch["files"][0]["parser"], "python-ast")
        self.assertEqual(batch["files"][1]["parser"], "explicit-regions")
        self.assertTrue(batch["files"][1]["limitations"])
        self.assertEqual(path.read_bytes(), self.SOURCE.encode())
        before = self.client.call({"action": "status", "scope": "s"})
        for options in (
            {"files": [{"text": "def fresh():\n    return 10\n", "language": "py"}, {"text": "def broken(:", "language": "py"}]},
            {"text": self.SOURCE, "language": "py", "keep": ["does-not-exist"]},
            {"text": self.SOURCE, "language": "py", "expand": ["does-not-exist"]},
        ):
            with self.assertRaises(FoldingError):
                self.client.read_source("s", **options)
            self.assertEqual(self.client.call({"action": "status", "scope": "s"}), before)
        schema = json.loads((Path(__file__).parents[1] / "protocol.json").read_text())
        self.assertEqual(schema["properties"], TOOL_SCHEMA["properties"])

    def test_explicit_fallback_invalid_markers_and_python_string_safety(self):
        from context_folding import FoldingError
        source = 'const banner = "header";\n' + document(8, style="//") + 'tail();'
        view = self.client.read_source("s", text=source, language="typescript")
        self.assertEqual(self.client.resolve("s", view["text"])["value"], source)
        self.assertNotIn("原文", view["text"])
        with self.assertRaises(FoldingError):
            self.client.annotate("s", text=source + "\n// @context-fold end missing", language="typescript")
        py = 'value = """\n' + document(8) + '"""\n'
        result = self.client.annotate("s", text=py, language="python")
        self.assertEqual(result["regions"], [])

    def test_annotation_configuration_and_explicit_overrides(self):
        from context_folding import Client
        with Client(Path(self.directory.name) / "configured.sqlite", config={"annotations": {
                "keep": ["outer.in*", "missing.*"]}}) as client:
            stored = client.annotate("s", text=self.SOURCE, language="py")
            view = client.read("s", stored["id"])
            self.assertIn("value_11", view["text"])
            self.assertNotIn("branch_11", view["text"])
            client.annotate("s", id=stored["id"], marks=[{"name": "outer.inner", "disposition": "foldable"}])
            self.assertNotIn("value_11", client.read("s", stored["id"])["text"])
            client.annotate("s", id=stored["id"], keep=["other"])
            self.assertIn("item_11", client.read("s", stored["id"])["text"])
        with Client(Path(self.directory.name) / "original.sqlite", config={"annotations": {
                "default_fold": False}}) as client:
            stored = client.annotate("s", text=self.SOURCE, language="python")
            self.assertEqual(client.read("s", stored["id"])["text"], self.SOURCE)
            self.assertNotIn("value_11", client.read("s", stored["id"], mode="folded")["text"])
        with Client(Path(self.directory.name) / "disabled.sqlite", config={"annotations": {
                "enabled": False}}) as client:
            view = client.read_source("s", text=self.SOURCE, language="python")
            self.assertEqual(view["text"], self.SOURCE)
            stored = client.annotate("s", text=self.SOURCE, language="python")
            self.assertTrue(stored["regions"])
            self.assertEqual(client.read("s", stored["id"])["text"], self.SOURCE)
            self.assertNotIn("value_11", client.read("s", stored["id"], mode="folded")["text"])

    def test_config_errors_precede_storage_and_gc_defaults_are_temporary(self):
        from context_folding import Client, FoldingError
        invalid_state = Path(self.directory.name) / "must-not-exist" / "state.sqlite"
        with self.assertRaises(FoldingError) as error:
            Client(invalid_state, config={"annotations": {"default_fold": "yes"}})
        self.assertEqual(error.exception.code, "config")
        self.assertFalse(invalid_state.parent.exists())
        state = Path(self.directory.name) / "gc.sqlite"
        with Client(state, config={"gc": {"enabled": True, "strength": "aggressive",
                "idle_seconds": 0, "max_uses": 10000}}) as client:
            stored = client.put("s", "historical payload")
            client.call({"action": "roots", "scope": "s", "ids": []})
            client.call({"action": "status", "scope": "s"})
            status = client.call({"action": "gc", "scope": "s", "mode": "status"})
            self.assertEqual(status["config"]["strength"], "aggressive")
            snapshot = __import__("json").loads(client._db.execute("SELECT data FROM scopes WHERE scope='s'").fetchone()[0])
            self.assertNotIn("gc", snapshot["config"])
            self.assertEqual(snapshot["entries"][0]["id"], stored["id"])
            self.assertIsNotNone(snapshot["entries"][0].get("trashedAt"))
            client.call({"action": "gc", "scope": "s", "mode": "configure", "config": {"strength": "off"}})
            self.assertEqual(client.call({"action": "gc", "scope": "s", "mode": "status"})["config"]["strength"], "off")
        with Client(state) as client:
            self.assertEqual(client.call({"action": "gc", "scope": "s", "mode": "status"})["config"]["strength"], "off")

    def test_annotation_dependencies_survive_collection_and_original_pagination(self):
        stored = self.client.annotate("s", text=self.SOURCE, language="python")
        view = self.client.read("s", stored["id"])
        self.client.call({"action": "roots", "scope": "s", "ids": [stored["id"]]})
        self.client.call({"action": "gc", "scope": "s", "mode": "configure", "config": {"strength": "aggressive", "idleSeconds": 0, "maxUses": 10000}})
        self.client.call({"action": "gc", "scope": "s", "mode": "collect"})
        self.assertEqual(self.client.resolve("s", view["text"])["value"], self.SOURCE)
        parts, offset = [], 0
        while True:
            page = self.client.read("s", stored["id"], mode="original", offset=offset, limit=33)
            parts.append(page["text"])
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual("".join(parts), self.SOURCE)


if __name__ == "__main__":
    unittest.main()
