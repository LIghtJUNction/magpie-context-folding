#!/usr/bin/env python3
"""Measure supplied text with real BPE and calculate conditional folding costs.

Input: {"prompts": [{"label": "original", "text": "..."}, ...]}.
Each later prompt may supply markOutputText or markOutputTokens for the marking
operation that produced that layer. Missing operation bounds remain unknown.
Legacy mark/unfold/extra reserves and aggregate incremental bounds must cover
disjoint work. All prices are USD per million tokens. This script does not call
a model, count a provider's rendered request, or issue accounting certificates.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, getcontext, localcontext
from functools import wraps
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
    if not 0 <= number <= 9_007_199_254_740_991:
        raise argparse.ArgumentTypeError("expected a nonnegative safe integer")
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
        marking_tokens = None
        if "markOutputText" in prompt:
            if not isinstance(prompt["markOutputText"], str):
                raise ValueError("markOutputText must be a string")
            marking_tokens = len(encoding.encode(prompt["markOutputText"], disallowed_special=()))
        elif "markOutputTokens" in prompt:
            marking_tokens = prompt["markOutputTokens"]
            if (isinstance(marking_tokens, bool) or not isinstance(marking_tokens, int)
                    or not 0 <= marking_tokens <= 9_007_199_254_740_991):
                raise ValueError("markOutputTokens must be a nonnegative safe integer")
        if index == 0:
            if marking_tokens not in (None, 0):
                raise ValueError("the original baseline must not have a folding mark-output cost")
            marking_tokens = 0
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
                else "baseline_no_operation" if index == 0
                else "not_supplied_unknown"
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


def exact_tariff_arithmetic(function):
    @wraps(function)
    def calculate(*args, **kwargs):
        numbers = []

        def collect(value):
            if isinstance(value, dict):
                for item in value.values():
                    collect(item)
            elif type(value) is int or isinstance(value, Decimal):
                numbers.append(Decimal(value))

        collect({"args": dict(enumerate(args)), "kwargs": kwargs})
        # Costs only multiply integer counts by decimal tariffs, divide by 10^6,
        # and sum fewer than ten terms. Cover the complete exponent span plus
        # count digits and carry room; display percentages may still round.
        highest = max(value.adjusted() for value in numbers)
        lowest = min(value.as_tuple().exponent for value in numbers) - 6
        count_digits = max((len(str(value)) for value in numbers if value == value.to_integral_value()), default=1)
        with localcontext() as context:
            context.prec = max(60, highest - lowest + count_digits + 20)
            return function(*args, **kwargs)
    return calculate


@exact_tariff_arithmetic
def comparison(
    before: dict,
    after: dict,
    *,
    marking_tokens: int | None,
    input_price: Decimal,
    cached_price: Decimal,
    miss_price: Decimal,
    output_price: Decimal,
    extra_cost_usd: Decimal | None,
    unfold_input_tokens: int | None,
    unfold_output_tokens: int | None,
    incremental: dict,
    minimum_saving_usd: Decimal,
) -> dict:
    before_tokens, after_tokens = before["text_bpe_tokens"], after["text_bpe_tokens"]

    def token_cost(tokens: int | None, price: Decimal | None) -> Decimal | None:
        return None if tokens is None or price is None else Decimal(tokens) * price / MILLION

    def total(values: list[Decimal | None]) -> Decimal | None:
        return None if any(value is None for value in values) else sum(values, Decimal(0))

    def amount(value: Decimal | None) -> str | None:
        return None if value is None else money(value)

    marking_cost = token_cost(marking_tokens, output_price)
    # Restoration must cover every applicable input/cache tariff, not just ordinary input.
    restoration_price = max(input_price, cached_price, miss_price)
    unfold_input_cost = token_cost(unfold_input_tokens, restoration_price)
    unfold_output_cost = token_cost(unfold_output_tokens, output_price)
    configured_h = total([marking_cost, unfold_input_cost, unfold_output_cost, extra_cost_usd])
    incremental_input_cost = token_cost(incremental["inputTokens"], incremental["inputPricePerMillion"])
    incremental_output_cost = token_cost(incremental["outputTokens"], incremental["outputPricePerMillion"])
    missing = [key for key, value in {
        "markOutputTokens_or_markOutputText": marking_tokens,
        "unfoldInputTokens": unfold_input_tokens,
        "unfoldOutputTokens": unfold_output_tokens,
        "extraCostUsd": extra_cost_usd,
        **{f"incremental.{key}": value for key, value in incremental.items()},
    }.items() if value is None]
    full_h = None if missing else total([
        configured_h, incremental_input_cost, incremental_output_cost, incremental["toolFeesUsd"],
    ])
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
        for budget_name, h, required, scope in [
            ("input_only_H_zero", Decimal(0), [], "Input-only H=0 assumption; excludes all extra work and cannot establish task savings."),
            ("marking_output_only", marking_cost,
             ["markOutputTokens_or_markOutputText"] if marking_tokens is None else [],
             "Marking output only; excludes other extra work and cannot establish task savings."),
            ("marking_plus_configured_reserves", configured_h,
             [key for key in missing if not key.startswith("incremental.")],
             "Legacy disjoint mark/unfold/extra reserves only; excludes incremental work and cannot establish task savings."),
            ("full_work_cost", full_h, missing,
             "Conditional supplied-text tariff plus all declared extra-work bounds relative to completing the same task without folding. Not a complete-provider-input certificate or an unconditional task-saving claim."),
        ]:
            saving = None if h is None else gross_saving - h
            budgets[budget_name] = {
                "status": "unknown" if saving is None else "conditional",
                "missing_bounds": required,
                "non_input_overhead_H_usd": amount(h),
                "candidate_input_plus_H_usd": None if h is None else money(new_cost + h),
                "saving_usd": amount(saving),
                "saving_percent_of_baseline_input": (
                    format(saving * 100 / old_cost, ".6f") if saving is not None and old_cost else None
                ),
                "condition_strictly_above_minimum": None if saving is None else saving > minimum_saving_usd,
                "provider_task_saving_proven": False,
                "scope": scope,
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
            "mark_output_cost_usd": amount(marking_cost),
            "unfold_input_tokens_reserved": unfold_input_tokens,
            "unfold_input_price_per_million_usd": money(restoration_price),
            "unfold_input_cost_reserved_usd": amount(unfold_input_cost),
            "unfold_output_tokens_reserved": unfold_output_tokens,
            "unfold_output_cost_reserved_usd": amount(unfold_output_cost),
            "other_cost_reserved_usd": amount(extra_cost_usd),
            "legacy_total_H_usd": amount(configured_h),
            "incremental": {key: money(value) if isinstance(value, Decimal) else value
                            for key, value in incremental.items()},
            "incremental_input_cost_usd": amount(incremental_input_cost),
            "incremental_output_cost_usd": amount(incremental_output_cost),
            "total_H_usd": amount(full_h),
            "missing_bounds": missing,
            "formula": "H = disjoint legacy mark/unfold/extra reserves + aggregate incremental.inputTokens * incremental.inputPricePerMillion / 1e6 + aggregate incremental.outputTokens * incremental.outputPricePerMillion / 1e6 + aggregate incremental.toolFeesUsd; counts are descriptive, never cost multipliers",
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
            cumulative_marking = (None if cumulative_marking is None or marking is None
                                  else cumulative_marking + marking)
            common = {
                "input_price": profile["input"], "cached_price": profile["cached"],
                "miss_price": profile["miss"], "output_price": profile["output"],
                "extra_cost_usd": args.extra_cost_usd,
                "unfold_input_tokens": args.unfold_input_tokens,
                "unfold_output_tokens": args.unfold_output_tokens,
                "minimum_saving_usd": args.minimum_saving_usd,
                "incremental": {
                    "toolCalls": args.incremental_tool_calls,
                    "modelRoundTrips": args.incremental_model_round_trips,
                    "inputTokens": args.incremental_input_tokens,
                    "outputTokens": args.incremental_output_tokens,
                    "inputPricePerMillion": args.incremental_input_price_per_million,
                    "outputPricePerMillion": args.incremental_output_price_per_million,
                    "toolFeesUsd": args.incremental_tool_fees_usd,
                },
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
        "schema_version": 2,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "measurement": {
            "tokenizer": "o200k_base", "tiktoken_version": version("tiktoken"),
            "token_scope": "Exact BPE count of the supplied text, not complete API/provider input.",
            "provider_complete_billable_input_known": False,
            "provider_accounting_certificate": False,
            "marking_output_data_supplied_for_every_fold": all(
                row["mark_output_text_tokens_this_step"] is not None
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
            "Configured legacy reserves and incremental bounds are totals for each displayed comparison. Adjacent and cumulative views reuse these caller bounds; they are valid only if those bounds cover the entire relevant comparison, not per layer or per call.",
            "Input-only H=0 deliberately excludes all extra work; marking_plus_configured_reserves includes only legacy reserves. Neither proves complete task savings. full_work_cost requires every bound, including explicit zero bounds.",
            "Incremental toolCalls/modelRoundTrips describe additional work. inputTokens/outputTokens and toolFeesUsd are aggregate upper bounds, never multiplied by counts. Include complete resent histories, tool results, generated arguments/reasoning and other billable output, and all applicable price tiers.",
            "Legacy mark/unfold/extra reserves and incremental work must be disjoint. Reserve an item in exactly one group; explicitly supply zero in the other. CLI bounds apply separately to every displayed comparison, not as a sum across comparisons.",
            "Marking-output costs are a projection if the supplied marking text was generated offline rather than by the priced model. No paid model requests are made by this script.",
            "Missing marking output or any required legacy/incremental bound stays unknown, including zero-count work with unspecified prices or fees. Supplied marking text counts text only; reserve output wrappers/reasoning separately. If incremental.outputTokens includes marking, explicitly set legacy markOutputTokens to zero to avoid overlap.",
            "BPE counts exclude provider wrappers, tool rendering, hidden billable instructions, routing changes, and future middleware changes. They must not be submitted as strict whole-prompt certificates.",
            "Token and byte reductions are measured payload reductions. They do not establish faster model inference, lower end-to-end latency, equivalent answer quality, or net savings across an unbounded future task.",
            "Official prices are a dated reference snapshot, not a claim about the user's provider contract, gateway, or live invoice.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="JSON input path, or - for stdin")
    parser.add_argument("--extra-cost-usd", type=nonnegative_decimal, help="Legacy aggregate USD reserve disjoint from mark/unfold and incremental costs; omitted means unknown, supply 0 explicitly when bounded by zero")
    parser.add_argument("--unfold-input-tokens", type=nonnegative_int, help="Legacy aggregate restoration-input reserve per comparison at the maximum applicable input/cache rate; disjoint from incremental.inputTokens; omitted means unknown")
    parser.add_argument("--unfold-output-tokens", type=nonnegative_int, help="Legacy aggregate restoration-output reserve per comparison, disjoint from incremental.outputTokens; omitted means unknown")
    parser.add_argument("--incremental-tool-calls", type=nonnegative_int, help="Upper bound on additional tool calls relative to the same task without folding; descriptive count, not a fee multiplier")
    parser.add_argument("--incremental-model-round-trips", type=nonnegative_int, help="Upper bound on additional model round trips; descriptive count, not a token/cost multiplier")
    parser.add_argument("--incremental-input-tokens", type=nonnegative_int, help="Aggregate extra input-token upper bound including complete resent histories and tool results")
    parser.add_argument("--incremental-output-tokens", type=nonnegative_int, help="Aggregate extra billable output-token upper bound, disjoint from legacy marking and restoration output")
    parser.add_argument("--incremental-input-price-per-million", type=nonnegative_decimal, help="Extra input-price upper bound covering all applicable cache/input tiers; not inferred from the reference profiles")
    parser.add_argument("--incremental-output-price-per-million", type=nonnegative_decimal, help="Extra output-price upper bound; required even when output tokens are explicitly zero")
    parser.add_argument("--incremental-tool-fees-usd", type=nonnegative_decimal, help="Aggregate direct tool-fee upper bound in USD, disjoint from --extra-cost-usd; never multiplied by call counts")
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
