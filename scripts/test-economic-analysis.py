#!/usr/bin/env python3
"""Focused offline checks; run with an existing Python environment containing tiktoken."""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("economic-analysis.py")
spec = importlib.util.spec_from_file_location("economic_analysis", SCRIPT)
economic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(economic)


class EconomicAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.bounds = {
            "marking_tokens": 0,
            "input_price": Decimal("1"),
            "cached_price": Decimal("0.1"),
            "miss_price": Decimal("1.25"),
            "output_price": Decimal("2"),
            "extra_cost_usd": Decimal(0),
            "unfold_input_tokens": 0,
            "unfold_output_tokens": 0,
            "incremental": {
                "toolCalls": 0, "modelRoundTrips": 0,
                "inputTokens": 0, "outputTokens": 0,
                "inputPricePerMillion": Decimal("1.25"),
                "outputPricePerMillion": Decimal("2"), "toolFeesUsd": Decimal(0),
            },
            "minimum_saving_usd": Decimal(0),
        }
        self.payload = {"prompts": [
            {"label": "original", "text": "original history " * 100},
            {"label": "folded", "text": "summary", "markOutputTokens": 0},
        ]}
        self.flags = [
            "--extra-cost-usd", "0", "--unfold-input-tokens", "0",
            "--unfold-output-tokens", "0", "--incremental-tool-calls", "0",
            "--incremental-model-round-trips", "0", "--incremental-input-tokens", "0",
            "--incremental-output-tokens", "0", "--incremental-input-price-per-million", "1.25",
            "--incremental-output-price-per-million", "2", "--incremental-tool-fees-usd", "0",
        ]

    def compare(self, bounds=None):
        return economic.comparison(
            {"label": "before", "text_bpe_tokens": 10_000},
            {"label": "after", "text_bpe_tokens": 200},
            **(self.bounds if bounds is None else bounds),
        )

    def budget(self, result, name="full_work_cost"):
        return result["scenarios"]["baseline_all_cached_candidate_all_miss"]["overhead_scenarios"][name]

    def cli(self, flags=None, payload=None):
        return subprocess.run(
            [sys.executable, "-I", "-B", str(SCRIPT), *(flags or [])],
            input=json.dumps(self.payload if payload is None else payload),
            text=True, capture_output=True, check=False,
        )

    def test_extra_round_trip_overturns_input_saving(self):
        self.bounds["incremental"].update(modelRoundTrips=1, inputTokens=1000)
        result = self.compare()
        self.assertTrue(self.budget(result, "input_only_H_zero")["condition_strictly_above_minimum"])
        full = self.budget(result)
        self.assertEqual(Decimal(full["saving_usd"]), Decimal("-0.0005"))
        self.assertFalse(full["condition_strictly_above_minimum"])

    def test_aggregate_costs_are_not_multiplied_by_counts(self):
        self.bounds["incremental"].update(
            toolCalls=1, modelRoundTrips=1, inputTokens=100,
            outputTokens=50, toolFeesUsd=Decimal("0.00001"),
        )
        first = self.budget(self.compare())
        self.assertEqual(Decimal(first["non_input_overhead_H_usd"]), Decimal("0.000235"))
        self.bounds["incremental"].update(toolCalls=17, modelRoundTrips=23)
        self.assertEqual(first, self.budget(self.compare()))

    def test_each_required_bound_is_unknown_even_with_zero_counts(self):
        for key in ["marking_tokens", "extra_cost_usd", "unfold_input_tokens", "unfold_output_tokens"]:
            with self.subTest(key=key):
                bounds = deepcopy(self.bounds)
                bounds[key] = None
                self.assert_unknown(self.budget(self.compare(bounds)))
        for key in self.bounds["incremental"]:
            with self.subTest(key=key):
                bounds = deepcopy(self.bounds)
                bounds["incremental"][key] = None
                budget = self.budget(self.compare(bounds))
                self.assert_unknown(budget)
                self.assertIn(f"incremental.{key}", budget["missing_bounds"])

    def assert_unknown(self, budget):
        self.assertEqual(budget["status"], "unknown")
        self.assertTrue(budget["missing_bounds"])
        self.assertIsNone(budget["non_input_overhead_H_usd"])
        self.assertIsNone(budget["candidate_input_plus_H_usd"])
        self.assertIsNone(budget["saving_usd"])
        self.assertIsNone(budget["condition_strictly_above_minimum"])
        self.assertFalse(budget["provider_task_saving_proven"])

    def test_restoration_uses_maximum_applicable_price(self):
        self.bounds.update(
            marking_tokens=100, extra_cost_usd=Decimal("0.0001"), unfold_input_tokens=50,
        )
        result = self.compare()
        self.assertEqual(result["operation_budget_components"]["unfold_input_price_per_million_usd"], "1.25")
        self.assertEqual(Decimal(self.budget(result)["saving_usd"]), Decimal("0.0003875"))
        # Cache-read prices are also applicable to restoration, even for unusual synthetic tariffs.
        self.bounds["cached_price"] = Decimal("3")
        result = self.compare()
        self.assertEqual(result["operation_budget_components"]["unfold_input_price_per_million_usd"], "3")

    def test_same_cost_in_legacy_or_incremental_is_counted_once(self):
        self.bounds.update(marking_tokens=100, unfold_input_tokens=50, extra_cost_usd=Decimal("0.0001"))
        legacy = self.budget(self.compare())
        self.bounds.update(marking_tokens=0, unfold_input_tokens=0, extra_cost_usd=Decimal(0))
        self.bounds["incremental"].update(inputTokens=50, outputTokens=100, toolFeesUsd=Decimal("0.0001"))
        self.assertEqual(legacy, self.budget(self.compare()))

    def test_equality_with_minimum_rejects(self):
        self.bounds["minimum_saving_usd"] = Decimal("0.00075")
        self.assertFalse(self.budget(self.compare())["condition_strictly_above_minimum"])

    def test_subprecision_fee_and_long_minimum_compare_exactly(self):
        from fractions import Fraction

        for exponent in (70, 150):
            with self.subTest(exponent=exponent):
                fee = Decimal(f"1e-{exponent}")
                minimum = Decimal("0.00074" + "9" * (exponent + 10))
                self.bounds["incremental"]["toolFeesUsd"] = fee
                self.bounds["minimum_saving_usd"] = minimum
                budget = self.budget(self.compare())
                expected = Fraction(Decimal("0.00075")) - Fraction(fee)
                self.assertEqual(Fraction(Decimal(budget["saving_usd"])), expected)
                self.assertFalse(expected > Fraction(minimum))
                self.assertFalse(budget["condition_strictly_above_minimum"])
                self.bounds["incremental"]["toolFeesUsd"] = Decimal(0)
                self.assertTrue(self.budget(self.compare())["condition_strictly_above_minimum"])

    def test_real_cli_explicit_bounds_and_unknown_defaults(self):
        complete = self.cli(self.flags)
        self.assertEqual(complete.returncode, 0, complete.stderr)
        result = json.loads(complete.stdout)
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["text_measurements"][0]["text_bpe_tokens"], 201)
        self.assertEqual(result["text_measurements"][1]["text_bpe_tokens"], 1)
        comparison = result["profiles"][0]["incremental_previous_layer_to_current"][0]
        self.assertEqual(self.budget(comparison)["status"], "conditional")
        self.assertFalse(self.budget(comparison)["provider_task_saving_proven"])
        partial = self.cli()
        self.assertEqual(partial.returncode, 0, partial.stderr)
        comparison = json.loads(partial.stdout)["profiles"][0]["incremental_previous_layer_to_current"][0]
        self.assert_unknown(self.budget(comparison))
        self.assertEqual(self.budget(comparison, "input_only_H_zero")["status"], "conditional")

    def test_real_cli_round_trip_and_aggregate_totals(self):
        flags = list(self.flags)
        for flag, value in [
            ("--incremental-model-round-trips", "1"),
            ("--incremental-tool-calls", "1"),
            ("--incremental-input-tokens", "1000"),
            ("--incremental-output-tokens", "20"),
            ("--incremental-tool-fees-usd", "0.001"),
        ]:
            flags[flags.index(flag) + 1] = value
        completed = self.cli(flags)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        comparison = json.loads(completed.stdout)["profiles"][0]["incremental_previous_layer_to_current"][0]
        first = self.budget(comparison)
        self.assertTrue(self.budget(comparison, "input_only_H_zero")["condition_strictly_above_minimum"])
        self.assertFalse(first["condition_strictly_above_minimum"])
        self.assertEqual(Decimal(first["non_input_overhead_H_usd"]), Decimal("0.00229"))
        flags[flags.index("--incremental-model-round-trips") + 1] = "23"
        flags[flags.index("--incremental-tool-calls") + 1] = "17"
        completed = self.cli(flags)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        comparison = json.loads(completed.stdout)["profiles"][0]["incremental_previous_layer_to_current"][0]
        self.assertEqual(first, self.budget(comparison))

    def test_real_cli_each_missing_flag_is_unknown(self):
        for index in range(0, len(self.flags), 2):
            with self.subTest(flag=self.flags[index]):
                completed = self.cli(self.flags[:index] + self.flags[index + 2:])
                self.assertEqual(completed.returncode, 0, completed.stderr)
                comparison = json.loads(completed.stdout)["profiles"][0]["incremental_previous_layer_to_current"][0]
                self.assert_unknown(self.budget(comparison))

    def test_missing_mark_propagates_to_cumulative_only(self):
        del self.payload["prompts"][1]["markOutputTokens"]
        self.payload["prompts"].append({"label": "second", "text": "small", "markOutputTokens": 0})
        completed = self.cli(self.flags)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertIsNone(result["text_measurements"][1]["mark_output_text_tokens_this_step"])
        profile = result["profiles"][0]
        self.assert_unknown(self.budget(profile["incremental_previous_layer_to_current"][0]))
        self.assert_unknown(self.budget(profile["cumulative_original_to_current"][1]))
        self.assertEqual(self.budget(profile["incremental_previous_layer_to_current"][1])["status"], "conditional")

    def test_invalid_cli_bounds_reject(self):
        cases = [
            ("--incremental-tool-calls", "-1"),
            ("--incremental-model-round-trips", "0.5"),
            ("--incremental-input-tokens", "9007199254740992"),
            ("--incremental-output-tokens", "NaN"),
            ("--incremental-input-price-per-million", "nan"),
            ("--incremental-output-price-per-million", "Infinity"),
            ("--incremental-tool-fees-usd", "-0.01"),
            ("--extra-cost-usd", "NaN"), ("--unfold-input-tokens", "-1"),
            ("--minimum-saving-usd", "-1"),
        ]
        for flag, value in cases:
            with self.subTest(flag=flag):
                completed = self.cli([flag, value])
                self.assertEqual(completed.returncode, 2)
                self.assertIn("error:", completed.stderr)
                self.assertEqual(completed.stdout, "")

    def test_invalid_mark_data_rejects(self):
        for value in [True, None, -1, 1.2, 9007199254740992]:
            with self.subTest(value=value):
                self.payload["prompts"][1]["markOutputTokens"] = value
                completed = self.cli(self.flags)
                self.assertEqual(completed.returncode, 2, completed.stderr)
        self.payload["prompts"][1].update(markOutputTokens=0, markOutputText="duplicate")
        self.assertEqual(self.cli(self.flags).returncode, 2)
        self.payload["prompts"][1].pop("markOutputText")
        self.payload["prompts"][0]["markOutputTokens"] = 1
        self.assertEqual(self.cli(self.flags).returncode, 2)


if __name__ == "__main__":
    unittest.main()
