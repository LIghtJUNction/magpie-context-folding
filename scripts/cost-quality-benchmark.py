#!/usr/bin/env python3
"""Compare initial-log disclosure with identical Luna repository reasoning tasks.

The answer checker runs independently after the model finishes. This is a small
repository-contract task, not a general intelligence benchmark or a dollar bill.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TASK = """Investigate six integration cases in THIS repository using actual source, not README claims. Write quality-answer.json at /workspace as a JSON object keyed by case ID. Each value must contain answer (one of the choices) and evidence (a nonempty list of {path, quote} objects with actual short verbatim source snippets explaining that answer). Do not change source, tests or infrastructure. Finish after writing and checking your JSON; independent verification runs afterward.
Cases:
1. offset_transfer: a client uses Python read nextOffset directly for TypeScript CLI pagination over emoji. Is it compatible? choices compatible/incompatible.
2. ordinary_read: root execute({action:'read',scope,id}) has no peek field. Does it persistently restore folding? choices restores/keeps_fold_state.
3. nested_resolve: Python resolve substitutes an outer archived body that itself contains a reference-shaped literal. Does it parse the returned body again? choices recursive/one_pass.
4. missing_shell: root onRequest receives annotations and only an unconfigured tool named custom_terminal. Does it change the payload? choices unchanged/folds.
5. force_forget: root forget with force absent sees an active folded group manifest but no folded entries. Is deletion allowed? choices allowed/rejected.
6. child_recovery: root read with peek:false selects an archived child shared by two enclosing annotation parents. Which parents remain folded? choices both/one/neither.
Use relevant src/tool.ts, src/context.hooks.ts, src/protocol.ts and context-folding/python/context_folding/core.py; search precise definitions instead of reading huge files blindly. Provide evidence for both backends where a case compares them. You have at most 10 model requests. No source edit is needed."""

# The model must also quote evidence from real source; an answer-only guess fails.
CASES = {
    "offset_transfer": ("incompatible", ["src/tool.ts", "context-folding/python/context_folding/core.py"]),
    "ordinary_read": ("keeps_fold_state", ["src/tool.ts"]),
    "nested_resolve": ("one_pass", ["context-folding/python/context_folding/core.py"]),
    "missing_shell": ("unchanged", ["src/context.hooks.ts", "src/protocol.ts"]),
    "force_forget": ("rejected", ["src/tool.ts"]),
    "child_recovery": ("neither", ["src/tool.ts"]),
}


def acceptance_command():
    code = '''import json,pathlib,sys
cases=json.loads(sys.argv[1]); data=json.loads(pathlib.Path('quality-answer.json').read_text()); checks={}
for key,(expected,paths) in cases.items():
 row=data.get(key,{}); evidence=row.get('evidence',[]); cited=set()
 for item in evidence:
  path=item.get('path'); quote=item.get('quote')
  if path in paths and isinstance(quote,str) and 12<=len(quote)<=1500 and quote in pathlib.Path(path).read_text(): cited.add(path)
 checks[key]=row.get('answer')==expected and set(paths)<=cited
print(json.dumps({'passed':sum(checks.values()),'total':len(checks),'checks':checks}))
sys.exit(0 if all(checks.values()) else 1)
'''
    return "python3 -I -c " + shlex.quote(code) + " " + shlex.quote(json.dumps(CASES))


def summarize(output):
    trials = []
    for path in sorted(output.glob("*/result.json")):
        result = json.loads(path.read_text())
        requests = result.get("requests", [])
        def total(field, nested=None):
            values = []
            for request in requests:
                usage = request.get("usage") or {}
                if nested:
                    usage = usage.get(nested) or {}
                values.append(usage.get(field))
            return sum(values) if values and all(type(value) is int for value in values) else None
        score = None
        try:
            score = json.loads(result.get("acceptance", {}).get("stdout", ""))
        except (ValueError, TypeError):
            pass
        trials.append({"trial": path.parent.name, "disclosure": result.get("verification_output"),
                       "verified": result.get("verified", False), "completion": result.get("completion"),
                       "candidate_checks": result.get("candidate_checks", 0),
                       "score": score, "requests": len(requests),
                       "verification_message_bytes": result.get("verification_message_bytes"),
                       "input_tokens": total("prompt_tokens"),
                       "cached_input_tokens": total("cached_tokens", "prompt_tokens_details"),
                       "output_tokens": total("completion_tokens"),
                       "wall_seconds": result.get("wall_seconds"),
                       "model_wall_seconds": sum(request["model_wall_seconds"] for request in requests)
                           if requests and all("model_wall_seconds" in request for request in requests) else None,
                       "model_reported": sorted({request.get("model_reported", "unknown") for request in requests}),
                       "source_snapshot_sha256": result.get("source", {}).get("snapshot_sha256"),
                       "excluded_paths": result.get("source", {}).get("excluded_paths", []),
                       "verification_environment": result.get("verification_environment"),
                       "error": result.get("error")})
    summary = {"model": "codex/gpt-6-luna", "trials": trials, "cost_usd": None,
               "limitation": "Six repository contract questions, two repetitions per disclosure; noisy small sample, no general intelligence or billing claim."}
    (output / "cost-quality-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--attempts", type=int, default=2, choices=[1, 2])
    parser.add_argument("--candidate-feedback", action="store_true", help="Test acceptance feedback with summary logs only")
    parser.add_argument("--summarize-only", action="store_true", help="Read completed results without model calls")
    args = parser.parse_args()
    if args.summarize_only:
        print(json.dumps(summarize(args.output), ensure_ascii=False))
        return 0
    command = [sys.executable, str(ROOT / "scripts/self-iterate.py"), "--output", str(args.output),
               "--modes", "baseline", "--compare-verification-output", "--iterations", str(args.attempts),
               "--max-turns", "10", "--allowed-path", "quality-answer.json",
               "--exclude-path", "scripts/cost-quality-benchmark.py",
               "--verify", "python3 -m unittest discover -s context-folding/tests -v",
               "--acceptance", acceptance_command(), "--task", TASK]
    if args.candidate_feedback:
        command.remove("--compare-verification-output")
        command.extend(["--verification-output", "summary", "--candidate-feedback"])
        command[command.index("--max-turns") + 1] = "14"
        command[command.index("--task") + 1] = TASK.replace("at most 10 model requests", "at most 14 model requests") + " Use check_candidate after writing your answer and before finalizing. If it reports failed cases, inspect the cited branches and correct only what source evidence supports, then check once more."
    result = subprocess.run(command, cwd=ROOT)
    summarize(args.output)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
