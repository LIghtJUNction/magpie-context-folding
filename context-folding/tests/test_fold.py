"""The shared explicit fold action and actual ctxf subprocess pipelines."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError


PACKAGE = Path(__file__).resolve().parents[1]
BODY = "原文🙂 evidence and punctuation.\r\n" * 80 + "final detail"


def block(body=BODY, label="evidence", newline="\n", shell=""):
    prefix = shell + " " if shell else ""
    return f"{prefix}@context-fold begin {label}{newline}{body}{newline}{prefix}@context-fold end {label}"


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()



class FoldTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / ".git").mkdir()
        self.state = self.directory / "archive.sqlite3"
        self.client = Client(self.state, project_dir=self.directory)
        self.addCleanup(self.client.close)

    def snapshot(self):
        row = self.client._db.execute("SELECT data FROM scopes WHERE scope='s'").fetchone()
        return json.loads(row[0]) if row else None

    def test_shared_fold_is_immediate_full_length_and_recoverable(self):
        before = "visible preface\r\n" * 2500
        after = "\r\nvisible ending" * 2500
        source = before + block() + after
        result = self.client.fold("s", source)
        sha = digest(BODY)
        reference = result["references"][0]["reference"]
        self.assertTrue(reference.startswith(f"[[cf:v3:{sha[:12]} path="))
        self.assertEqual(result["text"], before + block(reference) + after)
        self.assertGreater(len(result["text"]), 24000)
        self.assertEqual(result["scope"], "s")
        self.assertEqual(len(result["references"]), 1)
        entry = result["references"][0]
        self.assertEqual(set(entry), {"id", "label", "sha256", "reference", "archiveId", "path"})
        self.assertEqual({k: entry[k] for k in ("id", "label", "sha256", "reference")},
                         {"id": sha, "label": "evidence", "sha256": sha, "reference": reference})
        self.assertNotIn(BODY, json.dumps(entry, ensure_ascii=False))
        self.assertEqual(self.client.read("s", sha, limit=24000)["text"], BODY)
        self.assertEqual(self.client.read("s", entry["archiveId"], limit=24000)["text"], BODY)
        self.assertEqual(self.client.resolve("s", result["text"])["value"], source)
        self.assertNotIn("sourceOccurrences", self.snapshot())
        with self.assertRaises(FoldingError):
            self.client.read("other-scope", sha)

    def test_existing_references_and_new_blocks_are_literal_and_idempotent(self):
        first = self.client.fold("s", block())
        added = block("new material\n" * 80, "next")
        original = first["text"] + "\n" + added
        second = self.client.fold("s", original)
        self.assertEqual(len(second["references"]), 1)
        self.assertEqual(second["references"][0]["label"], "next")
        self.assertTrue(second["text"].startswith(first["text"]))
        before = self.snapshot()
        self.assertEqual(self.client.fold("s", second["text"]),
                         {"scope": "s", "text": second["text"], "references": []})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.client.resolve("s", second["text"])["value"], block() + "\n" + added)
        for literal in ("[[cf:v2:" + "0" * 12 + "]]", "[[cf:v1:" + "0" * 24 + "]]", "[[cf:broken"):
            with self.subTest(literal=literal):
                combined = literal + "\n" + block("independent new evidence\n" * 30, "another")
                folded = self.client.fold("s", combined)
                self.assertTrue(folded["text"].startswith(literal + "\n"))
                self.assertEqual(len(folded["references"]), 1)
        contains_reference = block(first["references"][0]["reference"] + "\n" + BODY)
        self.assertEqual(self.client.fold("s", contains_reference)["text"], contains_reference)

    def test_empty_unmarked_unclosed_and_short_text_do_not_write_archive(self):
        for text in ("", "no marker\r\n中文🙂", "@context-fold begin open\n" + BODY, block("short")):
            with self.subTest(text=text[:40]):
                self.assertEqual(self.client.fold("s", text), {"scope": "s", "text": text, "references": []})
                self.assertIsNone(self.snapshot())
        with Client(self.state, project_dir=self.directory, config={"folding": {"max_session_bytes": 1}}) as tiny:
            self.assertEqual(tiny.fold("s", block("short"))["references"], [])
            self.assertIsNone(self.snapshot())

    def test_savings_include_file_pointer_overhead_and_never_store_short_ascii(self):
        source = block("汉" * 200, "chinese") + "\n" + block("short", "ascii")
        result = self.client.fold("s", source)
        self.assertEqual([r["label"] for r in result["references"]], ["chinese"])
        self.assertLess(len(result["text"].encode("utf-8")), len(source.encode("utf-8")))
        self.assertEqual([entry["text"] for entry in self.snapshot()["entries"]], ["汉" * 200])
        with Client(self.directory / "automatic.sqlite3", project_dir=self.directory,
                    config={"folding": {"delay_requests": 0}}) as automatic:
            view = automatic.read_source("s", text=block("汉" * 200, "chinese"))
            self.assertEqual(len(view["foldedRegions"]), 1)

    def test_explicit_fold_does_not_change_background_delay_or_keep(self):
        source = block(shell="#")
        first = self.client.read_source("s", text=source, occurrence="read-1", requestCycle=0, limit=24000)
        self.assertEqual(first["text"], source)
        folded = self.client.fold("s", source)
        self.assertTrue(folded["references"])
        self.assertEqual(self.client.read_source("s", text=source, occurrence="read-1", requestCycle=0, limit=24000)["text"], source)
        automatic = self.client.read_source("s", text=source, occurrence="read-1", requestCycle=1, limit=24000)
        self.assertTrue(automatic["foldedRegions"])
        self.client.read("s", folded["references"][0]["id"])
        self.assertEqual(self.client.read_source("s", text=source, occurrence="read-1", requestCycle=2, limit=24000)["text"], source)
        self.assertTrue(self.client.fold("s", source)["references"], "an explicit request may fold recovered text again")
        self.assertEqual(self.client.read_source("s", text=source, occurrence="read-1", requestCycle=3, limit=24000)["text"], source)
        self.assertEqual(self.client.config["folding"]["delay_requests"], 1)
        with Client(self.directory / "disabled.sqlite3", project_dir=self.directory, config={
            "folding": {"enabled": False, "delay_requests": 100},
            "annotations": {"enabled": False, "default_fold": False, "keep": ["*"]},
        }) as explicit:
            self.assertTrue(explicit.fold("s", source)["references"])
            self.assertEqual(explicit.read_source("s", text=source, limit=24000)["text"], source)

    def test_language_comment_styles_and_partial_stream_share_discovery(self):
        literal = 'description = """\n' + block(shell="#") + '\n"""\n'
        source = literal + block(BODY, "valid", shell="#")
        self.assertEqual([item["label"] for item in self.client.fold("s", source, language="python")["references"]], ["valid"])
        custom = block(BODY, "custom", newline="\r\n", shell=";;")
        result = self.client.fold("s", custom, commentStyles=[{"start": ";;"}])
        self.assertEqual([item["label"] for item in result["references"]], ["custom"])
        self.assertEqual(self.client.resolve("s", result["text"])["value"], custom)
        partial = block() + "\n@context-fold begin unfinished\nvisible remainder"
        result = self.client.fold("s", partial)
        self.assertEqual(len(result["references"]), 1)
        self.assertTrue(result["text"].endswith("@context-fold begin unfinished\nvisible remainder"))

    def test_batch_short_hash_collision_is_extended_before_publication(self):
        left, right = "left payload\n" * 20, "right payload\n" * 20
        left_hash, right_hash = "1" * 12 + "a" * 52, "1" * 12 + "b" * 52
        actual = hashlib.sha256

        def synthetic(data=b""):
            class Fixed:
                def hexdigest(self):
                    return left_hash if data == left.encode() else right_hash
            return Fixed() if data in (left.encode(), right.encode()) else actual(data)

        with patch("context_folding.core.hashlib.sha256", synthetic):
            result = self.client.fold("s", block(left, "left") + "\n" + block(right, "right"))
            self.assertEqual([item["reference"] for item in result["references"]],
                             [f'[[cf:v3:{sha[:14]} path={json.dumps(item["path"], ensure_ascii=False)}]]' for sha, item in zip((left_hash, right_hash), result["references"]) ])
            with self.assertRaises(FoldingError) as raised:
                self.client.read("s", "1" * 12)
            self.assertEqual(raised.exception.code, "ambiguous_hash")
            self.assertEqual(self.client.read("s", left_hash)["text"], left)

    def test_invalid_inputs_and_quota_fail_without_references_or_partial_state(self):
        for request in ({"text": None}, {"text": "\ud800"}, {"text": block(), "limit": 1},
                        {"text": block(), "requestCycle": 0}, {"text": block(), "commentStyles": [{"start": ""}]}):
            with self.subTest(request=list(request)):
                with self.assertRaises(FoldingError):
                    self.client.call({"action": "fold", "scope": "s", **request})
                self.assertIsNone(self.snapshot())
        with Client(self.state, project_dir=self.directory, config={"folding": {"max_session_bytes": 100}}) as tiny:
            with self.assertRaises(FoldingError) as raised:
                tiny.fold("s", block())
            self.assertEqual(raised.exception.code, "quota")
            self.assertIsNone(self.snapshot())

    def test_published_references_survive_aggressive_gc_and_root_updates(self):
        config = {"gc": {"enabled": True, "strength": "aggressive", "idle_seconds": 0,
                         "max_uses": 0, "retention_seconds": 0, "auto_purge": True}}
        state = self.directory / "collected.sqlite3"
        with Client(state, project_dir=self.directory, config=config) as client:
            folded = client.fold("s", block())
            identifier = folded["references"][0]["archiveId"]
            # A host may publish a new root set before anything reads the old
            # output. The already issued reference must retain its original.
            client.call({"action": "roots", "scope": "s", "ids": []})
            status = client.call({"action": "gc", "scope": "s", "mode": "status"})
            self.assertIn(identifier, status["protected"])
            self.assertEqual(client.resolve("s", folded["text"])["value"], block())
            client.call({"action": "gc", "scope": "s", "mode": "collect"})
        with Client(state, project_dir=self.directory, config=config) as reopened:
            self.assertEqual(reopened.read("s", folded["references"][0]["id"], peek=True)["text"], BODY)
            self.assertEqual(reopened.resolve("s", folded["text"])["value"], block())


class CtxfProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / ".git").mkdir()
        self.env = dict(os.environ)
        self.env.pop("CTXF_STATE", None)
        self.env["XDG_DATA_HOME"] = str(self.directory / "data")
        self.env["XDG_CONFIG_HOME"] = str(self.directory / "config")
        self.env["PYTHONPATH"] = str(PACKAGE / "python") + os.pathsep + self.env.get("PYTHONPATH", "")
        self.state = self.directory / "data" / "context-folding" / "archive.sqlite3"
        # Use the package's registered console entry point, in a real executable
        # subprocess, without requiring a package installation inside unit tests.
        script = re.search(r'^ctxf\s*=\s*"([^"]+)"', (PACKAGE / "pyproject.toml").read_text(), re.MULTILINE)
        self.assertIsNotNone(script, "ctxf must be registered in project.scripts")
        module, function = script[1].split(":")
        self.launcher = self.directory / "ctxf"
        self.launcher.write_text(f"#!{sys.executable}\nfrom {module} import {function}\nraise SystemExit({function}())\n")
        self.launcher.chmod(0o700)

    def run_ctxf(self, *args, data=b"", env=None):
        return subprocess.run([str(self.launcher), *args], input=data, capture_output=True,
                              env=self.env if env is None else env, cwd=self.directory, timeout=15)

    def succeeded(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stderr, b"")
        return result.stdout

    def test_default_stdin_command_is_exact_for_empty_unmarked_and_newlines(self):
        for raw in (b"", "中文🙂 no final newline".encode(), b"line\r\nnext\rfinal\n", b"@context-fold begin open\nunfinished"):
            with self.subTest(raw=raw[:30]):
                self.assertEqual(self.succeeded(self.run_ctxf(data=raw)), raw)
        self.assertTrue(self.state.is_file())
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_fold_json_and_raw_recovery_use_persistent_default_scope(self):
        for ending in ("", "\n", "\r\n"):
            source = block(newline="\r\n", shell="#") + ending
            result = self.run_ctxf("fold", "--json", data=source.encode())
            metadata = json.loads(self.succeeded(result))
            self.assertEqual(metadata["scope"], "default")
            self.assertEqual(metadata["text"], block(metadata["references"][0]["reference"], newline="\r\n", shell="#") + ending)
            self.assertEqual(self.succeeded(self.run_ctxf("read", "--raw", "--id", metadata["references"][0]["id"])), BODY.encode())
            regular_read = json.loads(self.succeeded(self.run_ctxf("read", "--id", metadata["references"][0]["id"])))
            self.assertEqual(regular_read["result"]["text"], BODY)
            self.assertEqual(self.succeeded(self.run_ctxf(data=source.encode())), metadata["text"].encode())

    def test_two_actual_processes_form_an_idempotent_pipeline(self):
        source = "visible\n" * 5000 + block() + "\nlast line without newline"
        first = subprocess.Popen([str(self.launcher)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=self.env, cwd=self.directory)
        second = subprocess.Popen([str(self.launcher), "fold"], stdin=first.stdout, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=self.env, cwd=self.directory)
        first.stdout.close()
        first.stdout = None
        try:
            _, first_error = first.communicate(source.encode(), timeout=15)
            output, second_error = second.communicate(timeout=15)
            self.assertEqual((first.returncode, second.returncode), (0, 0))
            self.assertEqual((first_error, second_error), (b"", b""))
            reference = json.loads(self.succeeded(self.run_ctxf("fold", "--json", data=source.encode())))["references"][0]["reference"]
            expected = source.replace(BODY, reference).encode()
            self.assertEqual(output, expected)
            self.assertGreater(len(output), 24000)
            self.assertEqual(self.succeeded(self.run_ctxf("read", "--raw", "--id", digest(BODY))), BODY.encode())
        finally:
            for process in (first, second):
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    def test_raw_read_collects_more_than_one_page_without_truncation(self):
        body = "原文🙂\r\n" * 12000 + "end without newline"
        source = block(body, newline="\r\n")
        metadata = json.loads(self.succeeded(self.run_ctxf("--json", data=source.encode())))
        identifier = metadata["references"][0]["id"]
        self.assertEqual(self.succeeded(self.run_ctxf("read", "--raw", "--id", identifier)), body.encode())
        self.assertEqual(self.succeeded(self.run_ctxf("read", "--raw", "--id", identifier, "--offset", "1", "--limit", "2")), body[1:3].encode())
        request = json.dumps({"action": "resolve", "scope": "default", "value": metadata["text"]}).encode()
        recovered = json.loads(self.succeeded(self.run_ctxf("call", data=request)))
        self.assertEqual(recovered["result"]["value"].encode(), source.encode())

    def test_state_and_scope_overrides_before_after_and_from_environment(self):
        env = {**self.env, "CTXF_STATE": str(self.directory / "environment.sqlite3")}
        result = json.loads(self.succeeded(self.run_ctxf("--scope", "before", "--json", data=block().encode(), env=env)))
        self.assertEqual(result["scope"], "before")
        self.assertTrue(Path(env["CTXF_STATE"]).is_file())
        self.assertFalse(self.state.exists())
        other = self.directory / "override.sqlite3"
        for args in (("--state", str(other), "--scope", "chosen", "fold", "--json"),
                     ("fold", "--json", "--state", str(other), "--scope", "chosen")):
            result = json.loads(self.succeeded(self.run_ctxf(*args, data=block().encode(), env=env)))
            self.assertEqual(result["scope"], "chosen")
        request = json.dumps({"action": "fold", "text": block()}).encode()
        result = json.loads(self.succeeded(self.run_ctxf("--scope", "call-scope", "call", data=request)))
        self.assertEqual(result["result"]["scope"], "call-scope")
        supplied = json.dumps({"action": "fold", "scope": "json-scope", "text": block()}).encode()
        for args in (("--scope", "flag-scope", "call"), ("call", "--scope", "flag-scope")):
            result = json.loads(self.succeeded(self.run_ctxf(*args, data=supplied)))
            self.assertEqual(result["result"]["scope"], "flag-scope")
        result = json.loads(self.succeeded(self.run_ctxf("call", data=supplied)))
        self.assertEqual(result["result"]["scope"], "json-scope")

    def test_rpc_uses_the_shared_fold_action_and_default_state(self):
        request = {"action": "fold", "scope": "wire", "text": block()}
        wire = json.dumps(request, ensure_ascii=False).encode() + b"\n"
        result = json.loads(self.succeeded(self.run_ctxf("rpc", data=wire)))
        self.assertTrue(result["result"]["references"])

    def test_server_scope_is_per_request_and_raw_read_accepts_peek(self):
        for command in ("rpc",):
            rejected = self.run_ctxf("--scope", "ignored", command)
            self.assertEqual(rejected.returncode, 2)
            self.assertEqual(rejected.stdout, b"")
            self.assertIn(b"each RPC request", rejected.stderr)
        folded = json.loads(self.succeeded(self.run_ctxf("--json", data=block().encode())))
        identifier = folded["references"][0]["id"]
        self.assertEqual(self.succeeded(self.run_ctxf("read", "--raw", "--peek", "--id", identifier)), BODY.encode())

    def test_closed_downstream_pipe_exits_without_traceback_or_partial_error(self):
        for text in ("x", "long visible output\n" * 2000):
            process = subprocess.Popen([str(self.launcher), "fold", "--text", text],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       env=self.env, cwd=self.directory)
            process.stdout.close()
            process.stdout = None
            try:
                _, error = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(error, b"")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    def test_invalid_utf8_missing_read_and_unavailable_archive_never_write_stdout(self):
        destination = self.directory / "not-a-file"
        destination.mkdir()
        for args, data in (((), b"\xffprivate\xfe"), (("read", "--raw", "--id", "0" * 64), b""),
                           (("--state", str(destination)), block().encode())):
            with self.subTest(args=args):
                result = self.run_ctxf(*args, data=data)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertIn("error", json.loads(result.stderr))
                self.assertNotIn(b"private", result.stderr)

    def test_quota_and_failed_commit_emit_no_dangling_reference(self):
        (self.directory / ".context-folding.toml").write_text("[folding]\nmax_session_bytes=100\n")
        denied = self.run_ctxf(data=block().encode())
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(denied.stdout, b"")
        self.assertEqual(json.loads(denied.stderr)["error"]["code"], "quota")
        (self.directory / ".context-folding.toml").unlink()
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM scopes").fetchone()[0], 0)
            db.execute("CREATE TRIGGER refuse_commit BEFORE INSERT ON scopes BEGIN SELECT RAISE(FAIL, 'synthetic storage failure'); END")
        failed = self.run_ctxf("fold", "--json", data=block().encode())
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(failed.stdout, b"")
        self.assertEqual(json.loads(failed.stderr)["error"]["code"], "storage")
        with sqlite3.connect(self.state) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM scopes").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
