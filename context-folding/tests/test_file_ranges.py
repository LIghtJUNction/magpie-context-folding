"""Observable file recovery and arbitrary conversation/text boundaries."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from context_folding import Client, FoldingError
from context_folding.config import ConfigError, load_config


class FileRangeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ctxf-"中文-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / ".git").mkdir()
        self.state = self.directory / "archive.sqlite"
        self.client = Client(self.state, project_dir=self.directory)
        self.addCleanup(self.client.close)

    def records(self):
        return self.client._db.execute("SELECT scope, data FROM scopes ORDER BY scope").fetchall()

    def test_half_message_unicode_range_and_file_recovery_without_database(self):
        original = "保留前半🙂\r\n要折叠的内容🙂\r\n保留后半"
        start, end = original.index("要"), original.index("保留后")
        result = self.client.fold("task", original, range={"start": start, "end": end})
        item = result["references"][0]
        self.assertEqual(result["text"], original[:start] + item["reference"] + original[end:])
        self.assertEqual(item["offsetUnit"], "unicode-code-points")
        self.assertIn(json.dumps(item["path"], ensure_ascii=False), result["text"])
        payload = original[start:end]
        self.assertEqual(Path(item["path"]).read_bytes(), payload.encode("utf-8"))
        self.assertEqual(item["sha256"], hashlib.sha256(payload.encode()).hexdigest())
        self.assertEqual(self.client.resolve("task", result["text"])["value"], original)
        self.assertEqual(Path(item["path"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(item["path"]).parent.stat().st_mode & 0o777, 0o700)
        database_copy = self.state.with_suffix(".removed")
        self.state.rename(database_copy)
        try:
            self.assertEqual(Path(item["path"]).read_bytes(), payload.encode())
        finally:
            database_copy.rename(self.state)

    def test_bad_ranges_never_mutate_state_or_input(self):
        for region in ({"start": 0, "end": 0}, {"start": -1, "end": 2}, {"start": 2, "end": 1},
                       {"start": True, "end": 3}, {"start": 0, "end": 99}, {"start": 0}, None):
            with self.subTest(region=region), self.assertRaises(FoldingError):
                self.client.fold("s", "甲🙂乙", range=region)
            self.assertEqual(self.records(), [])
        self.assertFalse(self.client.file_root.exists())

    def test_failed_file_write_or_quota_issues_no_reference_or_state(self):
        original = "a completed original"
        with patch("context_folding.files.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaises(FoldingError) as error:
                self.client.fold("s", original, range={"start": 0, "end": len(original)})
        self.assertEqual(error.exception.code, "storage")
        self.assertEqual(self.records(), [])
        self.assertFalse(list(self.client.file_root.rglob("*.txt")))
        self.assertFalse(list(self.client.file_root.rglob(".pending-*")))
        with Client(self.directory / "tiny.sqlite", project_dir=self.directory,
                    config={"folding": {"max_session_bytes": 1}}) as tiny:
            with self.assertRaises(FoldingError) as error:
                tiny.fold("s", original, range={"start": 0, "end": len(original)})
            self.assertEqual(error.exception.code, "quota")
            self.assertFalse(tiny.file_root.exists())

    def test_existing_corrupt_or_symlink_file_is_not_overwritten(self):
        source = "immutable original"
        options = {"range": {"start": 0, "end": len(source)}}
        result = self.client.fold("s", source, **options)
        path = Path(result["references"][0]["path"])
        before = self.records()
        path.write_text("tampered")
        with self.assertRaises(FoldingError):
            self.client.fold("s", source, **options)
        self.assertEqual(path.read_text(), "tampered")
        self.assertEqual(self.records(), before)
        path.unlink()
        target = self.directory / "unrelated.txt"
        target.write_text(source)
        path.symlink_to(target)
        with self.assertRaises(FoldingError):
            self.client.fold("s", source, **options)
        self.assertEqual(target.read_text(), source)
        self.assertTrue(path.is_symlink())

    def test_v3_path_is_data_and_legacy_references_still_resolve(self):
        text = "stable historical material"
        result = self.client.fold("s", text, range={"start": 0, "end": len(text)})
        item = result["references"][0]
        for reference in (item["reference"], f"[[cf:v2:{item['id']}]]", f"[[cf:v1:{item['archiveId']}]]",
                          f'[[cf:v3:{item["id"]} path="/does/not/exist"]]'):
            self.assertEqual(self.client.resolve("s", reference)["value"], text)
        for reference in (f"[[cf:v3:{item['id']}]]", f'[[cf:v2:{item["id"]} path="/tmp/file"]]'):
            with self.assertRaises(FoldingError):
                self.client.resolve("s", reference)
        with self.assertRaises(FoldingError):
            self.client.resolve("other", item["reference"])

    def test_legacy_sqlite_read_survives_unwritable_sidecar_storage(self):
        original = "a legacy original still in SQLite\r\n中文🙂"
        item = self.client.put("legacy", original)
        Path(item["path"]).unlink()
        row = self.client._db.execute("SELECT data FROM scopes WHERE scope='legacy'").fetchone()
        snapshot = json.loads(row[0])
        snapshot["entries"][0].pop("path", None)
        self.client._db.execute("UPDATE scopes SET data=? WHERE scope='legacy'", (json.dumps(snapshot),))
        self.client._db.commit()
        with patch("context_folding.files.publish", side_effect=OSError("disk full")):
            result = self.client.read("legacy", item["id"])
            self.assertEqual(result["text"], original)
            self.assertEqual(result["fileStatus"], "unavailable")
            self.assertNotIn("path", result)
            self.assertEqual(self.client.resolve("legacy", item["reference"])["value"], original)
        row = self.client._db.execute("SELECT data FROM scopes WHERE scope='legacy'").fetchone()
        self.assertNotIn("path", json.loads(row[0])["entries"][0])
        self.assertEqual(Path(self.client.read("legacy", item["id"])["path"]).read_bytes(), original.encode())

    def test_cross_turn_range_is_one_user_message_with_exact_file_rows(self):
        messages = [{"role": "user", "content": "第一轮问题🙂"},
                    {"role": "assistant", "content": "第一轮详细答复\r\n第二行", "name": "helper"},
                    {"role": "user", "content": "第二轮问题"},
                    {"role": "assistant", "content": "第二轮答复"},
                    {"role": "user", "content": "下一步"}]
        original = deepcopy(messages)
        region = {"start": {"message": 0}, "end": {"message": 4}}
        result = self.client.fold_messages("s", messages, range=region)
        self.assertEqual(messages, original)
        self.assertEqual([m["role"] for m in result["messages"]], ["user", "user"])
        self.assertEqual(result["messages"][1], original[4])
        item = result["references"][0]
        rows = [json.loads(line) for line in Path(item["messagesPath"]).read_text().splitlines()]
        self.assertEqual([row["message"] for row in rows], original[:4])
        self.assertEqual([row["messageIndex"] for row in rows], [0, 1, 2, 3])
        self.assertEqual(hashlib.sha256(Path(item["messagesPath"]).read_bytes()).hexdigest(), item["sha256"])
        transcript = Path(item["path"]).read_bytes()
        self.assertIn(original[1]["content"].encode(), transcript)
        self.assertIn(b"role=assistant", transcript)
        self.assertIn("lightweight subagent", result["messages"][0]["content"])
        self.assertIn(json.dumps(item["path"], ensure_ascii=False), result["messages"][0]["content"])
        repeated = self.client.fold_messages("s", messages, range=region)
        self.assertEqual(repeated, result)
        self.assertEqual(self.client.read("s", item["id"])["text"], Path(item["messagesPath"]).read_text())
        # The JSONL itself may be read as text and folded later. It must not
        # collide with the transcript representation of the same message ID.
        manifest = Path(item["messagesPath"]).read_text()
        text_fold = self.client.fold("s", manifest, range={"start": 0, "end": len(manifest)})
        self.assertNotEqual(text_fold["references"][0]["path"], item["path"])
        self.assertEqual(Path(text_fold["references"][0]["path"]).read_text(), manifest)
        self.assertEqual(Path(item["path"]).read_bytes(), transcript)

    def test_mid_message_to_mid_message_preserves_both_boundaries_and_roles(self):
        messages = [{"role": "assistant", "content": "前🙂中间后", "name": "assistant-name"},
                    {"role": "user", "content": "问题细节"},
                    {"role": "assistant", "content": "答🙂结论保留"}]
        result = self.client.fold_messages("s", messages,
            range={"start": {"message": 0, "offset": 2}, "end": {"message": 2, "offset": 2}})
        self.assertEqual(result["messages"][0], {**messages[0], "content": "前🙂"})
        self.assertEqual(result["messages"][-1], {**messages[2], "content": "结论保留"})
        self.assertEqual([m["role"] for m in result["messages"]], ["assistant", "user", "assistant"])
        item = result["references"][0]
        rows = [json.loads(line) for line in Path(item["messagesPath"]).read_text().splitlines()]
        self.assertEqual([row["message"]["content"] for row in rows], ["中间后", "问题细节", "答🙂"])
        self.assertEqual((rows[0]["startOffset"], rows[-1]["endOffset"]), (2, 2))
        single = self.client.fold_messages("s", messages,
            range={"start": {"message": 0, "offset": 1}, "end": {"message": 0, "offset": 3}})
        self.assertEqual(single["messages"][0]["content"], "前")
        self.assertEqual(single["messages"][2]["content"], "间后")

    def test_tool_pairs_are_atomic_and_policy_messages_remain_present(self):
        messages = [{"role": "system", "content": "standing instructions"},
                    {"role": "assistant", "content": None,
                     "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "call-1", "content": "a result"},
                    {"role": "assistant", "content": "conclusion"}]
        before = deepcopy(messages)
        for start, end in ((1, 2), (2, 3), (0, 3)):
            with self.assertRaises(FoldingError):
                self.client.fold_messages("s", messages, range={"start": {"message": start}, "end": {"message": end}})
            self.assertEqual(self.records(), [])
            self.assertEqual(messages, before)
        result = self.client.fold_messages("s", messages,
            range={"start": {"message": 1}, "end": {"message": 3}})
        self.assertEqual([m["role"] for m in result["messages"]], ["system", "user", "assistant"])
        self.assertEqual(result["messages"][0], messages[0])
        with self.assertRaises(FoldingError):
            self.client.fold_messages("s", messages,
                range={"start": {"message": 1}, "end": {"message": 2, "offset": 3}})

    def test_equal_text_in_different_roles_has_distinct_message_identity(self):
        results = [self.client.fold_messages("s", [{"role": role, "content": "same words"}],
                    range={"start": {"message": 0}, "end": {"message": 1}}) for role in ("user", "assistant")]
        self.assertNotEqual(results[0]["references"][0]["id"], results[1]["references"][0]["id"])

    def test_source_reads_of_archive_files_never_refold_recovered_markers(self):
        body = "<!-- @context-fold begin old -->\r\n" + "历史原文🙂\r\n" * 100 + "<!-- @context-fold end old -->"
        plain = self.client.fold("s", body, range={"start": 0, "end": len(body)})["references"][0]
        conversation = self.client.fold_messages("s", [{"role": "assistant", "content": body}],
            range={"start": {"message": 0}, "end": {"message": 1}})["references"][0]
        alias = self.directory / "alias.txt"
        alias.symlink_to(plain["path"])
        for path in (plain["path"], conversation["path"], conversation["messagesPath"], str(alias)):
            expected = Path(path).read_bytes().decode("utf-8")
            with self.subTest(path=path), Client(self.state, project_dir=self.directory,
                    config={"folding": {"delay_requests": 0}}) as reader:
                view = reader.read_source("reader", path=path, limit=24000, mode="folded")
                self.assertEqual(view["text"], expected)
                self.assertEqual(view["foldedRegions"], [])
                self.assertTrue(view["recoveryData"])
                by_id = reader.read_source("reader", id=view["id"], limit=24000, mode="folded")
                self.assertEqual(by_id["text"], expected)
                self.assertEqual(by_id["foldedRegions"], [])
                self.assertEqual(reader.read("reader", view["id"], mode="folded", limit=24000)["text"], expected)
                self.assertEqual(reader.annotate("reader", path=path)["regions"], [])

    def test_file_access_configuration_and_removed_mcp_configuration(self):
        self.assertTrue(load_config(self.directory)["magpie"]["file_access"])
        self.assertFalse(load_config(self.directory, {"magpie": {"file_access": False}})["magpie"]["file_access"])
        with self.assertRaisesRegex(ConfigError, "removed"):
            load_config(self.directory, {"magpie": {"recovery_tool_name": "old_tool"}})


if __name__ == "__main__":
    unittest.main()
