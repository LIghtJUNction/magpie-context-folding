import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from context_folding.post_compaction import POST_COMPACTION_REMINDER


PLUGIN = Path(__file__).resolve().parents[1]
SCRIPT = PLUGIN / "scripts/post-compact.py"


class PostCompactionTests(unittest.TestCase):
    def run_hook(self, payload, *, raw=False, cwd=None, env=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=payload if raw else json.dumps(payload),
            text=True, capture_output=True, cwd=cwd, env=env, timeout=10,
        )

    def test_registered_compact_hook_delivers_model_context(self):
        config = json.loads((PLUGIN / "hooks/hooks.json").read_text())
        hooks = [hook for rule in config["hooks"]["SessionStart"]
                 if rule.get("matcher") == "compact" for hook in rule["hooks"]]
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0]["type"], "command")
        # Exercise the configured shell command, including CLAUDE_PLUGIN_ROOT.
        result = subprocess.run(
            hooks[0]["command"], shell=True,
            input=json.dumps({"hook_event_name": "SessionStart", "source": "compact"}),
            text=True, capture_output=True,
            env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(PLUGIN)},
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {"hookSpecificOutput"})
        details = output["hookSpecificOutput"]
        self.assertEqual(details["hookEventName"], "SessionStart")
        prompt = details["additionalContext"]
        self.assertEqual(prompt, POST_COMPACTION_REMINDER)
        self.assertIn("magpie-context-folding", prompt)
        self.assertIn("<!-- @context-fold begin LABEL -->", prompt)
        self.assertIn("<!-- @context-fold end LABEL -->", prompt)
        self.assertIn("兜底压缩", prompt)
        self.assertIn("当前结论、用户约束和待办留在标记外", prompt)

    def test_unrelated_and_malformed_events_are_silent(self):
        cases = [None, [], "compact", 1, True, {},
                 {"hook_event_name": "SessionStart"}, {"source": "compact"},
                 {"hook_event_name": ["SessionStart"], "source": "compact"},
                 {"hook_event_name": "SessionStart", "source": ["compact"]}]
        cases.extend({"hook_event_name": "SessionStart", "source": source}
                     for source in ("startup", "resume", "clear", "fork", "Compact", " compact ", None))
        cases.extend({"hook_event_name": name, "source": "compact", "trigger": "auto"}
                     for name in ("PreCompact", "PostCompact", "PostToolUse", "Stop"))
        for payload in cases:
            with self.subTest(payload=payload):
                result = self.run_hook(payload)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        for payload in ("", " ", "{broken", "{}\n{}", "[" * 2000 + "]" * 2000):
            with self.subTest(raw=payload):
                result = self.run_hook(payload, raw=True)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_hook_uses_portable_json_without_site_packages(self):
        result = subprocess.run([sys.executable, "-S", str(SCRIPT)],
            input=b'{"hook_event_name":"SessionStart","source":"compact"}',
            capture_output=True, env={**os.environ, "PYTHONIOENCODING": "ascii"}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        output = json.loads(result.stdout.decode("ascii"))
        self.assertEqual(output["hookSpecificOutput"]["additionalContext"], POST_COMPACTION_REMINDER)

    def test_no_archive_binding_or_writable_state_is_needed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unusable = root / "not-a-directory"
            unusable.write_text("unchanged")
            env = {**os.environ, "XDG_STATE_HOME": str(unusable), "XDG_DATA_HOME": str(unusable),
                   "XDG_CONFIG_HOME": str(unusable), "CTXF_STATE": str(unusable),
                   "CLAUDE_ENV_FILE": str(unusable / "env"), "CONTEXT_FOLDING_READ_BINDING": ""}
            env.pop("PYTHONPATH", None)
            payload = {"hook_event_name": "SessionStart", "source": "compact",
                       "session_id": "different-session", "compact_summary": "untrusted summary must not be echoed"}
            for _ in range(2):
                result = self.run_hook(payload, cwd=directory, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"],
                                 POST_COMPACTION_REMINDER)
                self.assertNotIn(payload["compact_summary"], result.stdout)
            self.assertEqual(list(root.iterdir()), [unusable])
            self.assertEqual(unusable.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
