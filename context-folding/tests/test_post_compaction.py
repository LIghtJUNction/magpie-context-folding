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
        result = subprocess.run(
            hooks[0]["command"], shell=True,
            input=json.dumps({"hook_event_name": "SessionStart", "source": "compact"}),
            text=True, capture_output=True,
            env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(PLUGIN)}, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        details = output["hookSpecificOutput"]
        self.assertEqual(details["hookEventName"], "SessionStart")
        self.assertEqual(details["additionalContext"], POST_COMPACTION_REMINDER)

    def test_unrelated_and_malformed_events_are_silent(self):
        cases = [None, [], "compact", 1, True, {},
                 {"hook_event_name": "SessionStart"}, {"source": "compact"}]
        cases.extend({"hook_event_name": "SessionStart", "source": source}
                     for source in ("startup", "resume", "clear", "fork", "Compact", None))
        for payload in cases:
            result = self.run_hook(payload)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        for payload in ("", " ", "{broken", "{}\n{}"):
            result = self.run_hook(payload, raw=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_hook_needs_no_archive_or_writable_state(self):
        with tempfile.TemporaryDirectory() as directory:
            unusable = Path(directory) / "not-a-directory"
            unusable.write_text("unchanged")
            env = {**os.environ, "XDG_STATE_HOME": str(unusable), "XDG_DATA_HOME": str(unusable),
                   "XDG_CONFIG_HOME": str(unusable), "CTXF_STATE": str(unusable)}
            result = self.run_hook({"hook_event_name": "SessionStart", "source": "compact"},
                                   cwd=directory, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"],
                             POST_COMPACTION_REMINDER)
            self.assertEqual(unusable.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
