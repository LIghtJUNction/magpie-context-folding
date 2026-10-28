"""Agent component checks using real Harbor classes and the production Bun hook.

FakeEnvironment is deliberately NOT a Harbor sandbox. Its scripted smoke mode
executes only the bundled, reviewed oracle script in an isolated temporary app.
These tests neither call a model endpoint nor claim a container benchmark score.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

# Harbor imports LiteLLM for model metadata; use its installed map, not a fetch.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import httpx
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from magpie_harbor import agent as module
from magpie_harbor.agent import BENCH, Bridge, MagpieAgent, ScriptedSmokeAgent, Usage

BUN = shutil.which(os.environ.get("HARBOR_BUN", "bun"))


def assistant(content="done", calls=None, usage=None):
    message = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    reply = {"choices": [{"finish_reason": "tool_calls" if calls else "stop", "message": message}]}
    if usage is not None:
        reply["usage"] = usage
    return reply


def tool_call(name="terminal", args=None, call_id="call-1"):
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(args or {"command": "true"})}}


FULL_USAGE = {"prompt_tokens": 10, "completion_tokens": 4,
              "prompt_tokens_details": {"cached_tokens": 2}}


class FakeEnvironment:
    def __init__(self, result=None, *, app=None, solution=None):
        self.commands = []
        self.result = result or ExecResult(stdout="component fixture\n", stderr="", return_code=0)
        self.app, self.solution = app, solution

    async def exec(self, *, command, timeout_sec):
        self.commands.append(command)
        if self.solution is None:
            return self.result
        if command == "printf 'smoke checkpoint\\n'":
            return ExecResult(stdout="smoke checkpoint\n", stderr="", return_code=0)
        if command != self.solution:
            raise AssertionError("Component fixture refuses any command outside the bundled oracle")
        completed = await asyncio.to_thread(
            subprocess.run, ["bash", "-c", command], cwd=self.app,
            env={"PATH": os.environ.get("PATH", os.defpath), "APP_DIR": str(self.app)},
            capture_output=True, text=True, timeout=timeout_sec)
        return ExecResult(stdout=completed.stdout, stderr=completed.stderr, return_code=completed.returncode)


class UsageTests(unittest.TestCase):
    def test_no_response_and_missing_counters_are_unknown_not_free(self):
        usage, context = Usage(), AgentContext()
        usage.publish(context)
        self.assertIsNone(context.n_input_tokens)
        self.assertIsNone(context.n_output_tokens)
        self.assertIsNone(context.n_cache_tokens)
        usage.add({"usage": FULL_USAGE})
        usage.add({})
        usage.add({"usage": FULL_USAGE})
        usage.publish(context)
        self.assertIsNone(context.n_input_tokens)
        self.assertIsNone(context.n_output_tokens)
        self.assertIsNone(context.n_cache_tokens)
        self.assertIsNone(context.cost_usd)

    def test_known_counts_sum_and_missing_cache_does_not_erase_input(self):
        usage, context = Usage(), AgentContext()
        usage.add({"usage": FULL_USAGE})
        usage.add({"usage": {"prompt_tokens": 12, "completion_tokens": 6}})
        usage.publish(context)
        self.assertEqual(context.n_input_tokens, 22)
        self.assertEqual(context.n_output_tokens, 10)
        self.assertIsNone(context.n_cache_tokens)
        self.assertIsNone(context.cost_usd)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.agent = MagpieAgent(logs_dir=Path(self.temp.name), model_name="fixture/model",
                                 extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        await self.agent.setup(FakeEnvironment())

    async def test_http_failure_is_one_attempt_and_does_not_echo_provider_body(self):
        requests = []

        async def handler(request):
            requests.append(request)
            return httpx.Response(503, text="provider-private-diagnostic")

        real_client = httpx.AsyncClient
        with patch.object(module.httpx, "AsyncClient", side_effect=lambda **kwargs:
                          real_client(transport=httpx.MockTransport(handler), **kwargs)):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503; request not retried") as raised:
                await self.agent._complete({"model": "fixture/model", "messages": []})
        self.assertEqual(len(requests), 1)
        self.assertNotIn("provider-private-diagnostic", str(raised.exception))

    async def test_http_keeps_the_entire_payload_and_does_not_follow_redirects(self):
        received = []
        payload = {"model": "fixture/model", "messages": [
            {"role": "user", "content": "complete Unicode record 中文😀\n" * 10000}]}

        async def handler(request):
            received.append(json.loads(request.content))
            return httpx.Response(307, headers={"Location": "https://unrelated.invalid/"})

        real_client = httpx.AsyncClient
        with patch.object(module.httpx, "AsyncClient", side_effect=lambda **kwargs:
                          real_client(transport=httpx.MockTransport(handler), **kwargs)):
            with self.assertRaisesRegex(RuntimeError, "HTTP 307"):
                await self.agent._complete(payload)
        self.assertEqual(received, [payload])

    async def test_read_file_is_executed_in_environment_and_never_sliced_on_success(self):
        text = "# @context-fold begin source\n" + "x = '中文😀'\n" * 500 + "# @context-fold end source\n"
        environment = FakeEnvironment(ExecResult(stdout=text, stderr="", return_code=0))
        path = "/sandbox/a file 'quoted'.py"
        result = await self.agent._tool("read_file", {"path": path}, environment, None)
        self.assertEqual(result, text)
        self.assertEqual(len(environment.commands), 1)
        self.assertEqual(shlex.split(environment.commands[0])[-1], path)
        # An oversized result is a visible read failure, never a partial source.
        oversized = FakeEnvironment(ExecResult(stdout="x" * 32001, stderr="", return_code=0))
        self.assertIn("error", json.loads(await self.agent._tool("read_file", {"path": path}, oversized, None)))
        terminal = json.loads(await self.agent._tool("terminal", {"command": "fixture"}, oversized, None))
        self.assertEqual(len(terminal["stdout"]), 32000)
        self.assertIs(terminal["stdout_truncated"], True)


@unittest.skipUnless(BUN, "Set HARBOR_BUN or install Bun >=1.4.0 for real-hook component tests")
class BridgeAgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.bun_env = patch.dict(os.environ, {"HARBOR_BUN": BUN})
        self.bun_env.start()
        self.addCleanup(self.bun_env.stop)

    async def test_bridge_process_gets_no_credentials_and_isolates_config_and_scopes(self):
        observed = []
        original = asyncio.create_subprocess_exec

        async def capture(*args, **kwargs):
            observed.append(kwargs["env"].copy())
            return await original(*args, **kwargs)

        first = Bridge(self.directory / "one")
        second = Bridge(self.directory / "two")
        with patch.dict(os.environ, {"HARBOR_MODEL_API_KEY": "never-forward", "AWS_SECRET_ACCESS_KEY": "never-forward"}), \
                patch.object(module.asyncio, "create_subprocess_exec", side_effect=capture):
            try:
                await first.start()
                await second.start()
                for env in observed:
                    self.assertNotIn("HARBOR_MODEL_API_KEY", env)
                    self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
                    self.assertTrue((Path(env["HARBOR_FOLDING_CWD"]) / ".git").is_dir())
                    self.assertNotEqual(env["XDG_CONFIG_HOME"], os.environ.get("XDG_CONFIG_HOME"))
                body = {"model": "fixture/model", "messages": [{"role": "user", "content": "work"}], "tools": module.TOOLS}
                one = await first.call("project", mode="folding", body=body)
                two = await second.call("project", mode="folding", body=body)
                self.assertNotEqual(one["scope"], two["scope"])
                await first.call("response", success=True)
                await second.call("response", success=True)
                with self.assertRaisesRegex(RuntimeError, "scope_mismatch"):
                    await second.call("recover", args={"action": "status", "scope": one["scope"]})
            finally:
                await first.close()
                await second.close()

    async def test_scripted_smoke_delays_folds_recovers_and_solves_both_tasks(self):
        class RecordingSmoke(ScriptedSmokeAgent):
            async def _complete(self, payload):
                self.received.append(copy.deepcopy(payload))
                return await super()._complete(payload)

        for task in sorted((BENCH / "tasks").iterdir()):
            for mode in ("baseline", "folding"):
                with self.subTest(task=task.name, mode=mode):
                    case = self.directory / (task.name + "-" + mode)
                    app = case / "app"
                    shutil.copytree(task / "environment" / "app", app)
                    solution = (task / "solution" / "solve.sh").read_text()
                    environment = FakeEnvironment(app=app, solution=solution)
                    agent = RecordingSmoke(logs_dir=case / "logs", model_name="fixture/model", mode=mode)
                    agent.received = []
                    context = AgentContext()
                    await agent.setup(environment)
                    await agent.run((task / "instruction.md").read_text(), environment, context)
                    self.assertEqual(len(agent.received), 5)
                    all_text = lambda request: "\n".join(m.get("content") or "" for m in request["messages"] if m["role"] == "assistant")
                    original = "Synthetic recoverable note. " * 80
                    self.assertIn(original, all_text(agent.received[1]))
                    if mode == "folding":
                        self.assertIn("[[cf:v2:", all_text(agent.received[2]))
                        self.assertNotIn(original, all_text(agent.received[2]))
                        # A lookup returns exact evidence as a tool result; it
                        # must not undo the folding of the original history.
                        result_message = agent.received[3]["messages"][-1]
                        self.assertEqual(result_message["role"], "tool")
                        self.assertEqual(result_message["tool_call_id"], "smoke-2")
                        recovered = json.loads(result_message["content"])
                        self.assertEqual(recovered["text"], original)
                        self.assertEqual(recovered["sha256"], hashlib.sha256(original.encode()).hexdigest())
                        self.assertIs(recovered["kept"], False)
                        self.assertIsNone(recovered["nextOffset"])
                        for request in agent.received[3:]:
                            self.assertIn("[[cf:v2:", all_text(request))
                            self.assertNotIn(original, all_text(request))
                    else:
                        for request in agent.received[2:]:
                            self.assertIn(original, all_text(request))
                    metrics = context.metadata["magpie_harbor"]
                    self.assertEqual(metrics["measurement"], "scripted-smoke")
                    self.assertEqual(metrics["completion"], "final")
                    self.assertEqual(metrics["recovery_calls"], int(mode == "folding"))
                    self.assertFalse(metrics["usage_complete"])
                    self.assertIsNone(context.n_input_tokens)
                    self.assertIsNone(context.cost_usd)
                    transcript = [json.loads(line) for line in (case / "logs" / "transcript.jsonl").read_text().splitlines()]
                    self.assertIn(original, transcript[0]["message"]["content"])
                    check = subprocess.run([sys.executable, str(task / "tests" / "verify.py"),
                                            "--app-dir", str(app), "--log-dir", str(case / "verification")],
                                           capture_output=True, text=True, timeout=30)
                    self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
                    self.assertEqual((case / "verification" / "reward.txt").read_text().strip(), "1")

    async def test_later_http_failure_makes_total_usage_unknown(self):
        agent = MagpieAgent(logs_dir=self.directory / "logs", model_name="fixture/model",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        environment, context = FakeEnvironment(), AgentContext()
        await agent.setup(environment)
        agent._complete = AsyncMock(side_effect=[assistant(calls=[tool_call()], usage=FULL_USAGE), RuntimeError("request failed")])
        with self.assertRaisesRegex(RuntimeError, "request failed"):
            await agent.run("Component fixture", environment, context)
        self.assertEqual(agent._complete.await_count, 2)
        self.assertFalse(context.metadata["magpie_harbor"]["usage_complete"])
        self.assertIsNone(context.n_input_tokens)
        self.assertIsNone(context.n_output_tokens)
        self.assertIsNone(context.n_cache_tokens)

    async def test_read_file_result_is_reprojected_after_delay_and_recovers_exact_source(self):
        payload = "value = 'Unicode 中文😀'\n" * 80
        source = "# @context-fold begin records\n" + payload + "# @context-fold end records\n"

        class SourceEnvironment(FakeEnvironment):
            async def exec(self, *, command, timeout_sec):
                self.commands.append(command)
                return ExecResult(stdout=source if command.startswith("python3 -c ") else "checkpoint\n",
                                  stderr="", return_code=0)

        class SourceAgent(MagpieAgent):
            async def _complete(self, request):
                step = len(self.received)
                self.received.append(copy.deepcopy(request))
                if step == 0:
                    return assistant(calls=[tool_call("read_file", {"path": "/app/source.py"}, "source-read")])
                if step == 1:
                    self.test.assertEqual(request["messages"][-1]["content"], source)
                    return assistant(calls=[tool_call(call_id="advance")])
                if step == 2:
                    text = next(m["content"] for m in request["messages"] if m.get("tool_call_id") == "source-read")
                    self.test.assertIn("[[cf:v2:", text)
                    reference = text.split("[[cf:v2:", 1)[1].split("]]", 1)[0]
                    return assistant(calls=[tool_call("context_folding", {"action": "read", "id": reference,
                                                                             "limit": 24000}, "recover-source")])
                self.test.assertEqual(json.loads(request["messages"][-1]["content"])["text"], payload.rstrip("\n"))
                restored = next(m["content"] for m in request["messages"] if m.get("tool_call_id") == "source-read")
                if step == 3:
                    self.test.assertFalse(json.loads(request["messages"][-1]["content"])["kept"])
                    self.test.assertIn("[[cf:v2:", restored)
                    reference = restored.split("[[cf:v2:", 1)[1].split("]]", 1)[0]
                    return assistant(calls=[tool_call("context_folding", {"action": "restore", "id": reference,
                                                                             "limit": 24000}, "restore-source")])
                self.test.assertTrue(json.loads(request["messages"][-1]["content"])["kept"])
                self.test.assertEqual(restored, source)
                return assistant()

        agent = SourceAgent(logs_dir=self.directory / "logs", model_name="fixture/model",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        agent.received, agent.test = [], self
        environment, context = SourceEnvironment(), AgentContext()
        await agent.setup(environment)
        await agent.run("Read and recover source component fixture", environment, context)
        self.assertEqual(len(environment.commands), 2)
        self.assertEqual(context.metadata["magpie_harbor"]["recovery_calls"], 2)

    async def test_subprocess_start_failure_closes_open_stderr_and_records_failure(self):
        bridges = []
        real_bridge = Bridge

        def create(logs_dir):
            bridge = real_bridge(logs_dir)
            bridges.append(bridge)
            return bridge

        agent = MagpieAgent(logs_dir=self.directory / "logs", model_name="fixture/model",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        await agent.setup(FakeEnvironment())
        context = AgentContext()
        with patch.object(module, "Bridge", side_effect=create), \
                patch.object(module.asyncio, "create_subprocess_exec", side_effect=OSError("synthetic spawn failure")):
            with self.assertRaisesRegex(OSError, "synthetic spawn failure"):
                await agent.run("Start failure fixture", FakeEnvironment(), context)
        self.assertTrue(bridges[0].stderr.closed)
        self.assertEqual(context.metadata["magpie_harbor"]["completion"], "error")
        self.assertIsNone(context.n_input_tokens)

    async def test_baseline_archive_query_is_a_tool_error_and_agent_can_continue(self):
        agent = MagpieAgent(logs_dir=self.directory / "logs", model_name="fixture/model", mode="baseline",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        environment, context = FakeEnvironment(), AgentContext()
        await agent.setup(environment)
        agent._complete = AsyncMock(side_effect=[
            assistant(calls=[tool_call("context_folding", {"action": "status"})]), assistant()])
        await agent.run("Component fixture", environment, context)
        self.assertEqual(context.metadata["magpie_harbor"]["completion"], "final")
        payload = agent._complete.await_args_list[1].args[0]
        self.assertIn("error", json.loads(payload["messages"][-1]["content"]))

    async def test_cancellation_closes_real_bridge_and_preserves_unknown_usage(self):
        entered = asyncio.Event()
        bridges = []
        real_bridge = Bridge

        def create(logs_dir):
            bridge = real_bridge(logs_dir)
            bridges.append(bridge)
            return bridge

        async def wait_for_cancel(_payload):
            entered.set()
            await asyncio.Event().wait()

        agent = MagpieAgent(logs_dir=self.directory / "logs", model_name="fixture/model",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        await agent.setup(FakeEnvironment())
        agent._complete = wait_for_cancel
        context = AgentContext()
        with patch.object(module, "Bridge", side_effect=create):
            task = asyncio.create_task(agent.run("Cancel fixture", FakeEnvironment(), context))
            await asyncio.wait_for(entered.wait(), timeout=10)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNotNone(bridges[0].process.returncode)
        self.assertIsNone(context.n_input_tokens)
        self.assertFalse(context.metadata["magpie_harbor"]["usage_complete"])

    async def test_metrics_write_failure_still_closes_bridge(self):
        bridges = []
        real_bridge, original_write = Bridge, Path.write_text

        def create(logs_dir):
            bridge = real_bridge(logs_dir)
            bridges.append(bridge)
            return bridge

        def write(path, *args, **kwargs):
            if path.name == "folding-metrics.json":
                raise OSError("synthetic disk failure")
            return original_write(path, *args, **kwargs)

        agent = MagpieAgent(logs_dir=self.directory / "logs", model_name="fixture/model",
                            extra_env={"HARBOR_MODEL_BASE_URL": "http://localhost:23456/v1"})
        await agent.setup(FakeEnvironment())
        agent._complete = AsyncMock(return_value=assistant())
        try:
            with patch.object(module, "Bridge", side_effect=create), patch.object(Path, "write_text", write):
                with self.assertRaisesRegex(OSError, "synthetic disk failure"):
                    await agent.run("Write failure fixture", FakeEnvironment(), AgentContext())
            self.assertIsNotNone(bridges[0].process.returncode, "Bun process leaked after metrics-write failure")
        finally:
            for bridge in bridges:
                await bridge.close()


if __name__ == "__main__":
    unittest.main()
