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


class AnnotationTests(unittest.TestCase):

    def test_function_marker_rejects_invalid_source_and_markers(self):
        from context_folding.annotations import annotate_python_functions
        for source in ("def broken(:\n", "# @context-fold begin missing\ndef work(): pass\n",
                       "# @context-fold wat x\ndef work(): pass\n"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                annotate_python_functions(source)

    def test_function_marker_apply_rejects_damage_after_a_complete_region(self):
        from context_folding.cli import _annotate_functions
        completed = "# @context-fold begin complete\nvalue = 1\n# @context-fold end complete\n"
        function = "def work():\n    return 3\n"
        damaged = (
            "# @context-fold begin open\n",
            "# @context-fold begin broken\n# @context-fold end wrong\n# @context-fold end broken\n",
            "# @context-fold begin\n",
            "# @context-fold end orphan\n",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            for bad in damaged:
                with self.subTest(bad=bad):
                    original = (completed + bad + function).encode()
                    path.write_bytes(original)
                    self.assertEqual([r["name"] for r in discover_source(original.decode(), "python")["regions"]], ["complete"])
                    with self.assertRaises(ValueError):
                        _annotate_functions(str(path), "python", True)
                    self.assertEqual(path.read_bytes(), original)

    def test_function_marker_preserves_valid_nested_annotations(self):
        from context_folding.annotations import annotate_python_functions
        source = ("# @context-fold begin outer\n# @context-fold begin inner\n"
                  "value = 1\n# @context-fold end inner\n# @context-fold end outer\n"
                  "def work():\n    return 3\n")
        marked = annotate_python_functions(source)
        self.assertEqual([r["name"] for r in discover_source(marked["text"], "python")["regions"]],
                         ["outer", "inner", "work"])
        self.assertEqual(ast.dump(ast.parse(source)), ast.dump(ast.parse(marked["text"])))
        self.assertEqual(annotate_python_functions(marked["text"])["text"], marked["text"])

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

    def test_annotation_dependencies_survive_collection_and_view_pagination(self):
        stored = self.client.annotate("s", text=self.SOURCE, language="python")
        view = self.client.read("s", stored["id"])
        self.client.call({"action": "roots", "scope": "s", "ids": [stored["id"]]})
        self.client.call({"action": "gc", "scope": "s", "mode": "configure", "config": {"strength": "aggressive", "idleSeconds": 0, "maxUses": 10000}})
        self.client.call({"action": "gc", "scope": "s", "mode": "collect"})
        self.assertEqual(self.client.resolve("s", view["text"])["value"], self.SOURCE)
        parts, offset = [], 0
        while True:
            page = self.client.read("s", stored["id"], offset=offset, limit=33)
            parts.append(page["text"])
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual("".join(parts), view["text"])
        self.assertEqual(self.client.resolve("s", "".join(parts))["value"], self.SOURCE)


if __name__ == "__main__":
    unittest.main()
