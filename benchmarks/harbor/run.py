#!/usr/bin/env python3
"""Generate, validate and run pinned Harbor jobs without guessing a model."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parents[1]
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
os.environ.setdefault("HARBOR_TELEMETRY", "off")


def doctor() -> dict:
    try:
        harbor = importlib.metadata.version("harbor")
    except importlib.metadata.PackageNotFoundError:
        harbor = None
    bun = shutil.which(os.environ.get("HARBOR_BUN", "bun"))
    docker = shutil.which("docker")
    daemon = False
    if docker:
        try:
            daemon = subprocess.run([docker, "info"], stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=10).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {"harbor_version": harbor, "expected_harbor_version": "0.25.0",
            "python_version": sys.version.split()[0], "bun_available": bool(bun),
            "project_dependencies_installed": (ROOT / "node_modules/zod/package.json").exists(),
            "docker_cli_available": bool(docker), "docker_daemon_available": daemon,
            "model_endpoint_configured": bool(os.environ.get("HARBOR_MODEL_BASE_URL")),
            "model_api_key_configured": bool(os.environ.get("HARBOR_MODEL_API_KEY")),
            "note": "Credentials are not printed; a missing Docker runtime prevents container benchmark execution."}


def build_config(args, smoke=False) -> dict:
    prefix = "smoke" if smoke else "ab"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    config = {"job_name": f"{prefix}-{timestamp}", "jobs_dir": str(args.jobs_dir.resolve()),
              "n_attempts": 1 if smoke else args.attempts, "n_concurrent_trials": 1,
              "retry": {"max_retries": 0}, "environment": {"type": "docker"},
              "datasets": [{"path": str((BENCH / "tasks").resolve())}]}
    if not smoke and args.dataset:
        if "@" not in args.dataset:
            raise ValueError("Pin external datasets as name@version")
        name, version = args.dataset.rsplit("@", 1)
        if not name or not version or version == "latest":
            raise ValueError("Use an explicit immutable dataset version")
        config["datasets"] = [{"name": name, "version": version}]
    if not smoke and args.task_path:
        config.pop("datasets")
        config["tasks"] = [{"path": str(args.task_path.resolve())}]
    klass = "ScriptedSmokeAgent" if smoke else "MagpieAgent"
    config["agents"] = [{"import_path": f"magpie_harbor.agent:{klass}",
                          "model_name": "scripted-smoke" if smoke else args.model,
                          "skip_model_parsing": True,
                          "kwargs": {"mode": mode, "max_turns": 8 if smoke else args.max_turns,
                                     "max_output_tokens": 4096 if smoke else args.max_output_tokens,
                                     "output_token_field": "max_tokens" if smoke else args.output_token_field,
                                     **({} if smoke or args.temperature is None else {"temperature": args.temperature}),
                                     **({} if smoke or args.seed is None else {"seed": args.seed})}}
                         for mode in ("baseline", "folding")]
    if smoke:
        config["agents"] = [{"name": "oracle"}, {"name": "nop"}, *config["agents"]]
    return config


def validate(config: dict) -> dict:
    from harbor.models.job.config import JobConfig
    from harbor.models.task.task import Task
    from magpie_harbor.agent import Options
    if importlib.metadata.version("harbor") != "0.25.0":
        raise ValueError("This integration is validated against harbor==0.25.0")
    job = JobConfig.model_validate(config)
    tasks = [Task(path) for path in sorted((BENCH / "tasks").iterdir()) if path.is_dir()]
    if not tasks:
        raise ValueError("No bundled tasks found")
    for agent in job.agents:
        if agent.import_path:
            Options.model_validate(agent.kwargs)
    return {"harbor_version": "0.25.0", "task_schema_version": tasks[0].config.schema_version,
            "tasks": [task.name for task in tasks], "agents": len(job.agents),
            "status": "configuration-and-task-files-valid", "container_execution": False}


def check_smoke(job: Path) -> dict:
    from harbor.models.trial.result import TrialResult
    expected_tasks = {path.name for path in (BENCH / "tasks").iterdir() if path.is_dir()}
    results = [TrialResult.model_validate_json(p.read_text()) for p in job.glob("*/result.json")]
    seen = set()
    for result in results:
        agent = result.agent_info.name
        mode = result.config.agent.kwargs.get("mode", "control")
        key = (result.task_name, agent, mode)
        if key in seen or result.task_name not in expected_tasks:
            raise RuntimeError("Unexpected or duplicate smoke trial")
        seen.add(key)
        expected = 0.0 if agent == "nop" else 1.0
        reward = result.verifier_result.rewards.get("reward") if result.verifier_result and result.verifier_result.rewards else None
        if result.exception_info or not result.finished_at or reward != expected:
            raise RuntimeError(f"Smoke control failed: {key}, reward={reward}, exception={bool(result.exception_info)}")
        if agent == "magpie-scripted-smoke":
            metadata = (result.agent_result.metadata or {}).get("magpie_harbor", {}) if result.agent_result else {}
            if metadata.get("measurement") != "scripted-smoke" or metadata.get("completion") != "final":
                raise RuntimeError("Missing scripted smoke provenance")
            if mode == "folding" and metadata.get("recovery_calls") != 1:
                raise RuntimeError("Smoke did not exercise exact recovery")
    expected = {(task, agent, mode) for task in expected_tasks for agent, mode in
                (("oracle", "control"), ("nop", "control"), ("magpie-scripted-smoke", "baseline"),
                 ("magpie-scripted-smoke", "folding"))}
    if seen != expected:
        raise RuntimeError(f"Incomplete smoke job: expected {len(expected)}, got {len(seen)}")
    return {"status": "passed", "trials": len(results), "measurement": "scripted-smoke",
            "claim": "Harbor orchestration, verifier controls, production folding and recovery; no model quality or cost result"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    commands.add_parser("test")
    for name in ("validate", "smoke", "run"):
        command = commands.add_parser(name)
        command.add_argument("--jobs-dir", type=Path, default=BENCH / "jobs")
        if name != "validate":
            command.add_argument("--config-only", action="store_true", help="Write a validated job config without running anything")
        if name == "run":
            command.add_argument("--model", required=True, help="Exact model identifier accepted by HARBOR_MODEL_BASE_URL")
            command.add_argument("--attempts", type=int, default=3)
            command.add_argument("--max-turns", type=int, default=32)
            command.add_argument("--max-output-tokens", type=int, default=4096)
            command.add_argument("--output-token-field", choices=("max_tokens", "max_completion_tokens"), default="max_tokens")
            command.add_argument("--temperature", type=float)
            command.add_argument("--seed", type=int)
            source = command.add_mutually_exclusive_group()
            source.add_argument("--dataset", help="An explicit Harbor registry dataset@version")
            source.add_argument("--task-path", type=Path, help="One local Harbor task")
    check = commands.add_parser("check-smoke")
    check.add_argument("job", type=Path)
    report = commands.add_parser("report")
    report.add_argument("jobs", nargs="+", type=Path)
    report.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "test":
            import unittest
            suite = unittest.defaultTestLoader.discover(str(BENCH / "tests"))
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            if not result.wasSuccessful():
                raise RuntimeError("Harbor component tests failed")
            return
        if args.command == "doctor":
            print(json.dumps(doctor(), indent=2))
            return
        if args.command == "check-smoke":
            print(json.dumps(check_smoke(args.job), indent=2))
            return
        if args.command == "report":
            from magpie_harbor.report import main as report_main
            report_main([*[str(p) for p in args.jobs], *(["--output", str(args.output)] if args.output else [])])
            return
        smoke = args.command in {"smoke", "validate"}
        config = build_config(args, smoke)
        validation = validate(config)
        if args.command == "validate":
            print(json.dumps(validation, indent=2))
            return
        args.jobs_dir.mkdir(parents=True, exist_ok=True)
        config_path = args.jobs_dir / (config["job_name"] + ".config.json")
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        print(f"Validated configuration: {config_path}", flush=True)
        if args.config_only:
            return
        checks = doctor()
        if not (checks["bun_available"] and checks["project_dependencies_installed"] and checks["docker_daemon_available"]):
            raise RuntimeError("Run doctor: Bun, npm ci and an available Docker daemon are required. Config saved; no benchmark was run.")
        if not smoke:
            from magpie_harbor.agent import endpoint
            endpoint(os.environ.get("HARBOR_MODEL_BASE_URL", ""))
        env = dict(os.environ)
        env["PYTHONPATH"] = str(BENCH) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        harbor = shutil.which("harbor")
        if not harbor:
            raise RuntimeError("Harbor executable is not on PATH; run through uv or activate the environment")
        result = subprocess.run([harbor, "run", "-c", str(config_path)], cwd=ROOT, env=env)
        if result.returncode:
            raise RuntimeError(f"Harbor exited with status {result.returncode}; preserve job logs")
        job = args.jobs_dir / config["job_name"]
        if smoke:
            summary = check_smoke(job)
        else:
            from magpie_harbor.report import build_report
            summary = build_report([job])
        (job / "magpie-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    except (ValueError, OSError, RuntimeError) as error:
        parser.exit(2, f"Benchmark error: {error}\n")


if __name__ == "__main__":
    main()
