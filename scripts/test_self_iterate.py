"""Controller regressions; no model or network requests."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
from unittest.mock import AsyncMock, patch
import urllib.request
import unittest

spec = importlib.util.spec_from_file_location("self_iterate", Path(__file__).with_name("self-iterate.py"))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_shared_controller_prompt_does_not_prime_folding_markers(self):
        prompt = controller.agent_system_prompt()
        self.assertNotIn("@context-fold", prompt)
        self.assertNotIn("context_folding", prompt)

    def test_fatal_model_http_errors_can_stop_duplicate_trials(self):
        for status in (401, 403, 404):
            with self.subTest(status=status):
                self.assertEqual(controller.fatal_model_status({"error": f"Model HTTP {status}; not retried"}), status)
        for status in (408, 429, 500, 503):
            with self.subTest(status=status):
                self.assertIsNone(controller.fatal_model_status({"error": f"Model HTTP {status}; not retried"}))
        self.assertIsNone(controller.fatal_model_status({"error": "Model endpoint request failed"}))
        self.assertIsNone(controller.fatal_model_status({}))

    def test_trial_batch_stops_after_fatal_status_and_preserves_planned_count(self):
        args = SimpleNamespace(iterations=2, compare_verification_output=True,
                               verification_output="full", modes=["baseline"])
        fatal = AsyncMock(return_value={"error": "Model HTTP 404; not retried", "verified": False})
        with patch.object(controller, "trial", fatal):
            results, planned, reason = asyncio.run(controller.run_trials(args, None, None))
        self.assertEqual((len(results), planned), (1, 4))
        self.assertEqual(fatal.await_count, 1)
        self.assertIn("HTTP 404", reason)

        transient = AsyncMock(return_value={"error": "Model HTTP 503; not retried", "verified": False})
        with patch.object(controller, "trial", transient):
            results, planned, reason = asyncio.run(controller.run_trials(args, None, None))
        self.assertEqual((len(results), planned, reason), (4, 4, None))
        self.assertEqual(transient.await_count, 4)

    def test_fatal_endpoint_error_skips_redundant_postchecks_only_without_changes(self):
        args = SimpleNamespace(acceptance="check-answer")
        report = {"error": "Model HTTP 404; not retried", "completion": "error"}
        verify = AsyncMock()
        with patch.object(controller, "clean_verification", verify):
            asyncio.run(controller.verify_trial_output(args, None, {}, [], set(), {}, report))
            self.assertTrue(report["verification_after"]["skipped"])
            self.assertTrue(report["acceptance"]["skipped"])
            verify.assert_not_awaited()

            changed_report = {"error": "Model HTTP 404; not retried", "completion": "error"}
            asyncio.run(controller.verify_trial_output(args, None, {}, ["answer.json"], {"answer.json"}, {}, changed_report))
            verify.assert_awaited_once()

    def test_exports_prune_dependencies_and_reject_links_and_fifos(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "source.py").write_text("source")
            dependency = root / "node_modules"
            dependency.mkdir()
            os.mkfifo(dependency / "never-open")
            self.assertEqual(controller.files(root), {"source.py": b"source"})
            (root / "link").symlink_to("/etc/passwd")
            with self.assertRaises(ValueError):
                controller.files(root)
            (root / "link").unlink()
            os.mkfifo(root / "fifo")
            with self.assertRaises(ValueError):
                controller.files(root)

    def test_frozen_snapshot_excludes_host_dependency_link_and_stays_writable(self):
        sandbox_module = controller.load("self_benchmark", Path(__file__).with_name("self-benchmark.py"))
        with tempfile.TemporaryDirectory() as temporary:
            frozen_path = Path(temporary)
            (frozen_path / "probe-source.txt").write_text("frozen content")
            (frozen_path / "node_modules").symlink_to(controller.ROOT / "node_modules", target_is_directory=True)
            metadata = {"snapshot_sha256": "fixture"}
            with patch.object(sandbox_module, "sandbox_prefix", return_value=(["bwrap-fixture"], {})):
                with sandbox_module.Sandbox(controller.ROOT, snapshot_path=frozen_path, metadata=metadata) as sandbox:
                    self.assertFalse((sandbox.path / "node_modules").is_symlink())
                    self.assertEqual((sandbox.path / "probe-source.txt").read_text(), "frozen content")
                    (sandbox.path / "probe-source.txt").write_text("candidate change")
                    self.assertEqual((frozen_path / "probe-source.txt").read_text(), "frozen content")
                    self.assertEqual(sandbox.command(["true"]), ["bwrap-fixture", "true"])
                    self.assertEqual(sandbox.metadata, metadata)

    def test_passing_verification_is_summary_with_exact_log_available(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = SimpleNamespace(path=Path(temporary))
            result = {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": "test ok\n" * 1000 + "Ran 169 tests in 2s\nOK\n"}
            message = controller.verification_message(result, sandbox)
            self.assertLess(len(message), len(result["stderr"]) // 5)
            self.assertIn("Ran 169 tests", message)
            self.assertEqual(json.loads((sandbox.path / ".benchmark-verification.json").read_text()), result)
            with self.assertRaises(RuntimeError):
                controller.verification_message(result, sandbox)

    def test_failed_verification_keeps_all_evidence_and_full_mode_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = SimpleNamespace(path=Path(temporary))
            result = {"exit_code": 1, "timed_out": False, "stdout": "details", "stderr": "failure evidence\n" * 500}
            summary = json.loads(controller.verification_message(result, sandbox).split("\n", 1)[1])
            self.assertEqual(summary["stderr"], result["stderr"])
            (sandbox.path / ".benchmark-verification.json").unlink()
            self.assertEqual(json.loads(controller.verification_message(result, sandbox, "full").split("\n", 1)[1]), result)
            self.assertEqual(json.loads((sandbox.path / ".benchmark-verification.json").read_text()), result)

    def test_clean_verification_imports_only_allowed_bytes_and_source_modes(self):
        sandbox_module = controller.load("clean_benchmark_fixture", Path(__file__).with_name("self-benchmark.py"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "allowed.txt").write_text("before")
            (root / "allowed.txt").chmod(0o640)
            (root / "removed.txt").write_text("remove")
            (root / "checker.py").write_text("answers")
            (root / "source.py").write_text("trusted")
            args = SimpleNamespace(snapshot_path=root, source_metadata={}, exclude_path=["checker.py"],
                                   harbor=False, verify="verify", acceptance="accept", command_timeout=1)
            async def check(clean, argv, timeout):
                self.assertEqual((clean.path / "allowed.txt").read_text(), "candidate")
                self.assertEqual((clean.path / "allowed.txt").stat().st_mode & 0o777, 0o640)
                self.assertFalse((clean.path / "removed.txt").exists())
                self.assertFalse((clean.path / "checker.py").exists())
                self.assertFalse((clean.path / "injected.py").exists())
                self.assertEqual((clean.path / "source.py").read_text(), "trusted")
                return {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": ""}
            report = {}
            with patch.object(sandbox_module, "sandbox_prefix", return_value=([], {})), patch.object(controller, "command", side_effect=check) as execute:
                asyncio.run(controller.clean_verification(args, sandbox_module,
                    {"allowed.txt": b"candidate", "source.py": b"tampered", "injected.py": b"bad"},
                    ["allowed.txt", "removed.txt", "source.py", "injected.py"],
                    {"allowed.txt", "removed.txt"}, {"allowed.txt": 0o640}, report))
                self.assertEqual(execute.call_count, 2)
            self.assertEqual((root / "allowed.txt").read_text(), "before")

    def test_clean_verification_rejects_model_cache_and_test_contamination(self):
        sandbox_module = controller.load("contamination_fixture", Path(__file__).with_name("self-benchmark.py"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            frozen = root / "frozen"
            frozen.mkdir()
            (frozen / "tests").mkdir()
            (frozen / "tests/check.py").write_text("assert answer == 42\n")
            args = SimpleNamespace(snapshot_path=frozen, source_metadata={"snapshot_sha256": "fixture"},
                                   exclude_path=[], harbor=False, verify="verify", acceptance="accept", command_timeout=1)
            # Use the actual Sandbox copier for both model and clean worktrees;
            # only execution is mocked, so the fixture needs no Git/runtime.
            with patch.object(sandbox_module, "sandbox_prefix", return_value=([], {})):
                with sandbox_module.Sandbox(controller.ROOT, snapshot_path=frozen, metadata=args.source_metadata) as candidate:
                    baseline = controller.files(candidate.path)
                    modes = controller.file_modes(candidate.path, baseline)
                    (candidate.path / "quality-answer.json").write_text('{"answer":42}')
                    (candidate.path / "tests/check.py").write_text("pass # tampered\n")
                    cache = candidate.path / "__pycache__"
                    cache.mkdir()
                    (cache / "check.cpython-314.pyc").write_bytes(b"untrusted cache")
                    current = controller.files(candidate.path)
                    changed = sorted(name for name in baseline.keys() | current.keys() if baseline.get(name) != current.get(name))
                    self.assertIn("tests/check.py", changed)
                    self.assertNotIn("__pycache__/check.cpython-314.pyc", current)
                    clean_paths = []
                    async def inspect(clean, argv, timeout):
                        clean_paths.append(clean.path)
                        self.assertNotEqual(clean.path, candidate.path)
                        self.assertEqual((clean.path / "quality-answer.json").read_text(), '{"answer":42}')
                        self.assertEqual((clean.path / "tests/check.py").read_text(), "assert answer == 42\n")
                        self.assertFalse((clean.path / "__pycache__").exists())
                        return {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": ""}
                    with patch.object(controller, "command", side_effect=inspect) as execute:
                        asyncio.run(controller.clean_verification(args, sandbox_module, current, changed,
                            {"quality-answer.json"}, modes, {}))
                        self.assertEqual(execute.call_count, 2)
                    self.assertTrue(all(not path.exists() for path in clean_paths))
            self.assertEqual((frozen / "tests/check.py").read_text(), "assert answer == 42\n")
            self.assertFalse((frozen / "quality-answer.json").exists())

    def test_candidate_feedback_has_bounded_calls_and_never_echoes_checker_stderr(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = SimpleNamespace(path=Path(temporary))
            (sandbox.path / "answer.json").write_text("candidate")
            args = SimpleNamespace(allowed_path=["answer.json"], exclude_path=[], verify="original", acceptance="hidden")
            report = {}
            async def verify(check_args, _module, _current, _changed, _allowed, _modes, feedback):
                self.assertEqual(check_args.verify, "true")
                feedback["acceptance"] = {"exit_code": 1, "timed_out": False, "stdout": '{"passed":4}', "stderr": "PRIVATE EXPECTED ANSWER"}
            with patch.object(controller, "clean_verification", side_effect=verify) as check:
                for _ in range(2):
                    feedback = asyncio.run(controller.candidate_check(args, None, sandbox, {}, {}, report))
                    self.assertNotIn("PRIVATE", json.dumps(feedback))
                self.assertIn("limit", asyncio.run(controller.candidate_check(args, None, sandbox, {}, {}, report))["error"])
                self.assertEqual(check.call_count, 2)

    def test_candidate_feedback_rejects_permission_only_changes_outside_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            sandbox = SimpleNamespace(path=Path(temporary))
            source = sandbox.path / "source.py"
            source.write_text("trusted")
            source.chmod(0o600)
            args = SimpleNamespace(allowed_path=["answer.json"], exclude_path=[])
            with patch.object(controller, "clean_verification", new=AsyncMock()) as check:
                result = asyncio.run(controller.candidate_check(args, None, sandbox,
                    {"source.py": b"trusted"}, {"source.py": 0o644}, {}))
                self.assertIn("outside", result["error"])
                check.assert_not_called()

    def test_initialization_error_is_persisted(self):
        class BrokenSandbox:
            def __init__(self, *_args):
                raise RuntimeError("sandbox unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            args = SimpleNamespace(output=Path(temporary), model="test-only")
            report = asyncio.run(controller.trial(args, SimpleNamespace(Sandbox=BrokenSandbox), None, "baseline", 1))
            saved = json.loads((args.output / "01-baseline/result.json").read_text())
            self.assertEqual(saved["completion"], "error")
            self.assertFalse(saved["verified"])
            self.assertIn("sandbox unavailable", report["error"])

    def test_model_redirect_is_rejected_without_followup_request(self):
        class FakeOpener:
            def open(self, request, timeout):
                self.authorization = request.get_header("Authorization")
                return redirect.redirect_request(request, None, 302, "Found", {}, "https://elsewhere.invalid/")
        redirect = controller.NoRedirect()
        opener = FakeOpener()
        with patch.object(controller.urllib.request, "build_opener", return_value=opener) as build:
            with self.assertRaisesRegex(RuntimeError, "redirect 302 refused"):
                controller.complete("https://model.invalid/v1/chat/completions", "fixture-token", {}, 1)
            self.assertTrue(any(isinstance(item, controller.NoRedirect) for item in build.call_args.args))
        self.assertEqual(opener.authorization, "Bearer fixture-token")

    def test_archive_bridge_only_swallows_expected_codes(self):
        class BridgeError(Exception):
            def __init__(self, code): self.code = code
        class Bridge:
            def __init__(self, code): self.code = code
            async def call(self, *_args, **_kwargs): raise BridgeError(self.code)
        class Sandbox: pass
        async def invoke(code):
            return await controller.tool(Sandbox(), Bridge(code), {"recovery_calls": 0},
                                         "context_folding", {"action": "read"}, 1, BridgeError)
        self.assertEqual(asyncio.run(invoke("archive_unavailable")), {"error": "archive_unavailable"})
        with self.assertRaises(BridgeError):
            asyncio.run(invoke("protocol"))

    def test_shell_timeout_is_milliseconds_and_cannot_raise_controller_limit(self):
        async def run():
            with patch.object(controller, "command", new=AsyncMock(return_value={"stdout": "", "stderr": "", "exit_code": 0})) as execute:
                await controller.tool(None, None, {}, "exec_command", {"command": "true", "timeout": 120000}, 60)
                self.assertEqual(execute.call_args.args[-1], 60)
                await controller.tool(None, None, {}, "exec_command", {"command": "true", "timeout": 500}, 60)
                self.assertEqual(execute.call_args.args[-1], 0.5)
        asyncio.run(run())

    def test_invalid_tool_arguments_do_not_reach_execution(self):
        for name, fields in [("exec_command", {"command": "true", "extra": 1}),
                             ("context_folding", {"action": [], "id": "x"}),
                             ("context_folding", {"action": "read", "limit": True}),
                             ([], {}), ("read_file", {"path": 5})]:
            with self.subTest(name=name, fields=fields), self.assertRaises((ValueError, TypeError)):
                asyncio.run(controller.tool(None, None, {}, name, fields, 1))


if __name__ == "__main__":
    unittest.main()
