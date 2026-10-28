"""Small stdlib verifier runner, copied into each self-contained smoke task."""

import argparse
import json
import os
import pwd
import subprocess
import sys
import tempfile
from pathlib import Path


def assert_json_equal(actual, expected):
    """Preserve distinctions such as false versus zero and 1.0 versus 1."""
    options = {"ensure_ascii": False, "sort_keys": True, "separators": (",", ":")}
    if json.dumps(actual, **options) != json.dumps(expected, **options):
        raise AssertionError("JSON result does not match the independent expectation")


class Checks:
    def __init__(self, app, sandbox):
        self.app = app
        self.sandbox = sandbox
        self.results = []

    def check(self, name, operation):
        try:
            operation()
        except Exception as error:
            self.results.append({"name": name, "passed": False, "error": f"{type(error).__name__}: {error}"[:500]})
        else:
            self.results.append({"name": name, "passed": True})

    def artifact(self, relative, expected):
        path = self.app / relative
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1_000_000:
            raise AssertionError("required output is absent, not a regular file, or too large")
        assert_json_equal(json.loads(path.read_text(encoding="utf-8")), expected)

    def execute(self, script, arguments, files, expected=None, invalid=False):
        """Run a submitted CLI; never import it into the root verifier process."""
        with tempfile.TemporaryDirectory(prefix="harbor-smoke-case-") as location:
            directory = Path(location)
            identity = {}
            if self.sandbox:
                if os.geteuid() != 0:
                    raise RuntimeError("sandbox verifier must start as root")
                account = pwd.getpwnam("agent")
                os.chown(directory, account.pw_uid, account.pw_gid)
                identity = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}
            original = {}
            for name, value in files.items():
                payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                target = directory / name
                target.write_text(payload, encoding="utf-8")
                original[name] = target.read_bytes()
            output = directory / "nested" / "result.json"
            command = [sys.executable, "-I", str(self.app / script)]
            command.extend(str(directory / arg[1:]) if arg.startswith("@") else arg for arg in arguments)
            command.append(str(output))
            completed = subprocess.run(
                command,
                cwd=directory,
                env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
                capture_output=True,
                text=True,
                timeout=3,
                **identity,
            )
            for name, payload in original.items():
                if (directory / name).read_bytes() != payload:
                    raise AssertionError("submitted program changed an input file")
            if invalid:
                if completed.returncode == 0 or output.exists():
                    raise AssertionError("invalid input must fail without creating output")
            else:
                if completed.returncode != 0:
                    raise AssertionError(f"submitted program exited {completed.returncode}: {completed.stderr[:300]}")
                if output.is_symlink() or not output.is_file() or output.stat().st_size > 1_000_000:
                    raise AssertionError("program did not create a regular bounded output file")
                assert_json_equal(json.loads(output.read_text(encoding="utf-8")), expected)


def main(run_checks):
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-dir", type=Path, default=Path("/app"))
    parser.add_argument("--log-dir", type=Path, default=Path("/logs/verifier"))
    parser.add_argument("--sandbox", action="store_true")
    args = parser.parse_args()
    args.log_dir.mkdir(parents=True, exist_ok=True)
    reward = args.log_dir / "reward.txt"
    reward.write_text("0\n", encoding="utf-8")
    checks = Checks(args.app_dir.resolve(), args.sandbox)
    try:
        run_checks(checks)
    except Exception as error:
        checks.results.append({"name": "verifier_exception", "passed": False, "error": f"{type(error).__name__}: {error}"[:500]})
    passed = bool(checks.results) and all(item["passed"] for item in checks.results)
    details = {"reward": int(passed), "checks": checks.results, "sandbox": args.sandbox}
    (args.log_dir / "checks.json").write_text(json.dumps(details, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    reward.write_text("1\n" if passed else "0\n", encoding="utf-8")
    print(json.dumps({"reward": int(passed), "passed": sum(item["passed"] for item in checks.results), "total": len(checks.results)}))
    return 0 if passed else 1
