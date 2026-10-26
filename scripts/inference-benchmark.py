#!/usr/bin/env python3
"""Measure existing local smollm2:135m inference for actual plugin prompts.

Input: {"prompts": [{"label": "original", "text": "..."}, ...],
        "hookMedianMs": 2.0 (optional)}. Use --input - for stdin.
No models are downloaded. HTTP is restricted to local Ollama. A newly loaded
small model is unloaded at the end; a model present before the run is retained.
Cold means prefix-disrupted, not a claim that all KV-cache reads are zero.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import statistics
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener


MODEL = "smollm2:135m"
HTTP = build_opener(ProxyHandler({}))
DURATIONS = ("prompt_eval_duration", "eval_duration", "load_duration", "total_duration")


def api(base: str, path: str, payload: object | None = None, timeout: float = 60) -> dict:
    request = Request(base + path, data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with HTTP.open(request, timeout=timeout) as response:
            result = json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Ollama HTTP {error.code}: {error.read().decode()[:1000]}") from error
    if "error" in result:
        raise RuntimeError(f"Ollama: {result['error']}")
    return result


def resources() -> dict:
    result: dict = {"loadAverage": list(os.getloadavg()), "logicalCpus": os.cpu_count()}
    try:
        memory = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            if name in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
                memory[name + "KiB"] = int(value.strip().split()[0])
        result["memory"] = memory
        for kind in ("cpu", "memory", "io"):
            result[kind + "Pressure"] = Path("/proc/pressure/" + kind).read_text().strip()
        result["cpuTicks"] = [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    except (OSError, ValueError):
        result["resourceCountersUnavailable"] = True
    return result


def ollama_cpu() -> dict[int, float]:
    counts = {}
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if "ollama" not in (directory / "comm").read_text().lower():
                continue
            fields = (directory / "stat").read_text().split(")", 1)[1].split()
            counts[int(directory.name)] = (int(fields[11]) + int(fields[12])) / ticks_per_second
        except (OSError, ValueError, IndexError):
            continue
    return counts


def distribution(values: list[float]) -> dict:
    return {"samples": len(values), "median": statistics.median(values), "min": min(values), "max": max(values)} if values else {"samples": 0, "median": None, "min": None, "max": None}


def metric_summary(runs: list[dict], expected: str | None) -> dict:
    valid = [run for run in runs if run["valid"]]
    summary = {
        "attempts": len(runs), "validRuns": len(valid), "errors": len(runs) - len(valid),
        "nonemptyOutputs": sum(run.get("nonemptyOutput", False) for run in runs),
        "visibleOutputs": sum(run.get("visibleOutput", False) for run in runs),
        "oneOutputToken": sum(run.get("eval_count") == 1 for run in runs),
        "semanticCorrectOutputs": sum(run.get("semanticCorrect") is True for run in runs) if expected is not None else None,
        "semanticAssessment": "exact stripped output match" if expected is not None else "unassessed; structural checks do not prove answer quality",
        "outputCounts": dict(Counter(run.get("response", "") for run in runs)),
    }
    for key in ("wallMs", "promptEvalMs", "decodeMs", "loadMs", "totalMs", "otherServerMs", "prompt_eval_count", "eval_count"):
        summary[key] = distribution([run[key] for run in valid])
    known_cache = [run["prompt_eval_cached_count"] for run in valid if run.get("prompt_eval_cached_count") is not None]
    summary["cachedInputTokens"] = distribution(known_cache)
    summary["cacheObservability"] = "explicit cached-token counter" if known_cache else "no cached-token counter from this server; repeated-input timing is evidence only"
    return summary


def compare(baseline: dict, variant: dict, hook_ms: float | None) -> dict:
    if not baseline["validRuns"] or not variant["validRuns"]:
        return {"verdict": "inconclusive", "reason": "missing successful runs"}
    original = baseline["wallMs"]["median"]
    folded = variant["wallMs"]["median"]
    saved = original - folded
    result = {
        "medianWallSavingMs": saved, "medianWallSavingPercent": 100 * saved / original if original else None,
        "medianWallSpeedup": original / folded if folded else None,
        "promptTokensRemoved": baseline["prompt_eval_count"]["median"] - variant["prompt_eval_count"]["median"],
        "medianPromptEvalSavingMs": baseline["promptEvalMs"]["median"] - variant["promptEvalMs"]["median"],
        "medianDecodeSavingMs": baseline["decodeMs"]["median"] - variant["decodeMs"]["median"],
    }
    if variant["wallMs"]["max"] < baseline["wallMs"]["min"]:
        result["verdict"] = "faster with non-overlapping observed ranges"
    elif variant["wallMs"]["min"] > baseline["wallMs"]["max"]:
        result["verdict"] = "slower with non-overlapping observed ranges"
    else:
        result["verdict"] = "ranges overlap; median difference is descriptive"
    if hook_ms is not None:
        result["estimatedWallPlusSeparateHookMedianMs"] = folded + hook_ms
        result["estimatedSavingAfterSeparateHookMs"] = original - folded - hook_ms
        result["hookCombinationIsEstimate"] = True
    return result


def warm_cache_evidence(runs: list[dict], labels: list[str]) -> dict:
    evidence = {}
    for label in labels:
        pairs = []
        for warm in runs:
            if warm["phase"] != "warm" or warm["label"] != label or not warm["valid"]:
                continue
            primer = next((run for run in runs if run["phase"] == "warm-primer" and run["label"] == label and run["trial"] == warm["trial"] and run["valid"]), None)
            if primer is None:
                continue
            pairs.append({
                "trial": warm["trial"], "identicalPromptHash": primer["promptSha256"] == warm["promptSha256"],
                "identicalInputCount": primer["prompt_eval_count"] == warm["prompt_eval_count"],
                "primerPromptEvalMs": primer["promptEvalMs"], "repeatPromptEvalMs": warm["promptEvalMs"],
                "promptEvalSavingMs": primer["promptEvalMs"] - warm["promptEvalMs"],
            })
        evidence[label] = {
            "pairs": pairs,
            "promptEvalSavingMs": distribution([pair["promptEvalSavingMs"] for pair in pairs]),
            "interpretation": "immediate identical prompt repeat; duration difference supports cache effects but is not an exact cached-token count",
        }
    return evidence


def benchmark(arguments: argparse.Namespace, data: dict) -> dict:
    base = arguments.url.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("only an existing local Ollama endpoint is permitted")
    prompts = data.get("prompts")
    if not isinstance(prompts, list) or len(prompts) < 2:
        raise ValueError("input requires at least two prompts, with baseline first")
    if any(not isinstance(prompt, dict) or not isinstance(prompt.get("text"), str) or not prompt["text"] or not isinstance(prompt.get("label"), str) for prompt in prompts):
        raise ValueError("each prompt must have a nonempty text and a string label")
    labels = [prompt["label"] for prompt in prompts]
    if len(set(labels)) != len(labels):
        raise ValueError("prompt labels must be unique")
    if arguments.runs < 5:
        raise ValueError("use at least five measured runs per prompt and scenario")
    tags = api(base, "/api/tags")["models"]
    model = next((model for model in tags if model.get("name") == MODEL), None)
    if model is None:
        raise ValueError("smollm2:135m is not installed; this script never downloads it")
    initial_ps = api(base, "/api/ps")
    was_loaded = any(loaded.get("name") == MODEL or loaded.get("model") == MODEL for loaded in initial_ps.get("models", []))
    others = [loaded.get("name", loaded.get("model")) for loaded in initial_ps.get("models", []) if loaded.get("name") != MODEL and loaded.get("model") != MODEL]
    if others:
        raise RuntimeError(f"other models are loaded ({others}); refusing a benchmark that could evict them")
    show = api(base, "/api/show", {"model": MODEL})
    info = show.get("model_info", {})
    architecture = info.get("general.architecture")
    native_context = info.get(str(architecture) + ".context_length")
    if not isinstance(native_context, int) or arguments.context > native_context:
        raise ValueError(f"requested context {arguments.context} exceeds or lacks verified native context {native_context}")
    for loaded in initial_ps.get("models", []):
        loaded_context = loaded.get("context_length")
        if was_loaded and loaded_context not in (None, arguments.context):
            raise RuntimeError("small model is already loaded with a different context; refusing to reload it")
    options = {"num_ctx": arguments.context, "num_predict": 1, "temperature": 0, "seed": 42, "num_thread": arguments.threads}
    hook_ms = data.get("hookMedianMs")
    if hook_ms is None:
        hook_ms = data.get("measurements", {}).get("warmFoldedHookMs", {}).get("median")
    if hook_ms is not None and (not isinstance(hook_ms, (int, float)) or not math.isfinite(hook_ms) or hook_ms < 0):
        raise ValueError("hookMedianMs must be a nonnegative finite number")
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(), "claim": "local one-output-token inference latency on these actual plugin prompt versions",
        "ollamaVersion": api(base, "/api/version"), "model": model, "nativeContext": native_context,
        "options": options, "raw": True, "truncate": False, "shift": False,
        "expectedOutput": arguments.expected_output,
        "promptMetadata": [{"label": prompt["label"], "chars": len(prompt["text"]), "utf8Bytes": len(prompt["text"].encode()), "sha256": hashlib.sha256(prompt["text"].encode()).hexdigest()} for prompt in prompts],
        "initialPs": initial_ps, "initialResources": resources(), "wasLoadedInitially": was_loaded,
        "requestRuns": [], "profileRuns": [], "preflight": [],
        "limits": [
            "small local model, fixed one-token output; not a cloud-provider latency or semantic-quality result",
            "prefix-disrupted requests share a nonce within each round and can still reuse that nonce and unchanged opening tokens",
            "warm requests repeat each exact prompt immediately; only the second request is included in warm statistics",
            "other host workloads are preserved; alternating forward/reverse order reduces but does not remove noise",
            "adding the separately measured hook median is an estimate, not a timed Magpie end-to-end request",
            "no electricity or provider bill is measured; local token savings are not dollar savings",
            "Ollama includes the first generated token in prompt evaluation; omitted zero decode duration does not mean inference was skipped",
        ],
        "sources": ["https://docs.ollama.com/api/generate", "https://github.com/ollama/ollama/blob/v0.20.2/runner/llamarunner/cache.go", "https://github.com/ollama/ollama/blob/v0.20.2/api/types.go#L529", "https://github.com/ollama/ollama/blob/v0.20.2/runner/llamarunner/runner.go#L489"],
    }
    loaded_by_this_run = False

    def generate(text: str, label: str, phase: str, trial: int) -> dict:
        nonlocal loaded_by_this_run
        started = time.perf_counter_ns()
        run: dict = {"label": label, "phase": phase, "trial": trial, "promptSha256": hashlib.sha256(text.encode()).hexdigest(), "valid": False}
        try:
            loaded_by_this_run = not was_loaded
            reply = api(base, "/api/generate", {
                "model": MODEL, "prompt": text, "stream": False, "raw": True,
                "truncate": False, "shift": False, "keep_alive": "60s", "options": options,
            }, timeout=arguments.timeout)
            run["wallMs"] = (time.perf_counter_ns() - started) / 1e6
            run.update({key: reply.get(key) for key in (*DURATIONS, "prompt_eval_count", "prompt_eval_cached_count", "eval_count", "done", "done_reason", "response")})
            # Ollama's zero-valued duration fields are omitted by JSON. With
            # one output token there may be no separate decoder iteration:
            # the first token is generated during prompt evaluation.
            run["omittedDurationFields"] = [key for key in DURATIONS if key not in reply]
            if "eval_duration" not in reply:
                reply["eval_duration"] = 0
                run["eval_duration"] = 0
            for key in DURATIONS:
                if not isinstance(reply.get(key), int) or reply[key] < 0:
                    raise ValueError(f"missing or invalid {key}")
            count = reply.get("prompt_eval_count")
            if not isinstance(count, int) or count <= 0 or count >= arguments.context - 16:
                raise ValueError(f"prompt count {count} outside the untruncated budget < {arguments.context - 16}")
            run["nonemptyOutput"] = isinstance(reply.get("response"), str) and bool(reply["response"])
            run["visibleOutput"] = isinstance(reply.get("response"), str) and bool(reply["response"].strip())
            run["semanticCorrect"] = reply.get("response", "").strip() == arguments.expected_output if arguments.expected_output is not None else None
            if reply.get("done") is not True or reply.get("eval_count") != 1 or not isinstance(reply.get("response"), str):
                raise ValueError("inference did not complete a one-token generation")
            run["promptEvalMs"] = reply["prompt_eval_duration"] / 1e6
            run["decodeMs"] = reply["eval_duration"] / 1e6
            run["loadMs"] = reply["load_duration"] / 1e6
            run["totalMs"] = reply["total_duration"] / 1e6
            run["otherServerMs"] = run["totalMs"] - run["promptEvalMs"] - run["decodeMs"] - run["loadMs"]
            run["valid"] = True
        except Exception as error:
            run.setdefault("wallMs", (time.perf_counter_ns() - started) / 1e6)
            run["error"] = f"{type(error).__name__}: {error}"
        print(f"{phase} {trial + 1} {label}: {run['wallMs']:.2f} ms, input={run.get('prompt_eval_count')}, valid={run['valid']}", file=sys.stderr, flush=True)
        return run

    try:
        warmup = generate("Ollama benchmark warmup. Reply OK.", "warmup", "warmup", 0)
        report["warmup"] = warmup
        if not warmup["valid"]:
            raise RuntimeError("small-model API warmup failed: " + warmup.get("error", "unknown"))
        report["loadedPs"] = api(base, "/api/ps")
        # A full-prefix nonce prevents a repeated prompt preflight from hiding
        # the actual input count. Both API flags also prohibit silent shifting.
        for prompt in prompts:
            run = generate(secrets.token_hex(16) + "\n" + prompt["text"], prompt["label"], "preflight", 0)
            report["preflight"].append(run)
            if not run["valid"]:
                raise RuntimeError("preflight failed; no timed comparison: " + run.get("error", "unknown"))
        for phase in ("prefix-disrupted", "warm"):
            for trial in range(arguments.runs):
                order = prompts if trial % 2 == 0 else list(reversed(prompts))
                nonce = secrets.token_hex(16)
                for prompt in order:
                    text = nonce + "\n" + prompt["text"]
                    if phase == "warm":
                        primer = generate(text, prompt["label"], "warm-primer", trial)
                        report["requestRuns"].append(primer)
                    run = generate(text, prompt["label"], phase, trial)
                    report["requestRuns"].append(run)
        # Independent profiling calls do not enter latency statistics.
        for prompt in (prompts[0], prompts[-1]):
            before = ollama_cpu()
            profile_resources = resources()
            run = generate(secrets.token_hex(16) + "\n" + prompt["text"], prompt["label"], "profile", 0)
            after = ollama_cpu()
            cpu_ms = sum(max(0, after[pid] - before[pid]) for pid in before.keys() & after.keys()) * 1000
            run["ollamaProcessCpuMs"] = cpu_ms
            run["ollamaProcessCoreEquivalents"] = cpu_ms / run["wallMs"] if run["wallMs"] else None
            run["resourcesBefore"] = profile_resources
            run["resourcesAfter"] = resources()
            report["profileRuns"].append(run)
        summaries = {}
        for phase in ("prefix-disrupted", "warm"):
            summaries[phase] = {}
            for label in labels:
                summaries[phase][label] = metric_summary([run for run in report["requestRuns"] if run["phase"] == phase and run["label"] == label], arguments.expected_output)
        report["summaries"] = summaries
        report["warmCacheEvidence"] = warm_cache_evidence(report["requestRuns"], labels)
        report["comparisons"] = {phase: {label: compare(summary[labels[0]], summary[label], hook_ms) for label in labels[1:]} for phase, summary in summaries.items()}
        baseline_cold = summaries["prefix-disrupted"][labels[0]]
        component = max(("promptEvalMs", "decodeMs", "loadMs", "otherServerMs"), key=lambda key: baseline_cold[key]["median"])
        report["limiterEvidence"] = {
            "dominantBaselineServerComponent": component,
            "baselineComponentMedianMs": baseline_cold[component]["median"],
            "baselineServerMedianMs": baseline_cold["totalMs"]["median"],
            "independentProcessProfiles": "profileRuns; Ollama process CPU deltas and service-side prefill/decode/load timers",
            "loadedPlacement": report["loadedPs"],
        }
        all_measured = [run for run in report["requestRuns"] if run["phase"] in ("prefix-disrupted", "warm")]
        report["errors"] = sum(not run["valid"] for run in all_measured)
        report["allGenerationErrors"] = sum(not run["valid"] for run in report["requestRuns"] + report["preflight"] + report["profileRuns"] + [report["warmup"]])
        report["measuredRequestCount"] = len(all_measured)
        report["semanticCorrectOutputs"] = sum(run.get("semanticCorrect") is True for run in all_measured) if arguments.expected_output is not None else None
        report["result"] = "passed" if report["errors"] == 0 else "inconclusive: failed measured requests"
        report["hookMedianMs"] = hook_ms
    except Exception as error:
        report["result"] = "failed"
        report["fatalError"] = f"{type(error).__name__}: {error}"
    finally:
        report["finalResources"] = resources()
        if loaded_by_this_run and not was_loaded:
            try:
                report["unloadReply"] = api(base, "/api/generate", {"model": MODEL, "keep_alive": 0, "stream": False})
                report["unloadedOnlyNewlyLoadedSmallModel"] = True
                deadline = time.monotonic() + 5
                while any(loaded.get("name") == MODEL or loaded.get("model") == MODEL for loaded in api(base, "/api/ps").get("models", [])):
                    if time.monotonic() >= deadline:
                        report["cleanupPending"] = "unload acknowledged but small model still appears in /api/ps"
                        break
                    time.sleep(0.1)
            except Exception as error:
                report["cleanupError"] = f"{type(error).__name__}: {error}"
        else:
            report["unloadedOnlyNewlyLoadedSmallModel"] = False
        report["finalPs"] = api(base, "/api/ps")
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="prompt JSON file, or - for stdin")
    parser.add_argument("--output", help="single JSON report file; otherwise stdout")
    parser.add_argument("--url", default="http://127.0.0.1:11434")
    parser.add_argument("--context", type=int, default=4096)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--expected-output", help="optional exact stripped one-token output, reported separately from timing validity")
    arguments = parser.parse_args()
    if arguments.context < 64 or arguments.threads < 1 or arguments.timeout <= 0:
        parser.error("context, threads and timeout must be positive")
    input_text = sys.stdin.read() if arguments.input == "-" else Path(arguments.input).read_text()
    data = json.loads(input_text)
    report = benchmark(arguments, data)
    report["inputFileSha256"] = hashlib.sha256(input_text.encode()).hexdigest()
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if arguments.output:
        Path(arguments.output).write_text(encoded)
        print(f"{report['result']}; report: {arguments.output}", file=sys.stderr)
    else:
        print(encoded, end="")
    if report["result"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
