"""The reminder command must work without opening an archive or consuming stdin."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from context_folding.post_compaction import POST_COMPACTION_REMINDER


PACKAGE = Path(__file__).resolve().parents[1]


class PostCompactionCLITests(unittest.TestCase):
    def test_real_cli_entry_points_print_only_the_reminder_without_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            # Invalid configuration and an unusable archive path must not matter.
            (project / ".context-folding.toml").write_text("not valid toml [", encoding="utf-8")
            env = {**os.environ, "PYTHONPATH": str(PACKAGE / "python"),
                   "CTXF_STATE": str(project), "XDG_DATA_HOME": str(project / "unused-data"),
                   "XDG_CONFIG_HOME": str(project / "unused-config")}
            commands = [
                ["-c", "from context_folding.cli import ctxf_main; raise SystemExit(ctxf_main())"],
                ["-m", "context_folding"],
            ]
            for entry in commands:
                with self.subTest(entry=entry):
                    result = subprocess.run([sys.executable, *entry, "post-compact"],
                        input=b"private input must not be echoed or folded", capture_output=True,
                        env=env, cwd=project, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, b"")
                    self.assertEqual(result.stdout.decode("utf-8"), POST_COMPACTION_REMINDER + "\n")
            self.assertEqual(sorted(p.name for p in project.iterdir()), [".context-folding.toml"])

    def test_command_help_describes_host_injection_without_requiring_state(self):
        result = subprocess.run([sys.executable, "-m", "context_folding", "post-compact", "--help"],
            capture_output=True, env={**os.environ, "PYTHONPATH": str(PACKAGE / "python")},
            cwd=PACKAGE, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"host", result.stdout)
        self.assertIn(b"inject", result.stdout)


if __name__ == "__main__":
    unittest.main()
