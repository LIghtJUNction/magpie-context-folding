import json
from pathlib import Path
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()
