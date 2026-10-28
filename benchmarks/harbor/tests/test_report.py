"""Measurement coverage and comparison validity, without Harbor or a provider."""
import json
from pathlib import Path
import tempfile
import unittest

from magpie_harbor.report import build_report


def trial(name, mode="baseline", tokens=100, reward=1):
    return {"id": name, "trial_name": name, "task_name": "task", "task_checksum": "abc",
            "finished_at": "2026-10-28T00:00:00Z",
            "config": {"trial_name": name, "job_id": "job", "task": {"path": "/tmp/task"},
                       "agent": {"import_path": "magpie_harbor.agent:Agent", "model_name": "model",
                                 "kwargs": {"mode": mode, "max_steps": 20}},
                       "environment": {"type": "docker"}},
            "agent_info": {"name": "agent", "version": "1", "model_info": {"provider": "p", "name": "m"}},
            "agent_result": {"n_input_tokens": tokens, "n_output_tokens": 20, "n_cache_tokens": None,
                             "cost_usd": None, "metadata": {"magpie_harbor": {
                                 "mode": mode, "source_revision": "a" * 40, "measurement": "model",
                                 "source_tree_sha256": "a" * 64, "endpoint_sha256": "b" * 64,
                                 "usage_complete": True, "requests": 3, "recovery_calls": 0}}},
            "verifier_result": {"rewards": {"reward": reward}}, "exception_info": None}


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def report(self, records, expected=None, root=None):
        root = root or self.root
        root.mkdir(exist_ok=True)
        (root / "lock.json").write_text(json.dumps({"trials": [{}] * (len(records) if expected is None else expected)}))
        for record in records:
            path = root / record["trial_name"] / "result.json"
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps(record))
        return build_report([root])

    def test_mean_delta_uses_complete_same_configuration_cohort(self):
        report = self.report([trial("b"), trial("f", "folding", tokens=60)])
        comparison = report["comparisons"][0]
        self.assertTrue(comparison["eligible"])
        self.assertEqual(comparison["mean_deltas_folding_minus_baseline"]["n_input_tokens"], -40)
        self.assertIsNone(comparison["mean_deltas_folding_minus_baseline"]["cost_usd"])
        self.assertIsNone(report["groups"][0]["metrics"]["n_cache_tokens"]["total"])

    def test_partial_usage_is_not_complete_total_or_zero(self):
        missing = trial("b2", tokens=None)
        report = self.report([trial("b1"), missing])
        metric = report["groups"][0]["metrics"]["n_input_tokens"]
        self.assertEqual(metric["observed_trials"], 1)
        self.assertEqual(metric["observed_sum"], 100)
        self.assertIsNone(metric["total"])
        self.assertIsNone(metric["mean"])

    def test_errors_and_unscored_remain_in_denominator(self):
        errored, missing, unfinished = trial("error"), trial("unscored"), trial("unfinished")
        errored["exception_info"] = {"exception_type": "EnvironmentStartError"}
        missing["verifier_result"] = None
        unfinished["finished_at"] = None
        report = self.report([trial("pass"), trial("fail", reward=0), errored, missing, unfinished])
        group = report["groups"][0]
        self.assertEqual(group["attempts"], 5)
        self.assertEqual(group["success_rate_all_observed_attempts"], .2)
        self.assertEqual((group["errors"], group["unscored"], group["unfinished"], group["failed_tasks"]), (1, 1, 1, 1))

    def test_failures_do_not_produce_survivor_only_savings(self):
        report = self.report([trial("b"), trial("f", "folding", tokens=1, reward=0)])
        self.assertFalse(report["comparisons"][0]["eligible"])
        self.assertEqual(report["comparisons"][0]["mean_deltas_folding_minus_baseline"], {})

    def test_setup_error_without_agent_metadata_blocks_survivor_cohort_comparison(self):
        error = trial("setup-error", "folding")
        error["agent_result"] = None
        error["exception_info"] = {"exception_type": "EnvironmentStartError"}
        report = self.report([trial("b"), trial("f", "folding"), error])
        self.assertFalse(any(c["eligible"] for c in report["comparisons"]))
        totals = next(g for g in report["totals_by_mode"] if g["mode"] == "folding")
        self.assertEqual(totals["attempts"], 2)
        self.assertEqual(totals["success_rate_all_observed_attempts"], .5)

    def test_mismatched_task_model_configuration_and_revision_never_compare(self):
        variants = []
        for name in ("task", "model", "config", "source", "endpoint", "dirty-tree"):
            record = trial(name, "folding")
            if name == "task": record["task_checksum"] = "changed"
            if name == "model": record["agent_info"]["model_info"]["name"] = "other"
            if name == "config": record["config"]["agent"]["kwargs"]["max_steps"] = 40
            if name == "source": record["agent_result"]["metadata"]["magpie_harbor"]["source_revision"] = "other"
            if name == "endpoint": record["agent_result"]["metadata"]["magpie_harbor"]["endpoint_sha256"] = "c" * 64
            if name == "dirty-tree": record["agent_result"]["metadata"]["magpie_harbor"]["source_tree_sha256"] = "d" * 64
            variants.append(record)
        report = self.report([trial("b"), *variants])
        self.assertEqual(len(report["comparisons"]), 7)
        self.assertFalse(any(item["eligible"] for item in report["comparisons"]))

    def test_unknown_manifest_and_missing_expected_results_block_comparison(self):
        report = self.report([trial("b"), trial("f", "folding")], expected=3)
        self.assertFalse(report["comparisons"][0]["eligible"])
        (self.root / "lock.json").unlink()
        report = build_report([self.root])
        self.assertTrue(report["warnings"])
        self.assertFalse(report["comparisons"][0]["eligible"])

    def test_ignores_root_and_nested_archives_but_rejects_duplicate_uuid(self):
        self.report([trial("b")])
        (self.root / "result.json").write_text('{"n_total_trials": 999}')
        nested = self.root / "b" / "retry-1" / "result.json"
        nested.parent.mkdir()
        nested.write_text(json.dumps(trial("b")))
        self.assertEqual(build_report([self.root, self.root])["groups"][0]["attempts"], 1)
        copy = trial("copy")
        copy["id"] = "b"
        with self.assertRaisesRegex(ValueError, "Duplicate trial"):
            self.report([copy])

    def test_scripted_measurement_never_claims_model_efficiency(self):
        records = [trial("b"), trial("f", "folding")]
        for record in records:
            record["agent_result"]["metadata"]["magpie_harbor"]["measurement"] = "scripted-smoke"
        self.assertFalse(self.report(records)["comparisons"][0]["eligible"])

    def test_unknown_source_and_absent_tree_or_endpoint_fingerprints_block_efficiency(self):
        for field, value in (("source_revision", "unknown"), ("source_tree_sha256", None), ("endpoint_sha256", None)):
            with self.subTest(field=field):
                records = [trial("b"), trial("f", "folding")]
                for record in records:
                    record["agent_result"]["metadata"]["magpie_harbor"][field] = value
                self.assertFalse(self.report(records)["comparisons"][0]["eligible"])

    def test_partial_request_usage_declared_in_metadata_withholds_usage_delta(self):
        folded = trial("f", "folding", tokens=30)
        folded["agent_result"]["metadata"]["magpie_harbor"]["usage_complete"] = False
        report = self.report([trial("b"), folded])
        self.assertFalse(report["comparisons"][0]["eligible"])
        self.assertEqual(report["comparisons"][0]["mean_deltas_folding_minus_baseline"], {})

    def test_invalid_number_and_mode_mismatch_are_not_silent(self):
        record = trial("b", tokens=True, reward=float("nan"))
        report = self.report([record])
        self.assertEqual(report["groups"][0]["unscored"], 1)
        self.assertIsNone(report["groups"][0]["metrics"]["n_input_tokens"]["total"])
        record["agent_result"]["metadata"]["magpie_harbor"]["mode"] = "folding"
        with self.assertRaisesRegex(ValueError, "Mode differs"):
            self.report([record])


if __name__ == "__main__":
    unittest.main()
