#!/usr/bin/env python3
"""Run offline checks on a writable Git worktree snapshot inside Linux bubblewrap.

Usage: python3 -I scripts/self-benchmark.py [--timeout 600] [--output result.json]
No dependency installation, model calls, CI, or fallback without bubblewrap.
Only Git-tracked and nonignored untracked files enter the snapshot; .git does not.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[1]
RECURSIVE_TESTS = {
    "typescript-recursive": ["test/tree.test.ts", "test/nested-query.test.ts", "test/recovery-tool.test.ts", "test/store.test.ts"],
    "python-core": ["context-folding/tests/test_expand_recursive.py", "context-folding/tests/test_nested_search.py"],
}


def git(project: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(project), *args], stderr=subprocess.PIPE)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def snapshot(project: Path, target: Path) -> dict:
    paths = sorted(set(git(project, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")) - {b""})
    dirty = set(git(project, "diff", "HEAD", "--name-only", "-z").split(b"\0"))
    dirty.update(git(project, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))
    manifest, changes = [], []
    for raw in paths:
        name = os.fsdecode(raw)
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
            raise ValueError(f"unsafe snapshot path: {name}")
        source, destination = project / name, target / name
        if not source.exists() and not source.is_symlink():
            if raw in dirty:
                changes.append({"path": name, "deleted": True})
            continue
        if source.is_symlink():
            # No symlink may expose files outside this source snapshot.
            if not source.resolve().is_relative_to(project) or os.path.isabs(os.readlink(source)):
                raise ValueError(f"snapshot symlink leaves repository: {name}")
            data = os.fsencode(os.readlink(source))
            kind = "symlink"
        elif source.is_file():
            data = source.read_bytes()
            kind = "file"
        else:
            raise ValueError(f"unsupported snapshot entry (submodule/directory): {name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if kind == "symlink":
            destination.symlink_to(os.readlink(source))
        else:
            destination.write_bytes(data)
            destination.chmod(source.stat().st_mode & 0o777)
        entry = {"path": name, "kind": kind, "bytes": len(data), "sha256": digest(data),
                 "mode": oct(source.lstat().st_mode & 0o777)}
        manifest.append(entry)
        if raw in dirty:
            changes.append(entry)
    return {"revision": git(project, "rev-parse", "HEAD").decode().strip(),
            "dirty": bool(changes), "dirty_files": changes,
            "diff_sha256": digest(git(project, "diff", "HEAD", "--binary")),
            "snapshot_files": len(manifest),
            "snapshot_bytes": sum(item["bytes"] for item in manifest),
            "snapshot_sha256": digest(json.dumps(manifest, sort_keys=True).encode())}


def safe_dependency_tree(path: Path) -> None:
    if not path.is_dir() or path.is_symlink():
        raise ValueError(f"missing dependency directory or external directory link: {path}")
    for parent, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            child = Path(parent) / name
            if child.is_symlink() and not child.resolve().is_relative_to(path):
                raise ValueError(f"dependency symlink leaves selected directory: {child}")


def execute(name: str, argv: list[str], prefix: list[str], timeout: int) -> dict:
    started = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    process = subprocess.Popen(prefix + argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = {"name": name, "argv": argv, "returncode": process.returncode,
              "timed_out": timed_out, "wall_seconds": round(time.monotonic() - started, 6),
              "cpu_user_seconds": round(after.ru_utime - before.ru_utime, 6),
              "cpu_system_seconds": round(after.ru_stime - before.ru_stime, 6),
              "stdout_bytes": len(stdout), "stderr_bytes": len(stderr),
              "stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace")}
    text = result["stdout"] + result["stderr"]
    counts = {key: int(value) for value, key in re.findall(r"(\d+) (pass|fail|skip)\b", text)}
    python_count = re.search(r"Ran (\d+) tests? in", text)
    if python_count:
        counts["run"] = int(python_count[1])
        skipped = re.search(r"skipped=(\d+)", text)
        counts["skip"] = int(skipped[1]) if skipped else 0
    result["test_counts"] = counts
    return result


class Sandbox:
    """One disposable, writable snapshot; command() always creates an offline sandbox."""

    def __init__(self, project: Path = PROJECT, *, snapshot_path: Path | None = None, metadata: dict | None = None):
        self.project = Path(project).resolve()
        self.snapshot_path = snapshot_path
        self.source_metadata = metadata
        self.temporary = None
        self.path = None
        self.metadata = None
        self.dependencies = None
        self.prefix = None

    def __enter__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="magpie-self-benchmark-", dir="/tmp")
        try:
            self.path = Path(self.temporary.name) / "repo"
            self.path.mkdir()
            if self.snapshot_path is None:
                self.metadata = snapshot(self.project, self.path)
            else:
                shutil.copytree(self.snapshot_path, self.path, dirs_exist_ok=True, symlinks=True,
                                ignore=lambda _directory, names: {name for name in names if name == 'node_modules'})
                self.metadata = self.source_metadata
            self.prefix, self.dependencies = sandbox_prefix(self.project, self.path)
            return self
        except BaseException:
            self.temporary.cleanup()
            raise

    def __exit__(self, *_args):
        self.temporary.cleanup()

    def command(self, argv: list[str]) -> list[str]:
        if self.prefix is None:
            raise RuntimeError("Sandbox must be entered before command()")
        return [*self.prefix, *argv]


def sandbox_prefix(project: Path, target: Path) -> tuple[list[str], dict]:
    bwrap = shutil.which("bwrap")
    bun = shutil.which("bun")
    if sys.platform != "linux" or not bwrap or not bun:
        raise RuntimeError("Linux, bubblewrap and Bun are required; no unsandboxed fallback")
    node = Path(subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()).resolve()
    npm = Path(shutil.which("npm") or "/missing-npm").resolve()
    # npm-cli.js needs its package files, but never an npm config/cache directory.
    npm_package = npm.parent.parent
    if npm.name != "npm-cli.js" or not (npm_package / "package.json").is_file():
        raise RuntimeError("npm must resolve to an installed npm package's bin/npm-cli.js")
    dependencies = project / "node_modules"
    safe_dependency_tree(dependencies)
    python_sites = project / "context-folding/.venv/lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
    parser_packages = [python_sites / name for name in ("tree_sitter", "tree_sitter_javascript", "tree_sitter_typescript")]
    if not all(path.is_dir() for path in parser_packages):
        raise RuntimeError("local Python javascript parser dependencies missing for this Python version")
    for path in parser_packages:
        safe_dependency_tree(path)
    prefix = [bwrap, "--die-with-parent", "--unshare-all", "--new-session",
              "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
              "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
              "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
              "--dir", "/home/sandbox", "--bind", str(target), "/workspace",
              "--ro-bind", str(dependencies), "/workspace/node_modules",
              "--ro-bind", str(node), "/opt/runtime/node",
              "--ro-bind", str(Path(bun).resolve()), "/opt/runtime/bun",
              "--ro-bind", str(npm_package), "/opt/npm",
              "--symlink", "/opt/npm/bin/npm-cli.js", "/opt/runtime/npm"]
    for path in parser_packages:
        prefix += ["--ro-bind", str(path), "/opt/python/" + path.name]
    dependency_info = {"node_modules": str(dependencies), "npm_package": str(npm_package),
                              "node": str(node), "bun": str(Path(bun).resolve()),
                              "python_parser_packages": [str(path) for path in parser_packages],
                              "mode": "read-only; no home/config/cache/venv .pth mounts"}
    prefix += ["--clearenv", "--setenv", "PATH", "/opt/runtime:/usr/bin:/bin",
               "--setenv", "HOME", "/home/sandbox", "--setenv", "LANG", "C.UTF-8",
               "--setenv", "PYTHONPATH", "/workspace/context-folding/python:/opt/python",
               "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
               "--setenv", "npm_config_cache", "/tmp/npm-cache",
               "--setenv", "npm_config_offline", "true", "--chdir", "/workspace"]
    return prefix, dependency_info


def run(project: Path, timeout: int, report: dict) -> None:
    with Sandbox(project) as sandbox:
        report["git"] = sandbox.metadata
        report["dependencies"] = sandbox.dependencies
        prefix = sandbox.prefix
        probe = '''import json, os, pathlib
assert not pathlib.Path(%r).exists(), 'host project visible'
assert not pathlib.Path(%r).exists(), 'host home visible'
assert os.readlink('/proc/self/ns/net') != %r, 'host network namespace shared'
p = pathlib.Path('/workspace/.sandbox-write-probe'); p.write_text('ok'); p.unlink()
try:
    fd = os.open('/workspace/node_modules/typescript/package.json', os.O_WRONLY)
except OSError as error:
    assert error.errno == 30, repr(error)
else:
    os.close(fd); raise AssertionError('dependencies writable')
print(json.dumps({'source_writable': True, 'host_home_hidden': True, 'host_project_hidden': True, 'dependencies_readonly': True, 'network_namespace_isolated': True}))
''' % (str(project), str(Path.home()), os.readlink('/proc/self/ns/net'))
        checks = report["commands"]
        checks.append(execute("sandbox-probe", ["/usr/bin/python3", "-I", "-c", probe], prefix, timeout))
        if checks[-1]["returncode"]:
            raise RuntimeError("bubblewrap isolation probe failed; tests were not run")
        checks.append(execute("runtime-versions", ["/usr/bin/python3", "-I", "-c",
            "import subprocess,sys,json; print(json.dumps({k:subprocess.check_output(v,text=True).strip() for k,v in {'node':['node','--version'],'bun':['bun','--version'],'npm':['npm','--version']}.items()})); print(sys.version)"], prefix, timeout))
        checks.append(execute("npm-check", ["npm", "run", "check"], prefix, timeout))
        checks.append(execute("controller-regressions", ["/usr/bin/python3", "-I", "scripts/test_self_iterate.py"], prefix, timeout))
        checks.append(execute("typescript-recursive", ["bun", "test", "--isolate", *RECURSIVE_TESTS["typescript-recursive"]], prefix, timeout))
        checks.append(execute("python-core", ["/usr/bin/python3", "-m", "unittest", "discover", "-s", "context-folding/tests", "-v"], prefix, timeout))
        report["recursive_coverage"] = [
            {"command": name, "files": files, "suite_passed": next(item for item in checks if item["name"] == name)["returncode"] == 0,
             "scope": "executed by full suite; no line/branch coverage measurement"}
            for name, files in RECURSIVE_TESTS.items()]
        report["status"] = "passed" if all(item["returncode"] == 0 for item in checks) else "failed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=PROJECT)
    parser.add_argument("--timeout", type=int, default=600, help="per-command timeout in seconds")
    parser.add_argument("--output", type=Path, help="also save JSON outside the disposable snapshot")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    report = {"schema_version": 1, "status": "failed", "sandbox": {"type": "linux-bubblewrap",
              "network": "unshare-all (offline)", "source": "writable disposable snapshot",
              "host_project": "not mounted", "home": "empty /home/sandbox"},
              "model_test": {"executed": False}, "commands": []}
    start = time.monotonic()
    try:
        run(args.project.resolve(), args.timeout, report)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    report["wall_seconds"] = round(time.monotonic() - start, 6)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded)
    print(encoded, end="")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
