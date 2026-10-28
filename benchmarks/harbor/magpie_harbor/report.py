"""Conservative, dependency-free summaries of Harbor 0.25 per-trial results.

Only immediate job children are trials: nested retry/source archives and the
job-level result.json are never counted. Duplicate UUIDs are rejected rather
than silently selecting a successful retry. Deltas compare sample means, not
matched random seeds or causal effects. Unknown measurements remain unknown.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import statistics


USAGE = ("n_input_tokens", "n_cache_tokens", "n_output_tokens", "cost_usd")
CUSTOM = ("requests", "folded_requests", "recovery_calls", "raw_request_bytes", "sent_request_bytes",
          "projection_ms", "agent_wall_sec")


def _number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def _metric(values):
    known = [value for value in values if _number(value) is not None]
    complete = len(known) == len(values) and bool(values)
    return {"observed_trials": len(known), "total_trials": len(values),
            "observed_sum": sum(known) if known else None,
            "total": sum(known) if complete else None,
            "mean": statistics.mean(known) if complete else None,
            "median": statistics.median(known) if complete else None}


def _cohort(result):
    config = deepcopy(result["config"])
    agent = config.get("agent", {})
    kwargs = agent.get("kwargs", {})
    mode = kwargs.pop("mode", None)
    metadata = ((result.get("agent_result") or {}).get("metadata") or {}).get("magpie_harbor", {})
    if metadata.get("mode", mode) != mode:
        raise ValueError(f"Mode differs between metadata and config: {result['trial_name']}")
    # Runtime identities and filesystem locations do not change the experiment.
    for key in ("trial_name", "trials_dir", "job_id", "task"):
        config.pop(key, None)
    identity = {"task": result["task_name"], "task_checksum": result["task_checksum"],
                "model": result.get("agent_info", {}).get("model_info"),
                "agent": {key: result.get("agent_info", {}).get(key) for key in ("name", "version")},
                "source_revision": metadata.get("source_revision"),
                "source_tree_sha256": metadata.get("source_tree_sha256"),
                "endpoint_sha256": metadata.get("endpoint_sha256"),
                "measurement": metadata.get("measurement"),
                "config_sha256": hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()}
    return mode, identity, metadata


def _summary(rows):
    statuses = Counter(row["status"] for row in rows)
    return {"attempts": len(rows), "successes": statuses["passed"],
            "failed_tasks": statuses["failed"], "errors": statuses["error"],
            "unscored": statuses["unscored"], "unfinished": statuses["unfinished"],
            "success_rate_all_observed_attempts": statuses["passed"] / len(rows),
            "metrics": {name: _metric([row["metrics"].get(name) for row in rows])
                        for name in (*USAGE, *CUSTOM)},
            "usage_complete_trials": sum(row["usage_complete"] is True for row in rows),
            "trials": [{k: row[k] for k in ("id", "trial_name", "status", "reward", "exception_type")} for row in rows]}


def build_report(jobs):
    groups, seen, warnings, manifests = defaultdict(list), set(), [], []
    for job in dict.fromkeys(Path(path).resolve() for path in jobs):
        if not job.is_dir():
            raise ValueError(f"Job directory does not exist: {job}")
        files = sorted(p for p in job.glob("*/result.json") if not p.parent.name.startswith("."))
        expected = None
        lock_path = job / "lock.json"
        if lock_path.is_file():
            lock = json.loads(lock_path.read_text())
            if isinstance(lock.get("trials"), list):
                expected = len(lock["trials"])
        if expected is None:
            warnings.append(f"{job.name}: no trial manifest; completeness is unknown")
        elif expected != len(files):
            warnings.append(f"{job.name}: expected {expected} trial results, observed {len(files)}")
        manifests.append({"job": str(job), "expected_trials": expected, "observed_trials": len(files)})
        for path in files:
            result = json.loads(path.read_text())
            if not all(result.get(k) for k in ("id", "trial_name", "task_name", "task_checksum", "config")):
                raise ValueError(f"Not a complete trial record: {path}")
            if result["id"] in seen:
                raise ValueError(f"Duplicate trial UUID {result['id']}; select one final materialization")
            seen.add(result["id"])
            if result.get("step_results"):
                raise ValueError("Multi-step results need a step-aware report; this benchmark uses single-step tasks")
            mode, cohort, metadata = _cohort(result)
            agent = result.get("agent_result") or {}
            reward = _number(((result.get("verifier_result") or {}).get("rewards") or {}).get("reward"))
            exception = result.get("exception_info") or {}
            status = ("error" if exception else "unfinished" if not result.get("finished_at")
                      else "unscored" if reward is None else "passed" if reward == 1 else "failed")
            metrics = {key: _number(agent.get(key)) for key in USAGE}
            metrics.update({key: _number(metadata.get(key)) for key in CUSTOM})
            row = {"id": result["id"], "trial_name": result["trial_name"], "status": status,
                   "reward": reward, "exception_type": exception.get("exception_type"),
                   "metrics": metrics, "usage_complete": metadata.get("usage_complete")}
            groups[(json.dumps(cohort, sort_keys=True), mode)].append(row)

    if not seen:
        raise ValueError("No per-trial result.json files found")
    summaries, cohorts, mode_rows = [], defaultdict(dict), defaultdict(list)
    for (key, mode), rows in sorted(groups.items(), key=lambda item: str(item[0])):
        group = {"cohort": json.loads(key), "mode": mode, **_summary(rows)}
        summaries.append(group)
        cohorts[key][mode] = group
        mode_rows[mode].extend(rows)
    comparisons = []
    complete_jobs = all(m["expected_trials"] == m["observed_trials"] for m in manifests)
    # Setup failures may have no agent metadata and therefore occupy an unknown
    # provenance cohort. They must not disappear from the efficiency population.
    has_unsuccessful_trials = any(row["status"] != "passed" for rows in groups.values() for row in rows)
    for key, variants in sorted(cohorts.items()):
        cohort = json.loads(key)
        baseline, folded = variants.get("baseline"), variants.get("folding")
        reasons = []
        if not complete_jobs:
            reasons.append("job manifest is missing or incomplete")
        if has_unsuccessful_trials:
            reasons.append("some observed trials failed or are unscored; efficiency interpretation withheld")
        if baseline is None or folded is None:
            reasons.append("matching baseline or folding cohort is missing")
        elif baseline["attempts"] != folded["attempts"]:
            reasons.append("unequal sample counts")
        elif any(group["successes"] != group["attempts"] for group in (baseline, folded)):
            reasons.append("not every attempt passed; efficiency interpretation withheld")
        if cohort["measurement"] != "model":
            reasons.append("synthetic or unspecified measurement; no model efficiency claim")
        if (not re.fullmatch(r"[0-9a-f]{40,64}", str(cohort["source_revision"])) or not cohort["model"]):
            reasons.append("source revision or model identity is unknown")
        if any(not re.fullmatch(r"[0-9a-f]{64}", str(cohort[key]))
               for key in ("source_tree_sha256", "endpoint_sha256")):
            reasons.append("source tree or endpoint fingerprint is unknown")
        if baseline and folded and any(g["usage_complete_trials"] != g["attempts"] for g in (baseline, folded)):
            reasons.append("provider usage is incomplete; efficiency deltas withheld")
        comparison = {"cohort": cohort, "eligible": not reasons, "limitations": reasons,
                      "mean_deltas_folding_minus_baseline": {},
                      "interpretation": "descriptive sample means, not paired trials or statistical evidence"}
        if not reasons:
            for metric in (*USAGE, *CUSTOM):
                left, right = baseline["metrics"][metric]["mean"], folded["metrics"][metric]["mean"]
                comparison["mean_deltas_folding_minus_baseline"][metric] = (
                    right - left if left is not None and right is not None else None)
        comparisons.append(comparison)
    return {"schema_version": 1, "source": "Harbor 0.25 per-trial result.json",
            "denominator": "all observed trial results, including failures and infrastructure errors",
            "notes": ["n_input_tokens includes cached tokens; never add n_cache_tokens to it",
                      "Unknown measurements are null; observed_sum is not a complete-job total",
                      "No price lookup, token estimation, pass@k or causal improvement is inferred",
                      "Retry/source subdirectories are ignored; use jobs configured with max_retries=0"],
            "jobs": manifests, "warnings": warnings,
            "totals_by_mode": [{"mode": mode, **_summary(rows)} for mode, rows in mode_rows.items()],
            "groups": summaries, "comparisons": comparisons}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jobs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        report = build_report(args.jobs)
    except (ValueError, OSError, TypeError) as error:
        parser.exit(2, f"Report error: {error}\n")
    text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
