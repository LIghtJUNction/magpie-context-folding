"""Exercise wire formats using the actual package and SQLite core."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
MAX_INPUT_BYTES = 8 * 1024 * 1024


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"


def initialize(version="2025-11-25", request_id=1):
    return {"jsonrpc": "2.0", "id": request_id, "method": "initialize", "params": {
        "protocolVersion": version, "capabilities": {},
        "clientInfo": {"name": "transport-test", "version": "1"},
    }}


def mcp_call(request_id, arguments):
    return {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": {
        "name": "context_folding", "arguments": arguments,
    }}


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = str(Path(self.tmp.name) / "state")
        self.env = dict(os.environ)
        self.env["PYTHONPATH"] = str(PACKAGE / "python")

    def run_cli(self, command, data=b"", *args):
        result = subprocess.run(
            [sys.executable, "-m", "context_folding", command, "--state", self.state, *args],
            input=data, capture_output=True, env=self.env, cwd=PACKAGE, timeout=30,
        )
        self.assertEqual(result.stderr, b"", result.stderr.decode(errors="replace"))
        # Every stdout line must be JSON, with no banners or Content-Length.
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        return result.returncode, replies

    def test_call_put_stdin_and_read_persistent_state(self):
        text = "exact original\n第二行\n"
        code, replies = self.run_cli("put", text.encode(), "--scope", "test")
        self.assertEqual(code, 0)
        entry_id = replies[0]["result"]["id"]
        code, replies = self.run_cli("call", encoded({
            "action": "read", "scope": "test", "id": entry_id,
        }))
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["result"]["text"], text)

    def test_source_cli_batch_expansion_recovery_and_project_configuration(self):
        source = "def alpha():\r\n" + "".join(f"    value_{n} = {n}\r\n" for n in range(25))
        path = Path(self.tmp.name) / "source.py"
        path.write_bytes(source.encode())
        code, replies = self.run_cli("read-source", b"", "--scope", "test", "--path", str(path))
        self.assertEqual(code, 0, replies)
        view = replies[0]["result"]
        self.assertEqual(view["mode"], "folded")
        self.assertNotIn("value_24", view["text"])
        code, replies = self.run_cli("read", b"", "--scope", "test", "--id", view["id"], "--expand", "alpha")
        self.assertEqual(code, 0, replies)
        self.assertEqual(replies[0]["result"]["text"], source)
        code, replies = self.run_cli("read-source", b"", "--scope", "test", "--files", json.dumps([
            {"path": str(path)}, {"text": "const value = 1;", "language": "typescript"}]))
        self.assertEqual(code, 0, replies)
        self.assertEqual(len(replies[0]["result"]["files"]), 2)
        self.assertEqual(path.read_bytes(), source.encode())
        project = Path(self.tmp.name) / "project"
        project.mkdir()
        (project / ".context-folding.toml").write_text("version = 1\n[annotations]\ndefault_fold = false\n")
        for placement in ("before", "after"):
            args = ["--project-dir", str(project)]
            command = [sys.executable, "-m", "context_folding"]
            command += args + ["read"] if placement == "before" else ["read"] + args
            result = subprocess.run(command + ["--state", self.state, "--scope", "test", "--id", view["id"]],
                capture_output=True, env=self.env, cwd=PACKAGE, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual(json.loads(result.stdout)["result"]["text"], source)
        (project / ".context-folding.toml").write_text("[annotations]\ndefault_fold = 'invalid'\n")
        code, replies = self.run_cli("status", b"", "--scope", "test", "--project-dir", str(project))
        self.assertEqual(code, 1)
        self.assertEqual(replies[0]["error"]["code"], "config")

    def test_action_json_and_single_call_error_exit(self):
        code, replies = self.run_cli("put", b"", "--scope", "test", "--json", '{"text":"hello","role":"tool"}')
        self.assertEqual(code, 0)
        self.assertIn("id", replies[0]["result"])
        code, replies = self.run_cli("call", b"", "--json", '{"action":"unknown","scope":"test"}')
        self.assertEqual(code, 1)
        self.assertIsInstance(replies[0]["error"]["code"], str)

    def test_action_flags_match_core_and_export_body_stdin(self):
        code, replies = self.run_cli("put", "A😀BC".encode(), "--scope", "test")
        self.assertEqual(code, 0)
        entry_id = replies[0]["result"]["id"]
        code, replies = self.run_cli("mark", b"", "--scope", "test", "--marks", json.dumps([
            {"id": entry_id, "disposition": "keep"},
        ]))
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["result"]["marked"], 1)
        code, replies = self.run_cli("read", b"", "--scope", "test", "--id", entry_id, "--offset", "1", "--limit", "1")
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["result"]["text"], "😀")
        code, replies = self.run_cli("roots", b"", "--scope", "test", "--ids")
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["result"]["roots"], [])
        code, replies = self.run_cli("gc", b"", "--scope", "test", "--mode", "configure", "--config", '{"strength":"off"}')
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["result"]["config"]["strength"], "off")
        skill_path = Path(self.tmp.name) / "exported-skill"
        body = "Use this explicitly written procedure.\n"
        code, replies = self.run_cli("skills", body.encode(), "--scope", "test", "--mode", "export",
            "--id", entry_id, "--name", "exported-skill", "--description", "Reviewed procedure",
            "--path", str(skill_path), "--body", "-")
        self.assertEqual(code, 0, replies)
        self.assertIn(body, (skill_path / "SKILL.md").read_text())

    def test_cli_rejects_multiple_stdin_consumers(self):
        code, replies = self.run_cli("put", b'{"text":"original"}', "--scope", "test", "--json", "-", "--text", "-")
        self.assertEqual(code, 1)
        self.assertEqual(replies[0]["error"]["code"], "invalid_request")

    def test_rpc_errors_preserve_process_and_do_not_echo_input(self):
        requests = b"private-secret invalid JSON\n\xff\n" + encoded([]) + encoded({"action": "unknown", "scope": "test"}) + encoded({"action": "put", "scope": "test", "text": "ok"})
        code, replies = self.run_cli("rpc", requests)
        self.assertEqual(code, 0)
        self.assertEqual(len(replies), 5)
        self.assertEqual(replies[0]["error"]["code"], "invalid_json")
        self.assertEqual(replies[1]["error"]["code"], "invalid_json")
        self.assertEqual(replies[2]["error"]["code"], "invalid_request")
        self.assertIn("error", replies[3])
        self.assertIn("id", replies[4]["result"])
        self.assertNotIn("private-secret", json.dumps(replies))

    def test_rpc_rejects_nonstandard_numbers_and_accepts_crlf_and_eof(self):
        code, replies = self.run_cli("rpc", b'{"action":"put","scope":"test","text":NaN}\n' + b'{"action":"status","scope":"test"}\r\n' + b'{"action":"list","scope":"test"}')
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["error"]["code"], "invalid_json")
        self.assertIn("result", replies[1])
        self.assertIn("result", replies[2])

    def test_rpc_drains_oversized_line_and_reads_next_request(self):
        code, replies = self.run_cli("rpc", b"x" * (MAX_INPUT_BYTES + 123456) + b"\n" + encoded({"action": "status", "scope": "test"}))
        self.assertEqual(code, 0)
        self.assertEqual(len(replies), 2)
        self.assertEqual(replies[0]["error"]["code"], "input_too_large")
        self.assertIn("result", replies[1])

    def test_mcp_initialize_negotiate_notifications_ping_and_list(self):
        for version in ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "future"):
            with self.subTest(version=version):
                requests = [initialize(version),
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "method": "unknown/notification"},
                    {"jsonrpc": "2.0", "id": 2, "method": "ping"},
                    {"jsonrpc": "2.0", "id": "list", "method": "tools/list"}]
                code, replies = self.run_cli("mcp", b"".join(map(encoded, requests)))
                self.assertEqual(code, 0)
                self.assertEqual(len(replies), 3)
                expected = version if version != "future" else "2025-11-25"
                self.assertEqual(replies[0]["result"]["protocolVersion"], expected)
                self.assertEqual(replies[1], {"jsonrpc": "2.0", "id": 2, "result": {}})
                tools = replies[2]["result"]["tools"]
                self.assertEqual([tool["name"] for tool in tools], ["context_folding"])
                self.assertEqual(tools[0]["inputSchema"]["required"], ["action", "scope"])
                for action in ("resolve", "gc", "roots", "pin", "skills"):
                    self.assertIn(action, tools[0]["inputSchema"]["properties"]["action"]["enum"])

    def test_mcp_tool_application_errors_and_success_are_content(self):
        requests = [initialize(), mcp_call(2, {"action": "unknown", "scope": "test"}),
            mcp_call(3, {"action": "put", "scope": "test", "text": "original"}),
            mcp_call(4, {}),
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "other", "arguments": {}}}]
        code, replies = self.run_cli("mcp", b"".join(map(encoded, requests)))
        self.assertEqual(code, 0)
        failure = replies[1]["result"]
        self.assertTrue(failure["isError"])
        self.assertIn("error", json.loads(failure["content"][0]["text"]))
        success = replies[2]["result"]
        self.assertFalse(success["isError"])
        self.assertIn("id", json.loads(success["content"][0]["text"]))
        self.assertTrue(replies[3]["result"]["isError"])
        self.assertEqual(replies[4]["error"]["code"], -32602)

    def test_mcp_invalid_frames_and_envelopes(self):
        frames = [b"secret-invalid\n", b"\xff\n", encoded([]),
            encoded({"jsonrpc": "1.0", "id": 1, "method": "ping"}),
            encoded({"jsonrpc": "2.0", "id": True, "method": "ping"}),
            encoded(initialize()),
            encoded({"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": []}),
            encoded({"jsonrpc": "2.0", "id": 8, "method": "unknown"}),
            encoded({"jsonrpc": "2.0", "id": 9, "method": "ping"})]
        code, replies = self.run_cli("mcp", b"".join(frames))
        self.assertEqual(code, 0)
        self.assertEqual([reply["error"]["code"] for reply in replies[:5]], [-32700, -32700, -32600, -32600, -32600])
        self.assertEqual(replies[6]["error"]["code"], -32602)
        self.assertEqual(replies[7]["error"]["code"], -32601)
        self.assertEqual(replies[8]["result"], {})
        self.assertNotIn("secret-invalid", json.dumps(replies))

    def test_mcp_oversized_frame_then_success(self):
        code, replies = self.run_cli("mcp", b"x" * (MAX_INPUT_BYTES + 1024) + b"\n" + encoded(initialize()))
        self.assertEqual(code, 0)
        self.assertEqual(len(replies), 2)
        self.assertEqual(replies[0]["error"]["code"], -32600)
        self.assertIn("protocolVersion", replies[1]["result"])

    def test_notification_does_not_mutate_archive(self):
        notification = mcp_call(2, {"action": "put", "scope": "test", "text": "must not run"})
        del notification["id"]
        code, replies = self.run_cli("mcp", encoded(initialize()) + encoded(notification))
        self.assertEqual(code, 0)
        self.assertEqual(len(replies), 1)
        code, replies = self.run_cli("call", encoded({"action": "list", "scope": "test"}))
        self.assertEqual(code, 0)
        self.assertNotIn("must not run", json.dumps(replies))


if __name__ == "__main__":
    unittest.main()
