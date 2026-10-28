import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PLUGIN = Path(__file__).resolve().parents[1]
SCRIPT = PLUGIN / "scripts/post-compact.py"


class PostCompactionCliTests(unittest.TestCase):
    def test_direct_entry_point_needs_no_package_or_working_directory(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=json.dumps({"hook_event_name": "SessionStart", "source": "compact"}),
            text=True, capture_output=True, cwd="/tmp", timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("additionalContext", json.loads(result.stdout)["hookSpecificOutput"])

    def test_cli_entry_points_print_the_fixed_reminder_without_opening_archive(self):
        state = b"leave this file unchanged"
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "state.sqlite3"
            state_path.write_bytes(state)
            env = {**os.environ, "PYTHONPATH": str(PLUGIN / "python"), "CTXF_STATE": str(state_path)}
            for entry in ("ctxf_main", "main"):
                command = (
                    f"from context_folding.cli import {entry}; "
                    f"raise SystemExit({entry}(['post-compact']))"
                )
                result = subprocess.run(
                    [sys.executable, "-c", command],
                    text=True, capture_output=True, cwd=directory, env=env, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("刚刚发生了上下文压缩", result.stdout)
                self.assertIn("已知结论、约束、失败和下一步", result.stdout)
                self.assertTrue(result.stdout.endswith("\n"))
                self.assertEqual(state_path.read_bytes(), state)


if __name__ == "__main__":
    unittest.main()
