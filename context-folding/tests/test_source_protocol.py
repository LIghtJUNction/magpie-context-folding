"""The v2 contract: annotation-only selection, durable hash references and delay."""
import ast
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError
from context_folding.annotations import annotate_python_functions, discover_source, fold_regions
from context_folding.core import _entry, _short_hash


def region(body=None, label="result", start="#", end="", newline="\n"):
    body = body if body is not None else "\n".join(f"value_{i} = {i}" for i in range(60))
    return (f"{start} @context-fold begin {label} {end}".strip() + "\n" + body + "\n"
            + f"{start} @context-fold end {label} {end}".strip() + "\n").replace("\n", newline)


class SourceProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "archive.sqlite"
        self.client = Client(self.path)
        self.addCleanup(self.client.close)

    def project(self, text=None, **fields):
        request = {"text": region() if text is None else text, "language": "python", "limit": 24000}
        request.update(fields)
        return self.client.read_source("s", **request)

    def state(self):
        return self.client._db.execute("SELECT scope,data FROM scopes ORDER BY scope").fetchall()

    def test_shared_typescript_python_region_fixtures(self):
        fixtures = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "annotation-regions.json"
        for case in json.loads(fixtures.read_text()):
            with self.subTest(name=case["name"]):
                parsed = discover_source(case["text"], "explicit")
                payloads = [case["text"][r["start"]:r["end"]] for r in parsed["regions"]]
                self.assertEqual(payloads, case["payloads"])
                self.assertEqual([r["sha256"] for r in parsed["regions"]],
                                 [hashlib.sha256(payload.encode()).hexdigest() for payload in case["payloads"]])

    def test_unmarked_functions_and_similar_observations_never_fold(self):
        source = "def run():\n" + "    value = 1\n" * 100
        self.assertEqual(discover_source(source, "python")["regions"], [])
        first = self.client.put("s", source)
        second = self.client.put("s", source + "    return value\n")
        self.assertIsNone(first["version"])
        self.assertIsNone(second["version"])
        for cycle in range(3):
            view = self.project(source, occurrence="unmarked", requestCycle=cycle)
            self.assertEqual(view["text"], source)
            rendered = self.client.render("s", [first["id"]], occurrence="render", requestCycle=cycle)
            self.assertEqual(rendered["entries"][0]["text"], source)

    def test_closed_region_waits_one_cycle_and_retries_do_not_age(self):
        source = region()
        for _ in range(3):
            view = self.project(source, occurrence="read-1", requestCycle=10)
            self.assertEqual(view["text"], source)
            self.assertEqual(view["delayReason"], "waiting-for-request-cycle")
        folded = self.project(source, occurrence="read-1", requestCycle=11)
        self.assertEqual(len(folded["foldedRegions"]), 1)
        self.assertEqual(self.client.resolve("s", folded["text"])["value"], source)

    def test_missing_host_cycle_keeps_original_even_after_many_reads(self):
        for _ in range(3):
            view = self.project()
            self.assertEqual(view["text"], region())
            self.assertEqual(view["delayReason"], "host-request-cycle-required")
        legacy = fold_regions(self.client, "s", region(), language="python")
        self.assertEqual(legacy["text"], region())

    def test_new_occurrence_and_changed_content_restart_the_delay(self):
        self.project(occurrence="a", requestCycle=0)
        self.assertTrue(self.project(occurrence="a", requestCycle=1)["foldedRegions"])
        self.assertEqual(self.project(occurrence="b", requestCycle=2)["text"], region())
        changed = region().replace("value_59 = 59", "value_59 = 60")
        self.assertEqual(self.project(changed, occurrence="a", requestCycle=3)["text"], changed)
        self.assertTrue(self.project(changed, occurrence="a", requestCycle=4)["foldedRegions"])

    def test_cycle_validation_is_atomic(self):
        self.project(occurrence="a", requestCycle=4)
        before = self.state()
        for fields in ({"occurrence": "a"}, {"requestCycle": 5}, {"occurrence": "a", "requestCycle": 3},
                       {"occurrence": "a", "requestCycle": True}, {"occurrence": "a", "requestCycle": -1}):
            with self.subTest(fields=fields), self.assertRaises(FoldingError):
                self.project(**fields)
            self.assertEqual(self.state(), before)

    def test_zero_delay_is_explicit_and_disabled_folding_is_respected(self):
        with Client(self.path, config={"folding": {"delay_requests": 0}}) as eager:
            self.assertTrue(eager.read_source("s", text=region(), language="python")["foldedRegions"])
        with Client(self.path, config={"folding": {"enabled": False, "delay_requests": 0}}) as disabled:
            view = disabled.read_source("s", text=region(), language="python", mode="folded")
            self.assertEqual(view["text"], region())

    def test_content_hash_is_dynamic_and_old_references_stay_exact(self):
        original = region()
        self.project(original, occurrence="a", requestCycle=0)
        folded = self.project(original, occurrence="a", requestCycle=1)
        reference = folded["foldedRegions"][0]["reference"]
        payload = original.split("\n", 1)[1].rsplit("\n# @context-fold end", 1)[0]
        digest = hashlib.sha256(payload.encode()).hexdigest()
        self.assertEqual(reference, f"[[cf:v2:{digest[:12]}]]")
        changed = original.replace("value_59 = 59", "value_59 = 60")
        self.project(changed, occurrence="b", requestCycle=2)
        changed_view = self.project(changed, occurrence="b", requestCycle=3)
        self.assertNotEqual(reference, changed_view["foldedRegions"][0]["reference"])
        self.assertEqual(self.client.read("s", digest[:12])["text"], payload)
        self.assertEqual(self.client.resolve("s", reference)["value"], payload)

    def test_hash_prefix_collisions_extend_and_never_select_arbitrarily(self):
        prefix = "a" * 12
        snapshot = {"entries": [{"id": "one", "text": "one"}, {"id": "two", "text": "two"}], "groups": []}
        hashes = {"one": prefix + "1" * 52, "two": prefix + "2" * 52}
        with patch("context_folding.core._content_hash", side_effect=lambda n: hashes[n["id"]]):
            self.assertEqual(_short_hash(snapshot, hashes["one"]), prefix + "11")
            with self.assertRaises(FoldingError) as raised:
                _entry(snapshot, prefix, content_hash=True)
            self.assertEqual(raised.exception.code, "ambiguous_hash")
            self.assertEqual(_entry(snapshot, prefix + "2", content_hash=True)["text"], "two")
        with patch("context_folding.core._content_hash", return_value="f" * 64):
            with self.assertRaises(FoldingError):
                _short_hash(snapshot, "f" * 64)
            with self.assertRaises(FoldingError):
                _entry(snapshot, "f" * 64, content_hash=True)

    def test_all_comment_shells_and_physical_newlines_round_trip(self):
        shells = [("", ""), ("#", ""), ("//", ""), ("--", ""), (";", ""), ("%", ""),
                  ("!", ""), ("'", ""), ('"', ""), ("REM", ""), ("/*", "*/"), ("<!--", "-->"),
                  ("(*", "*)"), ("{-", "-}"), ("#|", "|#"), ("<#", "#>")]
        with Client(self.path, config={"folding": {"delay_requests": 0}}) as eager:
            for start, end in shells:
                for newline in ("\n", "\r\n", "\r"):
                    source = region('value = "你好😀"\n' * 60, start=start, end=end, newline=newline)
                    with self.subTest(start=start, newline=newline):
                        view = eager.read_source("shell", text=source, language="explicit", limit=24000)
                        self.assertTrue(view["foldedRegions"])
                        self.assertEqual(eager.resolve("shell", view["text"])["value"], source)

    def test_invalid_and_unclosed_regions_stay_visible(self):
        samples = ["# @context-fold begin open\n" + "x\n" * 100,
                   "# @context-fold end orphan\n", "# @context-fold begin\n",
                   region().replace("end result", "end wrong")]
        for source in samples:
            with self.subTest(source=source[:50]):
                self.assertEqual(discover_source(source, "python")["regions"], [])
                for cycle in (0, 1):
                    self.assertEqual(self.project(source, occurrence=hashlib.sha256(source.encode()).hexdigest(), requestCycle=cycle)["text"], source)

    def test_completed_regions_survive_later_unfinished_or_damaged_regions(self):
        complete = region("# completed detail\n" * 30, label="complete")
        following = region("# independent detail\n" * 30, label="following")
        damaged = {
            "unclosed": "# @context-fold begin open\n# work in progress\n",
            "malformed": "# @context-fold begin broken\n# @context-fold end\n# @context-fold end broken\n",
            "mismatch": "# @context-fold begin broken\n# @context-fold end wrong\n# @context-fold end broken\n",
            "mismatch-unclosed": "# @context-fold begin broken\n# @context-fold end wrong\n",
        }
        with Client(self.path, config={"folding": {"delay_requests": 0}}) as eager:
            for kind, bad in damaged.items():
                with self.subTest(kind=kind):
                    source = complete + bad + following
                    view = eager.read_source(kind, text=source, language="python", limit=24000)
                    names = [item["name"] for item in view["foldedRegions"]]
                    self.assertEqual(names, ["complete", "following"])
                    self.assertIn(bad, view["text"])
                    self.assertEqual(eager.resolve(kind, view["text"])["value"], source)
                    self.assertTrue(view["limitations"])

    def test_orphan_or_malformed_directives_outside_regions_do_not_cancel_them(self):
        for literal in ("# @context-fold end orphan\n", "# @context-fold begin\n",
                        "# @context-fold nonsense label\n"):
            with self.subTest(literal=literal):
                source = literal + region(label="first") + literal + region(label="last") + literal
                parsed = discover_source(source, "python")
                self.assertEqual([r["name"] for r in parsed["regions"]], ["first", "last"])
                with self.assertRaises(ValueError):
                    discover_source(source, "python", strict=True)

    def test_mismatched_comment_shell_does_not_guess_an_end(self):
        first = region("first detail\n" * 30, label="first", start="//")
        bad = "// @context-fold begin open\n# @context-fold end open\n"
        last = region("last detail\n" * 30, label="last", start="//")
        self.assertEqual([r["name"] for r in discover_source(first + bad + last, "explicit")["regions"]], ["first", "last"])
        repaired_boundary = first + bad + "// @context-fold end open\n" + last
        self.assertEqual([r["name"] for r in discover_source(repaired_boundary, "explicit")["regions"]], ["first", "last"])

    def test_existing_fold_references_are_not_archived_again(self):
        for prefix in ("[[cf:v1:", "[[cf:v2:"):
            source = region(prefix + "1" * 24 + "]]\n" + "old output\n" * 60)
            for cycle in (0, 1):
                view = self.project(source, occurrence=prefix, requestCycle=cycle)
                self.assertEqual(view["text"], source)
                self.assertEqual(view["foldedRegions"], [])

    def test_python_strings_and_inline_markers_are_literal_data(self):
        source = 'description = """\n' + region() + '"""\n'
        self.assertEqual(discover_source(source, "python")["regions"], [])
        self.assertEqual(discover_source('x = 1 # @context-fold begin a\nx = 2\n# @context-fold end a\n', "python")["regions"], [])

    def test_explicit_annotation_editor_is_opt_in_and_does_not_nest(self):
        source = "def outer():\n    def inner():\n        return 1\n    return inner()\n"
        self.assertEqual(discover_source(source, "python")["regions"], [])
        result = annotate_python_functions(source)
        self.assertEqual([item["name"] for item in result["added"]], ["outer"])
        self.assertEqual(result["skippedNested"], 1)
        self.assertEqual(ast.dump(ast.parse(source)), ast.dump(ast.parse(result["text"])))
        self.assertEqual(annotate_python_functions(result["text"])["text"], result["text"])

    def test_read_is_a_query_and_legacy_source_keep_requires_an_explicit_selector(self):
        source = region(label="left") + region(body="other = 2\n" * 60, label="right")
        self.project(source, occurrence="x", requestCycle=0)
        folded = self.project(source, occurrence="x", requestCycle=1)
        left = folded["foldedRegions"][0]["reference"][8:-2]
        before = self.state()
        self.client.read("s", left)
        self.assertEqual(self.state(), before)
        view = self.project(source, occurrence="x", requestCycle=2)
        self.assertEqual([item["name"] for item in view["foldedRegions"]], ["left", "right"])
        expanded = self.project(source, occurrence="x", requestCycle=3, expand=["right"])
        self.assertEqual([item["name"] for item in expanded["foldedRegions"]], ["left"])
        self.assertEqual(self.project(source, occurrence="x", requestCycle=4)["text"], expanded["text"])
        self.assertEqual(self.client.resolve("s", expanded["text"])["value"], source)

    def test_source_file_is_never_rewritten_and_old_snapshot_survives_edits(self):
        source = Path(self.temp.name) / "example.py"
        original = region(newline="\r\n")
        source.write_bytes(original.encode())
        first = self.client.read_source("s", path=str(source), occurrence="file", requestCycle=0, limit=24000)
        view = self.client.read_source("s", path=str(source), occurrence="file", requestCycle=1, limit=24000)
        self.assertTrue(view["foldedRegions"])
        self.assertEqual(source.read_bytes(), original.encode())
        source.write_text("replacement\n")
        archived = self.client.read("s", first["id"], limit=24000)
        self.assertEqual(archived["text"], view["text"])
        self.assertEqual(archived["sha256"], hashlib.sha256(original.encode()).hexdigest())
        self.assertEqual(self.client.resolve("s", first["reference"])["value"], original)

    def test_batch_occurrences_age_independently(self):
        files = [{"text": region(label="left"), "language": "python"},
                 {"text": region(body="other = 2\n" * 60, label="right"), "language": "python"}]
        first = self.client.read_source("s", files=files, occurrence="batch", requestCycle=10)
        self.assertTrue(all(not f["foldedRegions"] for f in first["files"]))
        retry = self.client.read_source("s", files=files, occurrence="batch", requestCycle=10)
        self.assertTrue(all(not f["foldedRegions"] for f in retry["files"]))
        folded = self.client.read_source("s", files=files, occurrence="batch", requestCycle=11)
        self.assertTrue(all(f["foldedRegions"] for f in folded["files"]))
        fresh = self.client.read_source("s", files=files, occurrence="fresh-batch", requestCycle=12)
        self.assertTrue(all(not f["foldedRegions"] for f in fresh["files"]))

    def test_lower_new_write_quota_does_not_block_original_recovery(self):
        stored = self.client.annotate("s", text=region(), language="python")
        view = self.client.read("s", stored["id"], limit=24000)
        with Client(self.path, config={"folding": {"max_session_bytes": 1}}) as tiny:
            before = self.state()
            self.assertEqual(tiny.read("s", stored["id"], limit=24000), view)
            self.assertEqual(self.state(), before)
            self.assertEqual(tiny.resolve("s", stored["reference"])["value"], region())
            destination = Path(self.temp.name) / "recovered.py"
            tiny.call({"action": "paste", "scope": "s", "id": stored["id"], "path": str(destination)})
            self.assertEqual(destination.read_text(), region())
            with self.assertRaises(FoldingError):
                tiny.put("s", "new archived content")

    def test_archive_failure_cannot_publish_a_folded_view(self):
        before = self.state()
        with Client(self.path, config={"folding": {"max_session_bytes": 1, "delay_requests": 0}}) as tiny:
            with self.assertRaises(FoldingError) as raised:
                tiny.read_source("s", text=region(), language="python")
            self.assertEqual(raised.exception.code, "quota")
        self.assertEqual(self.state(), before)

    def test_removed_mark_group_and_source_marks_are_rejected_atomically(self):
        item = self.client.put("s", "evidence " * 50)
        before = self.state()
        for request in ({"action": "mark", "id": item["id"], "disposition": "foldable", "summary": "s"},
                        {"action": "group", "ids": [item["id"]], "summary": "s"},
                        {"action": "read-source", "text": region(), "marks": []}):
            with self.assertRaises(FoldingError):
                self.client.call({**request, "scope": "s"})
            self.assertEqual(self.state(), before)

    def test_legacy_ast_regions_and_marks_cannot_bypass_annotations(self):
        source = "unmarked old evidence\n" * 100
        item = self.client.put("s", source)
        data = json.loads(self.state()[0][1])
        node = data["entries"][0]
        node["mark"] = {"disposition": "foldable", "summary": "old automatic summary"}
        node["annotation"] = {"language": "python", "parser": "python-ast", "limitations": [], "regions": []}
        self.client._db.execute("UPDATE scopes SET data=? WHERE scope='s'", (json.dumps(data),))
        self.client._db.commit()
        with Client(self.path, config={"folding": {"delay_requests": 0}}) as eager:
            self.assertEqual(eager.read("s", item["id"], limit=24000)["text"], source)
            self.assertFalse(eager.render("s", [item["id"]])["entries"][0]["folded"])
            self.assertEqual(eager.resolve("s", item["reference"])["value"], source)


if __name__ == "__main__":
    unittest.main()
