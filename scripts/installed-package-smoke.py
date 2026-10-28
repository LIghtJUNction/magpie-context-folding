#!/usr/bin/env python3
"""Run the isolated Magpie HTTP smoke against a locally installed npm package."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PACKAGE = Path.home() / ".config/magpie/plugins/node_modules/magpie-context-folding"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE,
                        help="installed magpie-context-folding package directory")
    parser.add_argument("--magpie", default=shutil.which("magpie"))
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--bwrap", default=shutil.which("bwrap"))
    args = parser.parse_args()

    missing = [name for name in ("magpie", "bun", "bwrap") if not getattr(args, name)]
    if missing:
        parser.error("required executable(s) unavailable: " + ", ".join(missing))
    package = args.package.expanduser().resolve()
    metadata = json.loads((package / "package.json").read_text(encoding="utf-8"))
    if metadata.get("name") != "magpie-context-folding" or metadata.get("version") != "0.5.0":
        parser.error(f"expected installed magpie-context-folding@0.5.0, found {metadata.get('name')}@{metadata.get('version')}")
    source = package / "src"
    if not (source / "context.hooks.ts").is_file() or not (source / "cli.ts").is_file():
        parser.error("installed npm package is missing its hook or CLI TypeScript source")
    for name, value in (("magpie", args.magpie), ("bun", args.bun), ("bwrap", args.bwrap)):
        path = Path(value).expanduser().resolve()
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"{name} executable is not runnable: {path}")

    with tempfile.TemporaryDirectory(prefix="magpie-installed-smoke-") as temporary:
        directory = Path(temporary)
        (directory / "package.json").write_bytes((package / "package.json").read_bytes())
        shutil.copytree(source, directory / "src")
        shutil.copytree(package / "dist", directory / "dist")
        modules = package.parent
        if (modules / "zod").exists():
            (directory / "node_modules").mkdir()
            shutil.copytree(modules / "zod", directory / "node_modules" / "zod")
        smoke = subprocess.run([
            "python3", "-I", str(ROOT / "scripts/host-smoke.py"),
            "--magpie", str(Path(args.magpie).resolve()),
            "--bun", str(Path(args.bun).resolve()),
            "--bwrap", str(Path(args.bwrap).resolve()),
            "--project", str(directory),
        ], cwd=ROOT, check=False, capture_output=True, text=True)
        if smoke.stdout:
            print(smoke.stdout, end="")
        if smoke.stderr:
            print(smoke.stderr, end="", file=__import__("sys").stderr)
        raise SystemExit(smoke.returncode)


if __name__ == "__main__":
    main()
