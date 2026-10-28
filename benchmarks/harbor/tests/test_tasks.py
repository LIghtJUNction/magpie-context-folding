"""Component checks for the synthetic Harbor tasks; these do not run containers.

Run with Python 3.12:
    python -m unittest discover -s benchmarks/harbor/tests -p test_tasks.py -v

Oracle and verifier subprocesses run in temporary directories. A passing result
here verifies task logic, not Docker isolation, Harbor orchestration, or a model.
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


TASKS = Path(__file__).resolve().parents[1] / "tasks"
SCRIPTS = {"ledger-reconciliation": "ledger.py", "config-precedence": "resolve_config.py"}
OUTPUTS = {"ledger-reconciliation": "report.json", "config-precedence": "effective.json"}


class SyntheticTaskTests(unittest.TestCase):
    def make_app(self, task, directory):
        app = directory / "app"
        shutil.copytree(task / "environment" / "app", app)
        (app / "output").mkdir(exist_ok=True)
        return app

    def oracle(self, task, app):
        environment = {
            "APP_DIR": str(app),
            "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        result = subprocess.run(["bash", str(task / "solution" / "solve.sh")], env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def verify(self, task, app, log_dir):
        result = subprocess.run(
            [sys.executable, str(task / "tests" / "verify.py"), "--app-dir", str(app), "--log-dir", str(log_dir)],
            env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, timeout=20,
        )
        self.assertTrue((log_dir / "reward.txt").is_file(), result.stderr)
        reward = (log_dir / "reward.txt").read_text().strip()
        self.assertIn(reward, {"0", "1"})
        details = json.loads((log_dir / "checks.json").read_text())
        self.assertFalse(details["sandbox"], "Component test must not claim sandbox isolation.")
        self.assertEqual(details["reward"], int(reward))
        self.assertEqual(result.returncode, 0 if reward == "1" else 1, result.stderr)
        return reward, details

    def test_task_layout_and_python_syntax(self):
        for name in SCRIPTS:
            task = TASKS / name
            with self.subTest(task=name):
                for relative in ["task.toml", "instruction.md", "environment/Dockerfile", "solution/solve.sh", "tests/test.sh", "tests/verify.py", "tests/runner.py"]:
                    self.assertTrue((task / relative).is_file(), relative)
                config = tomllib.loads((task / "task.toml").read_text())
                self.assertEqual(config["schema_version"], "1.4")
                self.assertEqual(config["verifier"]["environment_mode"], "separate")
                self.assertEqual(config["agent"]["user"], "agent")
                self.assertEqual(config["environment"]["network_mode"], "no-network")
                self.assertEqual(config["artifacts"], [f"/app/{SCRIPTS[name]}", "/app/output"])
                for source in task.rglob("*.py"):
                    ast.parse(source.read_text(), filename=str(source))

    def test_real_harbor_task_schema_when_installed(self):
        try:
            from harbor.models.task.config import TaskConfig
            from harbor.models.task.task import Task
        except ImportError:
            self.skipTest("Harbor is not installed; component logic tests still run.")
        for name in SCRIPTS:
            with self.subTest(task=name):
                path = TASKS / name
                parsed = TaskConfig.model_validate_toml((path / "task.toml").read_text())
                loaded = Task(path)
                self.assertEqual(parsed.schema_version, loaded.config.schema_version)
                self.assertEqual(parsed.schema_version, "1.4")

    def test_oracle_controls_pass_all_independent_checks(self):
        for name in SCRIPTS:
            with self.subTest(task=name), tempfile.TemporaryDirectory(prefix="magpie-task-oracle-") as location:
                task, directory = TASKS / name, Path(location)
                app = self.make_app(task, directory)
                self.oracle(task, app)
                reward, details = self.verify(task, app, directory / "logs")
                self.assertEqual(reward, "1", json.dumps(details, indent=2))
                self.assertGreaterEqual(len(details["checks"]), 10)

    def test_untouched_starter_controls_fail(self):
        for name in SCRIPTS:
            with self.subTest(task=name), tempfile.TemporaryDirectory(prefix="magpie-task-nop-") as location:
                task, directory = TASKS / name, Path(location)
                app = self.make_app(task, directory)
                reward, details = self.verify(task, app, directory / "logs")
                self.assertEqual(reward, "0", details)
                self.assertFalse(details["checks"][0]["passed"])

    def test_hardcoding_public_output_does_not_pass(self):
        for name, script in SCRIPTS.items():
            with self.subTest(task=name), tempfile.TemporaryDirectory(prefix="magpie-task-hardcoded-") as location:
                task, directory = TASKS / name, Path(location)
                app = self.make_app(task, directory)
                self.oracle(task, app)
                known_output = (app / "output" / OUTPUTS[name]).read_text()
                (app / script).write_text(
                    "import sys\nfrom pathlib import Path\n"
                    "target = Path(sys.argv[-1])\n"
                    "target.parent.mkdir(parents=True, exist_ok=True)\n"
                    f"target.write_text({known_output!r}, encoding='utf-8')\n"
                )
                reward, details = self.verify(task, app, directory / "logs")
                self.assertEqual(reward, "0", details)
                self.assertTrue(details["checks"][0]["passed"], "Public artifact alone must be insufficient.")

    def test_crashing_submission_still_writes_zero_reward(self):
        for name, script in SCRIPTS.items():
            with self.subTest(task=name), tempfile.TemporaryDirectory(prefix="magpie-task-crash-") as location:
                task, directory = TASKS / name, Path(location)
                app = self.make_app(task, directory)
                (app / script).write_text("raise RuntimeError('intentional verifier-control failure')\n")
                reward, details = self.verify(task, app, directory / "logs")
                self.assertEqual(reward, "0", details)


if __name__ == "__main__":
    unittest.main()
