import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from context_folding.annotations import discover_source, fold_regions


BUILTIN_STYLES = (
    "//", "#", "--", ";", "%", "!", "'", '"', "REM",
    ("/*", "*/"), ("<!--", "-->"), ("(*", "*)"), ("{-", "-}"),
    ("#|", "|#"), ("<#", "#>"),
)
CUSTOM_STYLES = [{"start": ";;"}, {"start": "(*!", "end": "!*)"}]
INVALID_STYLES = (
    None, {}, "//", ["//"], [{}], [{"start": ""}], [{"start": 1}],
    [{"start": " x"}], [{"start": "x "}], [{"start": "x\ny"}],
    [{"start": "x\ry"}], [{"start": "x\x00y"}], [{"start": "x" * 65}],
    [{"start": "x", "end": None}], [{"start": "x", "end": 1}],
    [{"start": "x", "end": " y"}], [{"start": "x", "end": "y\n"}],
    [{"start": "x", "end": "y\x00"}], [{"start": "x", "end": "y" * 65}],
    [{"start": "x", "regex": True}], [{"start": "x"}] * 33,
)


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
        if style in ("/*", "<!--"):
            start, end = ("/*", "*/") if style == "/*" else ("<!--", "-->")
        elif isinstance(style, tuple):
            start, end = style
        else:
            start, end = style, ""
        return f"{start} {body}{' ' + end if end else ''}{newline}"
    return prefix + marker("begin") + "".join(f"原文 ☃ {index}{newline}" for index in range(count)) + marker("end") + suffix


class AnnotationTests(unittest.TestCase):
    def test_function_marker_generation_nested_and_idempotent(self):
        from context_folding.annotations import annotate_python_functions
        source = '@decorator\r\nasync def outer():\r\n    def inner():\r\n        return 1\r\n    return inner()'
        marked = annotate_python_functions(source)
        self.assertEqual(len(marked["added"]), 2)
        self.assertIn("# @context-fold begin outer.inner\r\n", marked["text"])
        self.assertEqual(annotate_python_functions(marked["text"])["text"], marked["text"])
        parsed = discover_source(marked["text"], "python")
        self.assertEqual({item["name"] for item in parsed["regions"]}, {"outer", "outer.inner"})
        self.assertEqual(ast.dump(ast.parse(marked["text"])), ast.dump(ast.parse(source)))
        restored = marked["text"]
        for marker in ("# @context-fold begin outer\r\n",
                       "    # @context-fold begin outer.inner\r\n",
                       "    # @context-fold end outer.inner\r\n",
                       "\r\n# @context-fold end outer"):
            self.assertEqual(restored.count(marker), 1)
            restored = restored.replace(marker, "", 1)
        self.assertEqual(restored, source)

    def test_function_marker_boundaries_and_newlines(self):
        from context_folding.annotations import annotate_python_functions
        sources = [
            "def outer():\n    def z():\n        def a():\n            return 1",
            "def first(): return 1\ndef second(): return 2\n",
            "@(\n    decorator\n)\ndef work():\n    return 1\n",
            "def outer():\n    @(\n        decorator\n    )\n    def inner(): return 1\n",
            "class A:\n\t@decorate\n\tasync def work(self):\n\t\treturn 1\nclass B:\n\tdef work(self): return 2",
            "if True:\n    def work():\n        return '''line\n# @context-fold begin fake\n'''\n",
            "def work():\n    return (\n        1\n    ) # trailing comment\n\n# footer\n",
            "def outer():\n    # @context-fold begin outer.inner\n    def inner(): return 1\n    # @context-fold end outer.inner\n",
            "# preamble\nvalue = 1\n",
            "",
        ]
        for source in sources:
            for newline in ("\n", "\r\n", "\r"):
                for final_newline in (False, True):
                    original = source.rstrip("\n") + ("\n" if final_newline else "")
                    original = original.replace("\n", newline)
                    with self.subTest(source=source, newline=newline, final=final_newline):
                        marked = annotate_python_functions(original)["text"]
                        self.assertEqual(ast.dump(ast.parse(marked)), ast.dump(ast.parse(original)))
                        self.assertEqual(marked.endswith(("\r", "\n")), original.endswith(("\r", "\n")))
                        self.assertEqual(annotate_python_functions(marked)["text"], marked)
                        self.assertEqual(annotate_python_functions(marked)["added"], [])
                        discover_source(marked, "python")
                        if newline == "\r\n":
                            self.assertNotIn("\n", marked.replace("\r\n", ""))
        marked = annotate_python_functions(sources[0])["text"]
        self.assertLess(marked.index("end outer.z.a"), marked.index("end outer.z\n"))
        self.assertTrue(marked.endswith("end outer"))

    def test_one_line_functions_are_not_automatically_marked_or_discovered(self):
        from context_folding.annotations import annotate_python_functions
        sources = [
            "def work(): return 1\n",
            "async def work(): return 1; return 2\n",
            "@decorator\ndef work(): return 1\n",
            "@(\n    decorator\n)\ndef work(): return 1\n",
            "class Worker:\n    def work(self): return 1\n",
            "def outer():\n    def inner(): return 1\n    return inner()\n",
        ]
        for source in sources:
            for newline in ("\n", "\r\n", "\r"):
                original = source.replace("\n", newline)
                with self.subTest(source=source, newline=newline):
                    result = annotate_python_functions(original)
                    functions = [region for region in discover_source(original, "python")["regions"]
                                 if region["kind"] in {"FunctionDef", "AsyncFunctionDef"}]
                    expected = ["outer"] if "def outer" in source else []
                    self.assertEqual([region["name"] for region in functions], expected)
                    self.assertEqual([region["name"] for region in result["added"]], expected)
                    if not expected:
                        self.assertEqual(result["text"], original)
                    else:
                        self.assertNotIn("@context-fold begin outer.inner", result["text"])
                    self.assertEqual(ast.dump(ast.parse(original)), ast.dump(ast.parse(result["text"])))
                    self.assertEqual(annotate_python_functions(result["text"])["text"], result["text"])
        explicit = "# @context-fold begin chosen\ndef work(): return 1\n# @context-fold end chosen\n"
        self.assertEqual(annotate_python_functions(explicit)["text"], explicit)
        regions = discover_source(explicit, "python")["regions"]
        self.assertEqual([(region["name"], region["kind"]) for region in regions], [("chosen", "explicit")])
        from context_folding.cli import _annotate_functions
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "single.py"
            original = sources[0].encode()
            path.write_bytes(original)
            result = _annotate_functions(str(path), "python", True)
            self.assertFalse(result["applied"])
            self.assertEqual(result["added"], [])
            self.assertEqual(path.read_bytes(), original)

    def test_function_marker_rejects_invalid_source_and_markers(self):
        from context_folding.annotations import annotate_python_functions
        for source in ("def broken(:\n", "# @context-fold begin missing\ndef work(): pass\n",
                       "# @context-fold wat x\ndef work(): pass\n"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                annotate_python_functions(source)

    def test_function_marker_real_cli(self):
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "python"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            original = b"def work():\r\n    return 3"
            path.write_bytes(original)
            path.chmod(0o640)
            command = [sys.executable, "-m", "context_folding", "annotate-functions", str(path)]
            preview = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            result = json.loads(preview.stdout)["result"]
            self.assertFalse(result["applied"])
            self.assertEqual(path.read_bytes(), original)
            applied = subprocess.run(command + ["--apply"], env=environment, capture_output=True, text=True)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertTrue(json.loads(applied.stdout)["result"]["applied"])
            self.assertEqual(path.read_bytes(), result["text"].encode())
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            repeated = subprocess.run(command + ["--apply"], env=environment, capture_output=True, text=True)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            self.assertFalse(json.loads(repeated.stdout)["result"]["applied"])
            rejected = subprocess.run(command + ["--language", "javascript", "--apply"], env=environment, capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 1)
            self.assertEqual(json.loads(rejected.stdout)["error"]["code"], "annotation_failed")
            self.assertEqual(path.read_bytes(), result["text"].encode())

    def test_function_marker_cli_preview_apply_and_language_rejection(self):
        from context_folding.cli import _annotate_functions
        from context_folding.annotations import annotate_python_functions
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            original = b"def work():\n    return 3"
            path.write_bytes(original)
            preview = _annotate_functions(str(path), "python", False)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(preview["applied"])
            applied = _annotate_functions(str(path), "py", True)
            self.assertTrue(applied["applied"])
            self.assertEqual(path.read_text(), annotate_python_functions(original.decode())["text"])
            self.assertFalse(_annotate_functions(str(path), "python", True)["applied"])
            with self.assertRaisesRegex(ValueError, "supports Python"):
                _annotate_functions(str(path), "ruby", True)

    def test_function_marker_rejects_concurrent_changes(self):
        from unittest.mock import patch
        from context_folding import cli
        original = b"def work():\n    return 3\n"
        for stage in ("annotation", "write"):
            for change in ("content", "identity", "symlink"):
                with self.subTest(stage=stage, change=change), tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "source.py"
                    path.write_bytes(original)

                    def mutate():
                        if change == "content":
                            path.write_bytes(b"def changed():\n    return 4\n")
                        else:
                            replacement = Path(directory) / "replacement.py"
                            replacement.write_bytes(original)
                            path.unlink()
                            if change == "symlink":
                                path.symlink_to(replacement)
                            else:
                                replacement.rename(path)

                    if stage == "annotation":
                        real = cli.annotate_python_functions
                        def intercept(text):
                            result = real(text)
                            mutate()
                            return result
                        mocked = patch.object(cli, "annotate_python_functions", side_effect=intercept)
                    else:
                        real = cli.os.fchmod
                        def intercept(*args, **kwargs):
                            real(*args, **kwargs)
                            mutate()
                        mocked = patch.object(cli.os, "fchmod", side_effect=intercept)
                    with mocked, self.assertRaisesRegex(ValueError, "changed during annotation"):
                        cli._annotate_functions(str(path), "python", True)
                    self.assertEqual(path.read_bytes(), b"def changed():\n    return 4\n" if change == "content" else original)
                    self.assertEqual(list(Path(directory).glob(".source.py.*")), [])

    def test_project_function_markers_real_cli(self):
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "python"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = {
                "a.py": b"@decorate\r\nasync def work():\r\n    return 3",
                "pkg/types.pyi": b"def stub(): ...\n",
                "pkg/b.py": b"class A:\n    def work(self):\n        return 1\n",
                "single.py": b"@decorate\ndef one(): return 1\n",
                "ignored.py": b"def invalid(:\n",
                ".venv/bad.py": b"invalid python!",
                ".git/bad.py": b"invalid python!",
                "node_modules/bad.py": b"invalid python!",
                "build/bad.py": b"invalid python!",
                "skip/bad.py": b"invalid python!",
                "notes.txt": b"def invalid(:\n",
            }
            for name, content in sources.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o640)
            (root / "alias.py").symlink_to(root / "a.py")
            (root / "linked").symlink_to(root / "pkg", target_is_directory=True)
            command = [sys.executable, "-m", "context_folding", "annotate-functions", str(root),
                       "--exclude", "ignored.py", "--exclude", "skip"]
            preview = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            result = json.loads(preview.stdout)["result"]
            self.assertEqual(result["changedFiles"], 2)
            self.assertFalse(result["applied"])
            self.assertEqual([Path(item["path"]).relative_to(root).as_posix() for item in result["files"]],
                             ["a.py", "single.py", "pkg/b.py", "pkg/types.pyi"])
            for name, content in sources.items():
                self.assertEqual((root / name).read_bytes(), content)
            applied = subprocess.run(command + ["--apply"], env=environment, capture_output=True, text=True)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertTrue(json.loads(applied.stdout)["result"]["applied"])
            for item in result["files"]:
                path = Path(item["path"])
                self.assertEqual(path.read_bytes(), item["text"].encode())
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                self.assertEqual(ast.dump(ast.parse(path.read_bytes())),
                                 ast.dump(ast.parse(sources[path.relative_to(root).as_posix()])))
            self.assertTrue((root / "alias.py").is_symlink())
            for name in set(sources) - {"a.py", "pkg/b.py"}:
                self.assertEqual((root / name).read_bytes(), sources[name])
            repeated = subprocess.run(command + ["--apply"], env=environment, capture_output=True, text=True)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            self.assertEqual(json.loads(repeated.stdout)["result"]["changedFiles"], 0)

    def test_project_annotation_preflight_rejects_without_writes(self):
        from context_folding import cli
        from unittest.mock import patch
        original = b"def good():\n    return 1\n"
        for bad in (b"def invalid(:\n", b"# @context-fold begin missing\n", b"\xff"):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "a.py").write_bytes(original)
                (root / "z.py").write_bytes(bad)
                with self.assertRaises((ValueError, UnicodeError)):
                    cli._annotate_project(directory, "python", True, [])
                self.assertEqual((root / "a.py").read_bytes(), original)
                self.assertEqual((root / "z.py").read_bytes(), bad)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "a.py"
            path.write_bytes(original)
            (root / "z.py").write_bytes(original)
            real = cli.annotate_python_functions
            calls = 0
            def intercept(text):
                nonlocal calls
                calls += 1
                if calls == 2:
                    path.write_bytes(b"# concurrent edit\n")
                return real(text)
            with patch.object(cli, "annotate_python_functions", side_effect=intercept):
                with self.assertRaisesRegex(ValueError, "changed during annotation"):
                    cli._annotate_project(directory, "python", True, [])
            self.assertEqual(path.read_bytes(), b"# concurrent edit\n")
            self.assertEqual((root / "z.py").read_bytes(), original)

    def test_project_annotation_rejects_links_limits_and_invalid_options(self):
        from context_folding import cli
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "a.py"
            original = b"def good():\n    return 1\n"
            path.write_bytes(original)
            os.link(path, root / "hard.py")
            with self.assertRaisesRegex(ValueError, "hard links"):
                cli._annotate_project(directory, "python", True, [])
            (root / "hard.py").unlink()
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "non-symlink directory"):
                cli._annotate_project(str(alias), "python", True, [])
            for exclusions in ([""], ["/absolute"], ["../outside"]):
                with self.assertRaises(ValueError):
                    cli._annotate_project(directory, "python", True, exclusions)
            with self.assertRaisesRegex(ValueError, "supports Python"):
                cli._annotate_project(directory, "ruby", True, [])
            with patch.object(cli, "MAX_INPUT_BYTES", 2):
                with self.assertRaisesRegex(ValueError, "8 MiB"):
                    cli._annotate_project(directory, "python", True, [])
            self.assertEqual(path.read_bytes(), original)

    def test_project_annotation_rejects_swapped_parent_and_cleans_temporary(self):
        from context_folding import cli
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / "pkg"
            parent.mkdir()
            path = parent / "a.py"
            original = b"def good():\n    return 1\n"
            path.write_bytes(original)
            real = cli.os.fchmod
            def intercept(*args, **kwargs):
                real(*args, **kwargs)
                parent.rename(root / "moved")
                parent.symlink_to(root / "moved", target_is_directory=True)
            with patch.object(cli.os, "fchmod", side_effect=intercept):
                with self.assertRaisesRegex(ValueError, "changed during annotation"):
                    cli._annotate_project(directory, "python", True, [])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list((root / "moved").glob(".a.py.*")), [])

    def test_project_annotation_final_replace_cannot_follow_swapped_parent(self):
        from context_folding import cli
        from unittest.mock import patch
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                parent, outside = root / "pkg", root / "outside"
                parent.mkdir()
                outside.mkdir()
                original = b"def good():\n    return 1\n"
                (parent / "a.py").write_bytes(original)
                sentinel = b"# outside must survive\n"
                (outside / "a.py").write_bytes(sentinel)
                real = cli.os.replace
                def intercept(source, destination, **kwargs):
                    self.assertIsInstance(kwargs["src_dir_fd"], int)
                    self.assertEqual(kwargs["src_dir_fd"], kwargs["dst_dir_fd"])
                    parent.rename(root / "moved")
                    parent.symlink_to(outside, target_is_directory=True)
                    # Plant the same temporary basename outside: path-based
                    # replacement would overwrite the sentinel with this file.
                    (outside / source).write_bytes(b"# attacker\n")
                    if fail:
                        raise OSError("injected replacement failure")
                    real(source, destination, **kwargs)
                with patch.object(cli.os, "replace", side_effect=intercept):
                    if fail:
                        with self.assertRaises(OSError):
                            cli._annotate_project(str(parent), "python", True, [])
                    else:
                        cli._annotate_project(str(parent), "python", True, [])
                self.assertEqual((outside / "a.py").read_bytes(), sentinel)
                self.assertEqual(list((root / "moved").glob(".a.py.*")), [])
                content = (root / "moved" / "a.py").read_bytes()
                self.assertEqual(content == original, fail)
                if not fail:
                    self.assertIn(b"@context-fold begin good", content)

    def test_annotation_output_limit_and_bounded_verification(self):
        from context_folding import cli
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "a.py"
            original = b"def good():\n    return 1\n"
            path.write_bytes(original)
            with patch.object(cli, "MAX_INPUT_BYTES", len(original)):
                with self.assertRaisesRegex(ValueError, "Annotated source exceeds"):
                    cli._annotate_functions(str(path), "python", True)
            self.assertEqual(path.read_bytes(), original)
            plan = cli._annotation_plan(str(path), "python")
            # A replaced Path.read_bytes implementation must never be used by
            # verification; it reads at most MAX_INPUT_BYTES + 1 through an fd.
            with patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
                cli._verify_annotation(plan)
            path.write_bytes(original + b"# concurrent growth\n")
            with self.assertRaisesRegex(ValueError, "changed during annotation"):
                cli._verify_annotation(plan)

    def test_nested_regions_are_supported_and_crossing_regions_rejected(self):
        source = ('# @context-fold begin outer\ndef outer():\n'
                  '    # @context-fold begin outer.inner\n'
                  '    def inner(): return 1\n'
                  '    # @context-fold end outer.inner\n'
                  '    return inner()\n# @context-fold end outer\n')
        result = discover_source(source, "python")
        self.assertEqual({region["name"] for region in result["regions"]}, {"outer", "outer.inner"})
        crossing = '# @context-fold begin a\n# @context-fold begin b\npass\n# @context-fold end a\n# @context-fold end b\n'
        with self.assertRaisesRegex(ValueError, "Unmatched"):
            discover_source(crossing, "python")

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
        for style in BUILTIN_STYLES:
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

    def test_custom_literal_styles_additive_and_exact_round_trip(self):
        styles = CUSTOM_STYLES + [{"start": ".*[", "end": "]+$"}]
        for style in (";;", ("(*!", "!*)"), (".*[", "]+$")):
            with self.subTest(style=style):
                client = MemoryClient()
                text = document(8, style=style, newline="\r\n", name="历史🙂").removesuffix("\r\n")
                text += "\r\n" + document(8, style="#", newline="\r\n").removesuffix("\r\n")
                folded = fold_regions(client, "s", text, min_lines=0, commentStyles=styles)
                self.assertEqual(len(folded["references"]), 2)
                self.assertEqual(client.call({"action": "resolve", "value": folded["text"]})["value"], text)
                self.assertFalse(folded["text"].endswith("\n"))

    def test_unicode_separators_do_not_create_physical_marker_lines(self):
        source = '# @context-fold begin real\r\n' + 'pass\r\n' * 8 + '# @context-fold end real'
        source += '\r\nvalue = "separator # @context-fold begin fake\u0085text"'
        client = MemoryClient()
        folded = fold_regions(client, "s", source, language="python", min_lines=0)
        self.assertEqual(len(folded["references"]), 1)
        self.assertEqual(folded["references"][0]["lines"], 8)
        self.assertEqual(client.call({"action": "resolve", "value": folded["text"]})["value"], source)

    def test_complete_delimiters_must_match_and_invalid_styles_never_write(self):
        client = MemoryClient()
        text = document(8, style=("(*!", "!*)"))
        mismatched = text.replace("(*! @context-fold end region !*)", "(* @context-fold end region *)")
        result = fold_regions(client, "s", mismatched, min_lines=0, commentStyles=CUSTOM_STYLES)
        self.assertEqual(result["text"], mismatched)
        self.assertEqual(result["skipped"][0]["reason"], "mismatched_end")
        same_start = '%% @context-fold begin region !!\n' + 'payload\n' * 8 + '%% @context-fold end region ??\n'
        paired = [{"start": "%%", "end": "!!"}, {"start": "%%", "end": "??"}]
        self.assertEqual(fold_regions(client, "s", same_start, min_lines=0,
                                     commentStyles=paired)["skipped"][0]["reason"], "mismatched_end")
        with self.assertRaises(ValueError):
            discover_source(same_start, styles=paired)
        incomplete = text.replace("(*! @context-fold end region !*)", "(*! @context-fold end region")
        self.assertEqual(fold_regions(client, "s", incomplete, min_lines=0,
                                     commentStyles=CUSTOM_STYLES)["text"], incomplete)
        for styles in INVALID_STYLES:
            if styles is None:  # None retains the adapter's optional default.
                continue
            with self.subTest(styles=styles), self.assertRaises(ValueError):
                fold_regions(client, "s", text, min_lines=0, commentStyles=styles)
        self.assertEqual(client.calls, [])

    def test_python_custom_styles_cannot_bypass_tokenizer(self):
        text = 'value = """\n' + document(8, style=";;") + document(8) + '"""\n'
        client = MemoryClient()
        self.assertEqual(fold_regions(client, "s", text, language="python", min_lines=0,
                                     commentStyles=CUSTOM_STYLES)["text"], text)
        # A custom # prefix remains part of a Python comment, but is not the
        # supported whole-line # marker syntax.
        text += '## @context-fold begin custom\n' + 'pass\n' * 8 + '## @context-fold end custom\n'
        self.assertEqual(discover_source(text, "python", styles=[{"start": "##"}])["regions"], [])
        self.assertEqual(client.calls, [])

    def test_python_builtin_markers_survive_conflicting_custom_delimiters(self):
        source = '# @context-fold begin box\r\n' + 'pass\r\n' * 12 + '# @context-fold end box'
        styles = [{"start": "#", "end": "x"}, {"start": "##"}]
        baseline = discover_source(source, "python")
        discovered = discover_source(source, "python", styles=styles)
        self.assertEqual(discovered["regions"], baseline["regions"])
        self.assertEqual([r["name"] for r in discovered["regions"]], ["box"])
        client = MemoryClient()
        folded = fold_regions(client, "s", source, language="py", min_lines=0, commentStyles=styles)
        self.assertEqual([r["name"] for r in folded["references"]], ["box"])
        self.assertEqual(client.call({"action": "resolve", "value": folded["text"]})["value"], source)
        quoted = 'value = """\n' + source + '\n"""\n'
        self.assertEqual(discover_source(quoted, "python", styles=styles)["regions"], [])
        self.assertEqual(fold_regions(client, "s", quoted, language="python", min_lines=0,
                                     commentStyles=styles)["references"], [])

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
        from context_folding.cli import TOOL_SCHEMA, _parser, _request
        import json
        path = Path(self.directory.name) / "source.py"
        path.write_bytes(self.SOURCE.encode())
        batch = self.client.read_source("s", files=[{"path": str(path)}, {"text": "const x = 1;", "language": "explicit"}])
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
        parsed = _parser().parse_args(["read", "--scope", "s", "--state", "state.sqlite", "--expand-mode", "single"])
        self.assertEqual(_request(parsed)["expandMode"], "single")
        parsed = _parser().parse_args(["read", "--scope", "s", "--state", "state.sqlite", "--expand-mode", "recursive"])
        self.assertEqual(_request(parsed)["expandMode"], "recursive")

    def test_explicit_fallback_invalid_markers_and_python_string_safety(self):
        from context_folding import FoldingError
        source = 'const banner = "header";\n' + document(8, style="//") + 'tail();'
        view = self.client.read_source("s", text=source, language="explicit")
        self.assertEqual(self.client.resolve("s", view["text"])["value"], source)
        self.assertNotIn("原文", view["text"])
        with self.assertRaises(FoldingError):
            self.client.annotate("s", text=source + "\n// @context-fold end missing", language="explicit")
        py = 'value = """\n' + document(8) + '"""\n'
        result = self.client.annotate("s", text=py, language="python")
        self.assertEqual(result["regions"], [])

    def test_builtin_and_custom_source_styles_exact_round_trip(self):
        for style in BUILTIN_STYLES + (";;", ("(*!", "!*)")):
            with self.subTest(style=style):
                source = document(12, style=style, newline="\r\n", name="历史🙂",
                                  prefix='before\r\n').removesuffix("\r\n")
                result = self.client.annotate("styles", text=source, language="explicit", commentStyles=CUSTOM_STYLES)
                self.assertEqual(len(result["regions"]), 1)
                self.assertEqual(result["parser"], "explicit-regions")
                self.assertTrue(any("multiline strings" in item for item in result["limitations"]))
                view = self.client.read_source("styles", id=result["id"])
                reused = self.client.annotate("styles", id=result["id"])
                self.assertEqual(reused["commentStyles"], [{"start": ";;", "end": ""}, CUSTOM_STYLES[1]])
                self.assertNotIn("原文", view["text"])
                self.assertEqual(self.client.resolve("styles", view["text"])["value"].encode(), source.encode())
                self.assertEqual(self.client.read("styles", result["id"], mode="original")["text"], source)
                self.assertFalse(view["text"].endswith("\n"))

    def test_batch_comment_defaults_overrides_metadata_and_rollback(self):
        from context_folding import FoldingError
        first = document(12, style=";;")
        second = document(12, style=("(*!", "!*)"))
        result = self.client.call({"action": "annotate", "scope": "batch", "language": "explicit",
            "commentStyles": [{"start": ";;"}], "files": [
                {"text": first}, {"text": second, "commentStyles": [CUSTOM_STYLES[1]]},
                {"text": document(12), "commentStyles": []}]})
        self.assertEqual([len(item["regions"]) for item in result["files"]], [1, 1, 1])
        for item in result["files"]:
            reused = self.client.annotate("batch", id=item["id"])
            self.assertEqual(reused["commentStyles"], item["commentStyles"])
            self.assertEqual(reused["regions"], item["regions"])
        baseline = self.client._db.execute("SELECT scope, data FROM scopes ORDER BY scope").fetchall()
        for styles in INVALID_STYLES:
            with self.subTest(styles=styles):
                with self.assertRaises(FoldingError):
                    self.client.read_source("batch", files=[
                        {"text": document(15, name="fresh"), "language": "explicit"},
                        {"id": result["files"][0]["id"], "commentStyles": styles}])
                self.assertEqual(self.client._db.execute("SELECT scope, data FROM scopes ORDER BY scope").fetchall(), baseline)
        for broken in (second.replace("(*! @context-fold end region !*)", "(* @context-fold end region *)"),
                       second.replace("(*! @context-fold end region !*)", "(*! @context-fold end region")):
            with self.assertRaises(FoldingError):
                self.client.annotate("batch", commentStyles=CUSTOM_STYLES, files=[
                    {"text": document(15, name="fresh")}, {"text": broken}])
            self.assertEqual(self.client._db.execute("SELECT scope, data FROM scopes ORDER BY scope").fetchall(), baseline)

    def test_rediscovery_preserves_manual_marks_only_on_same_original_regions(self):
        source = document(12, name="kept") + document(12, name="unmarked") + document(12, name="folded")
        stored = self.client.annotate("s", text=source, language="explicit", keep=["kept"], marks=[
            {"name": "unmarked", "disposition": "unmarked"}])
        for options in ({"commentStyles": CUSTOM_STYLES}, {"language": "text"},
                        {"commentStyles": [], "language": "unknown"}):
            with self.subTest(options=options):
                result = self.client.annotate("s", id=stored["id"], **options)
                self.assertEqual([r["disposition"] for r in result["regions"]], ["keep", "unmarked", "foldable"])
                self.assertEqual([r.get("manual", False) for r in result["regions"]], [True, True, False])
                view = self.client.read_source("s", id=stored["id"])
                self.assertIn(document(12, name="kept"), view["text"])
                self.assertIn(document(12, name="unmarked"), view["text"])
                self.assertNotIn(document(12, name="folded"), view["text"])
        # Equal-length edits retain names and spans, but create a new original.
        changed = source.replace("原文", "改文")
        result = self.client.annotate("s", text=changed, language="text", commentStyles=CUSTOM_STYLES)
        self.assertNotEqual(result["id"], stored["id"])
        self.assertEqual([r["disposition"] for r in result["regions"]], ["foldable"] * 3)
        self.assertTrue(all(not r.get("manual") for r in result["regions"]))

    def test_manual_marks_survive_temporarily_undiscovered_regions_and_reopen(self):
        from context_folding import Client
        source = (document(12, style=";;", name="kept") +
                  document(12, style=";;", name="unmarked") +
                  document(12, style=";;", name="folded"))
        styles = [{"start": ";;"}]
        stored = self.client.annotate("s", text=source, language="explicit", commentStyles=styles,
                                      keep=["kept"], marks=[{"name": "unmarked", "disposition": "unmarked"}])
        hidden = self.client.annotate("s", id=stored["id"], commentStyles=[])
        self.assertEqual(hidden["regions"], [])
        # Reopen to ensure the dormant decisions are durable, not an in-memory cache.
        with Client(Path(self.directory.name) / "state.sqlite") as reopened:
            restored = reopened.annotate("s", id=stored["id"], commentStyles=styles)
            self.assertEqual([r["disposition"] for r in restored["regions"]],
                             ["keep", "unmarked", "foldable"])
            self.assertEqual([r.get("manual", False) for r in restored["regions"]], [True, True, False])
            view = reopened.read_source("s", id=stored["id"])
            self.assertIn(document(12, style=";;", name="kept"), view["text"])
            self.assertIn(document(12, style=";;", name="unmarked"), view["text"])
            self.assertNotIn(document(12, style=";;", name="folded"), view["text"])
            self.assertEqual(reopened.resolve("s", view["text"])["value"], source)
            reopened.annotate("s", id=stored["id"], marks=[{"name": "kept", "disposition": "foldable"}])
            reopened.annotate("s", id=stored["id"], commentStyles=[])
            updated = reopened.annotate("s", id=stored["id"], commentStyles=styles)
            self.assertEqual([r["disposition"] for r in updated["regions"]],
                             ["foldable", "unmarked", "foldable"])
            changed = reopened.annotate("s", text=source.replace("原文", "改文"),
                                         language="explicit", commentStyles=styles)
            self.assertNotEqual(changed["id"], stored["id"])
            self.assertTrue(all(r["disposition"] == "foldable" and not r.get("manual")
                                for r in changed["regions"]))

    def test_python_ast_rediscovery_preserves_manual_marks(self):
        source = 'def kept():\n' + ''.join(f'    value_{n} = {n}\n' for n in range(15))
        stored = self.client.annotate("s", text=source, language="python", keep=["kept"])
        result = self.client.annotate("s", id=stored["id"], language="py", commentStyles=CUSTOM_STYLES)
        self.assertEqual(result["regions"][0]["disposition"], "keep")
        self.assertTrue(result["regions"][0]["manual"])
        # Equal spans remain the same region even when its parser kind changes.
        source = '# @context-fold begin kept\n' + source + '# @context-fold end kept\n'
        stored = self.client.annotate("s", text=source, language="python", keep=["kept"])
        # The explicit outer region and the inner function differ in spans.
        result = self.client.annotate("s", id=stored["id"], language="explicit")
        self.assertTrue(all(r["disposition"] == "keep" for r in result["regions"]))

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
