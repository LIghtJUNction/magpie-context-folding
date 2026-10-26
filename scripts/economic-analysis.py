#!/usr/bin/env python3
"""Measure supplied text with real BPE and calculate conditional folding costs.

Input: {"prompts": [{"label": "original", "text": "..."}, ...]}.
Each later prompt may supply markOutputText or markOutputTokens for the marking
operation that produced that layer. All prices are USD per million tokens.
This script does not call a model, count a provider's rendered request, or issue
the accounting certificates required by the plugin's strict gate.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, getcontext
from importlib.metadata import version
import json
from pathlib import Path
import sys
from time import perf_counter_ns

import tiktoken


getcontext().prec = 60
MILLION = Decimal(1_000_000)
SNAPSHOT_DATE = "2026-10-26"
MODEL_SOURCE = "https://developers.openai.com/api/docs/models/gpt-4.1"
CACHE_SOURCE = "https://developers.openai.com/api/docs/guides/prompt-caching"


def nonnegative_decimal(value: str) -> Decimal:
    try:
        number = Decimal(value)
    except Exception as error:
        raise argparse.ArgumentTypeError("expected a finite nonnegative decimal") from error
    if not number.is_finite() or number < 0:
        raise argparse.ArgumentTypeError("expected a finite nonnegative decimal")
    return number


def nonnegative_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a nonnegative integer") from error
    if number < 0:
        raise argparse.ArgumentTypeError("expected a nonnegative integer")
    return number


def money(value: Decimal) -> str:
    return "0" if value == 0 else format(value, "f")


def percentage(removed: int, original: int) -> str | None:
    if original == 0:
        return None
    return format(Decimal(removed) * 100 / Decimal(original), ".6f")


def count_prompts(payload: object) -> list[dict]:
    if not isinstance(payload, dict) or not isinstance(payload.get("prompts"), list):
        raise ValueError("input must contain a prompts array")
    if len(payload["prompts"]) < 2:
        raise ValueError("provide the original prompt and at least one folded prompt")
    encoding = tiktoken.get_encoding("o200k_base")
    measurements: list[dict] = []
    labels: set[str] = set()
    for index, prompt in enumerate(payload["prompts"]):
        if not isinstance(prompt, dict):
            raise ValueError(f"prompts[{index}] must be an object")
        label, text = prompt.get("label"), prompt.get("text")
        if not isinstance(label, str) or not label or label in labels:
            raise ValueError(f"prompts[{index}] needs a unique nonempty label")
        if not isinstance(text, str):
            raise ValueError(f"prompts[{index}].text must be a string")
        if "markOutputText" in prompt and "markOutputTokens" in prompt:
            raise ValueError("provide markOutputText or markOutputTokens, not both")
        marking_text = prompt.get("markOutputText", "")
        if not isinstance(marking_text, str):
            raise ValueError("markOutputText must be a string")
        marking_tokens = prompt.get("markOutputTokens")
        if marking_tokens is None:
            marking_tokens = len(encoding.encode(marking_text, disallowed_special=()))
        if isinstance(marking_tokens, bool) or not isinstance(marking_tokens, int) or marking_tokens < 0:
            raise ValueError("markOutputTokens must be a nonnegative integer")
        if index == 0 and marking_tokens:
            raise ValueError("the original baseline must not have a folding mark-output cost")
        started = perf_counter_ns()
        tokens = len(encoding.encode(text, disallowed_special=()))
        elapsed_ns = perf_counter_ns() - started
        labels.add(label)
        measurements.append({
            "label": label,
            "text_bpe_tokens": tokens,
            "utf8_bytes": len(text.encode("utf-8")),
            "unicode_codepoints": len(text),
            "bpe_encoding_elapsed_ms_single_sample": elapsed_ns / 1_000_000,
            "mark_output_text_tokens_this_step": marking_tokens,
            "mark_output_count_source": (
                "supplied_count" if "markOutputTokens" in prompt
                else "o200k_base_text" if "markOutputText" in prompt
                else "not_supplied_assumed_zero"
            ),
        })
    original = measurements[0]
    for index, measurement in enumerate(measurements):
        previous = measurements[max(0, index - 1)]
        measurement["tokens_removed_vs_original"] = original["text_bpe_tokens"] - measurement["text_bpe_tokens"]
        measurement["token_reduction_vs_original_percent"] = percentage(
            measurement["tokens_removed_vs_original"], original["text_bpe_tokens"],
        )
        measurement["tokens_removed_vs_previous"] = previous["text_bpe_tokens"] - measurement["text_bpe_tokens"]
        measurement["token_reduction_vs_previous_percent"] = percentage(
            measurement["tokens_removed_vs_previous"], previous["text_bpe_tokens"],
        )
        measurement["utf8_reduction_vs_original_percent"] = percentage(
            original["utf8_bytes"] - measurement["utf8_bytes"], original["utf8_bytes"],
        )
    return measurements


def comparison(
    before: dict,
    after: dict,
    *,
    marking_tokens: int,
    input_price: Decimal,
    cached_price: Decimal,
    miss_price: Decimal,
    output_price: Decimal,
    extra_cost_usd: Decimal,
    unfold_input_tokens: int,
    unfold_output_tokens: int,
    minimum_saving_usd: Decimal,
) -> dict:
    before_tokens, after_tokens = before["text_bpe_tokens"], after["text_bpe_tokens"]
    marking_cost = Decimal(marking_tokens) * output_price / MILLION
    unfold_input_cost = Decimal(unfold_input_tokens) * miss_price / MILLION
    unfold_output_cost = Decimal(unfold_output_tokens) * output_price / MILLION
    configured_h = marking_cost + unfold_input_cost + unfold_output_cost + extra_cost_usd
    scenarios: dict = {}
    for name, old_price, new_price in [
        ("both_ordinary_input_no_write_premium", input_price, input_price),
        ("baseline_ordinary_candidate_maximum_miss", input_price, miss_price),
        ("baseline_all_cached_candidate_all_miss", cached_price, miss_price),
    ]:
        old_cost = Decimal(before_tokens) * old_price / MILLION
        new_cost = Decimal(after_tokens) * new_price / MILLION
        gross_saving = old_cost - new_cost
        budgets: dict = {}
        for budget_name, h in [
            ("input_only_H_zero", Decimal(0)),
            ("marking_output_only", marking_cost),
            ("marking_plus_configured_reserves", configured_h),
        ]:
            saving = gross_saving - h
            budgets[budget_name] = {
                "non_input_overhead_H_usd": money(h),
                "candidate_input_plus_H_usd": money(new_cost + h),
                "saving_usd": money(saving),
                "saving_percent_of_baseline_input": (
                    format(saving * 100 / old_cost, ".6f") if old_cost else None
                ),
                "condition_strictly_above_minimum": saving > minimum_saving_usd,
                "scope": "Conditional text-tariff calculation only; not a provider accounting certificate.",
            }
        scenarios[name] = {
            "baseline_input_price_per_million_usd": money(old_price),
            "candidate_input_price_per_million_usd": money(new_price),
            "baseline_text_input_cost_usd": money(old_cost),
            "candidate_text_input_cost_usd": money(new_cost),
            "gross_text_input_saving_usd": money(gross_saving),
            "total_H_must_be_strictly_below_usd_for_positive_saving": money(gross_saving),
            "overhead_scenarios": budgets,
        }
    return {
        "before": before["label"], "after": after["label"],
        "before_text_tokens": before_tokens, "after_text_tokens": after_tokens,
        "minimum_saving_usd": money(minimum_saving_usd),
        "operation_budget_components": {
            "mark_output_tokens": marking_tokens,
            "mark_output_cost_usd": money(marking_cost),
            "unfold_input_tokens_reserved": unfold_input_tokens,
            "unfold_input_cost_reserved_usd": money(unfold_input_cost),
            "unfold_output_tokens_reserved": unfold_output_tokens,
            "unfold_output_cost_reserved_usd": money(unfold_output_cost),
            "other_cost_reserved_usd": money(extra_cost_usd),
            "total_H_usd": money(configured_h),
            "formula": "H = mark_output_tokens * output_price / 1e6 + unfold_input_tokens * miss_price / 1e6 + unfold_output_tokens * output_price / 1e6 + other_cost_reserve",
        },
        "scenarios": scenarios,
    }


def analyze(measurements: list[dict], args: argparse.Namespace) -> dict:
    profiles = [
        {
            "name": "openai_gpt_4_1_price_snapshot",
            "model": "gpt-4.1",
            "price_kind": "Official standard text tariff snapshot; reference only, not a model recommendation.",
            "source_model_status": "Model page marked Deprecated on the snapshot date.",
            "input": Decimal("2"), "cached": Decimal("0.5"),
            "miss": Decimal("2"), "output": Decimal("8"),
            "cache_write_assumption": "Official guide lists no additional cache-write charge for earlier models; cold/write cost uses the ordinary input rate.",
            "sources": [MODEL_SOURCE, CACHE_SOURCE],
            "source_checked_on": SNAPSHOT_DATE,
        },
        {
            "name": "normalized_synthetic_strong_cache",
            "model": None,
            "price_kind": "Synthetic normalized tariff, not a provider quote.",
            "input": Decimal("1"), "cached": Decimal("0.1"),
            "miss": Decimal("1.25"), "output": Decimal("5"),
            "cache_write_assumption": "Assumed maximum miss/write charge 1.25x ordinary input; assumed output charge 5x input. USD units are illustrative.",
            "sources": [], "source_checked_on": None,
        },
    ]
    results: list[dict] = []
    for profile in profiles:
        incremental: list[dict] = []
        cumulative: list[dict] = []
        cumulative_marking = 0
        for index in range(1, len(measurements)):
            current = measurements[index]
            marking = current["mark_output_text_tokens_this_step"]
            cumulative_marking += marking
            common = {
                "input_price": profile["input"], "cached_price": profile["cached"],
                "miss_price": profile["miss"], "output_price": profile["output"],
                "extra_cost_usd": args.extra_cost_usd,
                "unfold_input_tokens": args.unfold_input_tokens,
                "unfold_output_tokens": args.unfold_output_tokens,
                "minimum_saving_usd": args.minimum_saving_usd,
            }
            incremental.append(comparison(measurements[index - 1], current, marking_tokens=marking, **common))
            cumulative.append(comparison(measurements[0], current, marking_tokens=cumulative_marking, **common))
        results.append({
            **{key: value for key, value in profile.items() if key not in {"input", "cached", "miss", "output"}},
            "prices_usd_per_million": {
                "ordinary_input": money(profile["input"]), "cached_input": money(profile["cached"]),
                "maximum_miss_or_write": money(profile["miss"]), "output": money(profile["output"]),
            },
            "incremental_previous_layer_to_current": incremental,
            "cumulative_original_to_current": cumulative,
        })
    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "measurement": {
            "tokenizer": "o200k_base", "tiktoken_version": version("tiktoken"),
            "token_scope": "Exact BPE count of the supplied text, not complete API/provider input.",
            "provider_complete_billable_input_known": False,
            "provider_accounting_certificate": False,
            "marking_output_data_supplied_for_every_fold": all(
                row["mark_output_count_source"] != "not_supplied_assumed_zero"
                for row in measurements[1:]
            ),
            "timing_scope": "Single local text-encoding sample; not model prefill, TTFT, or generation latency.",
            "financial_precision": "Python Decimal; exact decimal tariff arithmetic, strictly positive threshold, no float-money comparisons.",
        },
        "text_measurements": measurements,
        "profiles": results,
        "interpretation": [
            "The first prompt is the original; later prompts are successive actual representations supplied by the caller.",
            "Adjacent-layer and original-to-layer comparisons are alternative views of one hypothetical next input request. Never add their savings together.",
            "Incremental comparisons charge only the current marking output; original-to-layer comparisons charge cumulative marking output. Neither view sums hypothetical savings from earlier requests.",
            "Configured unfold token budgets and the other-cost reserve are one comparison's total reserve, not a guarantee that future unfolding is bounded. Default zero means no such reserve was supplied.",
            "Input-only H=0 deliberately excludes marking and unfolding. Use marking_plus_configured_reserves to include declared operation costs.",
            "Marking-output costs are a projection if the supplied marking text was generated offline rather than by the priced model. No paid model requests are made by this script.",
            "If marking output is not supplied its cost is assumed zero, not measured. Supplied tool-argument text also excludes any additional billed output wrappers or reasoning; budget those separately when applicable.",
            "BPE counts exclude provider wrappers, tool rendering, hidden billable instructions, routing changes, and future middleware changes. They must not be submitted as strict whole-prompt certificates.",
            "Token and byte reductions are measured payload reductions. They do not establish faster model inference, lower end-to-end latency, equivalent answer quality, or net savings across an unbounded future task.",
            "Official prices are a dated reference snapshot, not a claim about the user's provider contract, gateway, or live invoice.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="JSON input path, or - for stdin")
    parser.add_argument("--extra-cost-usd", type=nonnegative_decimal, default=Decimal(0), help="Additional USD operation reserve beyond explicitly counted marking output and unfold token reserves; total H is their sum")
    parser.add_argument("--unfold-input-tokens", type=nonnegative_int, default=0, help="Configured future unfolding-input token reserve per comparison, charged at the maximum miss/write rate")
    parser.add_argument("--unfold-output-tokens", type=nonnegative_int, default=0, help="Configured extra generated-output token reserve per comparison")
    parser.add_argument("--minimum-saving-usd", type=nonnegative_decimal, default=Decimal(0), help="Saving must be strictly greater than this amount; equality fails")
    args = parser.parse_args()
    try:
        source = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        payload = json.loads(source)
        result = analyze(count_prompts(payload), args)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
