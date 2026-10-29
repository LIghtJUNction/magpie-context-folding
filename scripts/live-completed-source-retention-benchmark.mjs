#!/usr/bin/env bun
// Measure retention after a completed source-backed answer and a later user turn.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { onRequest, onResponse } from '../src/context.hooks.ts';
import { defaultRecoveryCommand, shellQuote } from '../src/guidance.ts';
import { extractSpans } from '../src/protocol.ts';
import { Store } from '../src/store.ts';
import { execute } from '../src/tool.ts';

const pairFlag = process.argv.indexOf('--pairs');
const PAIRS = pairFlag < 0 ? 3 : Number(process.argv[pairFlag + 1]);
if (!Number.isSafeInteger(PAIRS) || PAIRS < 1 || PAIRS > 5) throw new Error('pair_count_invalid');
const MAX_REQUESTS_PER_USER_TURN = 5;
const MAX_OUTPUT_TOKENS = 512;
const firstIndex = 237;
const followupIndex = 341;
const scenarioFlag = process.argv.indexOf('--scenario');
const scenario = scenarioFlag < 0 ? 'related' : process.argv[scenarioFlag + 1];
if (scenario !== 'related' && scenario !== 'unrelated') throw new Error('scenario_must_be_related_or_unrelated');
let seed = 0x5eed1234;
const values = Array.from({ length: 360 }, () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return 100000 + ((seed >>> 0) % 900000);
});
const source = values.map((value, index) => `export function operation${index}() { return ${value}; }\n`).join('');
const questions = [
  `Use read_file to inspect worker.ts. What integer does operation${firstIndex}() return? Reply with only the integer.`,
  scenario === 'related'
    ? `From worker.ts, what integer does operation${followupIndex}() return? Do not guess; reply with only the integer.`
    : 'Separate topic: reply with exactly the word SAPPHIRE and do not use tools.',
];
const expected = [String(values[firstIndex]), scenario === 'related' ? String(values[followupIndex]) : 'SAPPHIRE'];
const systemPrompt = [
  'You are working in a local project. Use tools to inspect source; do not guess.',
  'For the first question, call read_file on worker.ts exactly once before answering.',
  'A later user turn may be related to the file or may be independent. If its answer needs folded source, search the archive for the exact symbol before restoring the full source.',
  'Reply with only the exact answer format requested by the current user question.',
].join(' ');
const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read one complete UTF-8 project file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'exec_command', description: 'Run the context archive recovery command when needed.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } } },
];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usageSummary(reply) {
  const usage = reply?.usage ?? {};
  const prompt = usage.prompt_tokens_details ?? {};
  const input = usage.input_tokens_details ?? {};
  return { input_tokens: safeNumber(usage.prompt_tokens), output_tokens: safeNumber(usage.completion_tokens),
    total_tokens: safeNumber(usage.total_tokens), cache_read_tokens: safeNumber(prompt.cached_tokens ?? input.cached_tokens ?? usage.cache_read_input_tokens),
    cache_write_tokens: safeNumber(prompt.cache_write_tokens ?? input.cache_write_tokens ?? usage.cache_creation_input_tokens) };
}
function total(records, key) {
  if (!records.length || records.some(item => item.usage[key] === null)) return null;
  return records.reduce((sum, item) => sum + item.usage[key], 0);
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function range(values) { return values.length ? [Math.min(...values), Math.max(...values)] : null; }
function bodyFor(model) {
  return { model, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, tools,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: questions[0] }] };
}
function contextFor({ model, session, cwd, delayRequests, state }) {
  return { protocol: 'chat', model, session, origin: 'completed-source-retention-benchmark', agent: 'tool-loop', cwd,
    options: { delayRequests, minSavingsTokens: 256, shellToolName: 'exec_command', recoveryCommand: defaultRecoveryCommand() }, state };
}
function endpointFor(base) {
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new Error('provider_base_url_invalid');
  const rootPath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${rootPath.endsWith('/v1') ? rootPath : `${rootPath}/v1`}/chat/completions`;
}
async function request(endpoint, apiKey, body) {
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  } catch (error) { throw new Error(error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_network_error'); }
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  try { return await response.json(); } catch { throw new Error('provider_invalid_json'); }
}

async function runArm({ mode, pair, model, endpoint, apiKey, cwd, workerPath, stateDir }) {
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDir;
  const store = new Store();
  const session = `completed-read-${String(pair).padStart(2, '0')}-${mode}`;
  const scope = await store.scopeFor(JSON.stringify([session, 'completed-source-retention-benchmark', 'tool-loop', cwd]));
  const state = {};
  const context = contextFor({ model, session, cwd, delayRequests: mode === 'baseline' ? 999 : 0, state });
  const body = bodyFor(model);
  const metrics = { requests: [], answers: [], answerTurns: [], readCalls: 0, readCallTurns: [], recoveryCalls: 0,
    toolErrors: 0, completion: 'incomplete', providerModel: null, finalTurn: -1 };
  const started = performance.now();

  for (let userTurn = 0; userTurn < questions.length; userTurn++) {
    if (userTurn > 0) body.messages.push({ role: 'user', content: questions[userTurn] });
    let answered = false;
    for (let localTurn = 0; localTurn < MAX_REQUESTS_PER_USER_TURN; localTurn++) {
      const turn = metrics.requests.length;
      metrics.finalTurn = turn;
      const raw = structuredClone(body);
      const rawBytes = Buffer.byteLength(JSON.stringify(raw));
      const hookStarted = performance.now();
      const projected = await onRequest(raw, context);
      const hookMs = performance.now() - hookStarted;
      const spans = extractSpans(projected, 'chat');
      const references = spans.filter(span => span.role === 'tool' && /^\[\[cf:v2:[a-f0-9]{12,64}\]\]$/.test(span.text)).length;
      const fullSourceCopies = spans.filter(span => span.role === 'tool' && span.source?.path === 'worker.ts' && span.text === source).length;
      const sentBytes = Buffer.byteLength(JSON.stringify(projected));
      const providerStarted = performance.now();
      let reply;
      try { reply = await request(endpoint, apiKey, projected); }
      catch (error) {
        await onResponse({}, { ...context, success: false, request: projected, protocol: 'chat' });
        metrics.requests.push({ turn, user_turn: userTurn, raw_request_json_bytes: rawBytes, sent_request_json_bytes: sentBytes,
          references, full_source_copies: fullSourceCopies, provider_wait_ms: Math.round(performance.now() - providerStarted),
          hook_on_request_ms: Math.round(hookMs), status: 'provider-error', error_code: error.message,
          usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null } });
        metrics.completion = 'provider-error';
        return { mode, pair, session, scope, ...metrics, error: error.message };
      }
      const providerMs = performance.now() - providerStarted;
      const usage = usageSummary(reply);
      const choice = reply?.choices?.[0];
      metrics.providerModel ??= typeof reply.model === 'string' ? reply.model : null;
      metrics.requests.push({ turn, user_turn: userTurn, raw_request_json_bytes: rawBytes, sent_request_json_bytes: sentBytes,
        references, full_source_copies: fullSourceCopies, provider_wait_ms: Math.round(providerMs),
        hook_on_request_ms: Math.round(hookMs), finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null, usage });
      await onResponse(reply, { ...context, success: true, request: projected, protocol: 'chat' });
      if (!choice?.message || choice.message.role !== 'assistant') { metrics.completion = 'invalid-provider-response'; break; }
      const assistant = choice.message;
      const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
      body.messages.push(assistant);
      if (!calls.length) {
        const answer = typeof assistant.content === 'string' ? assistant.content.trim() : '';
        metrics.answers.push(answer);
        metrics.answerTurns.push(userTurn);
        if (answer !== expected[userTurn]) metrics.completion = 'wrong-answer';
        else answered = true;
        break;
      }
      for (const call of calls) {
        let args;
        try { args = JSON.parse(call?.function?.arguments ?? ''); }
        catch { metrics.toolErrors++; body.messages.push({ role: 'tool', tool_call_id: call?.id, content: JSON.stringify({ error: 'invalid tool arguments' }) }); continue; }
        let output;
        if (call.function.name === 'read_file') {
          metrics.readCalls++;
          metrics.readCallTurns.push(userTurn);
          if (args.path !== 'worker.ts' && args.path !== './worker.ts') { metrics.toolErrors++; output = JSON.stringify({ error: 'unknown file' }); }
          else output = await readFile(workerPath, 'utf8');
        } else if (call.function.name === 'exec_command') {
          metrics.recoveryCalls++;
          const command = typeof args.cmd === 'string' ? args.cmd : args.command;
          const readPrefix = `${defaultRecoveryCommand()} read --state-dir ${shellQuote(stateDir)} --scope `;
          const readRest = typeof command === 'string' && command.startsWith(readPrefix) ? command.slice(readPrefix.length) : '';
          const readMatch = /^([a-f0-9]{64}) --id ([a-f0-9]{12,64})( --restore)?$/.exec(readRest);
          const grepPrefix = `${defaultRecoveryCommand()} grep --state-dir ${shellQuote(stateDir)} --scope ${scope} --id `;
          const grepRest = typeof command === 'string' && command.startsWith(grepPrefix) ? command.slice(grepPrefix.length) : '';
          const grepMatch = /^([a-f0-9]{12,64}) --query (?:'([^']+)'|"([^"]+)"|([^ ]+))$/.exec(grepRest);
          if (readMatch && readMatch[1] === scope) output = await execute({ action: 'read', scope, id: readMatch[2], peek: !readMatch[3], limit: 24000 });
          else if (grepMatch) output = await execute({ action: 'grep', scope, id: grepMatch[1],
            query: grepMatch[2] ?? grepMatch[3] ?? grepMatch[4], recursive: false, limit: 5 });
          else { metrics.toolErrors++; output = JSON.stringify({ error: 'command is outside this benchmark allowlist' }); }
        } else { metrics.toolErrors++; output = JSON.stringify({ error: 'unsupported tool' }); }
        body.messages.push({ role: 'tool', tool_call_id: call?.id, content: output });
      }
    }
    if (!answered) {
      if (metrics.completion === 'incomplete') metrics.completion = 'turn-limit';
      break;
    }
  }
  if (metrics.completion === 'incomplete') metrics.completion = metrics.answers.length === questions.length ? 'final' : 'incomplete';
  metrics.wall_ms = Math.round(performance.now() - started);
  metrics.request_count = metrics.requests.length;
  metrics.provider_input_tokens = total(metrics.requests, 'input_tokens');
  metrics.provider_output_tokens = total(metrics.requests, 'output_tokens');
  metrics.provider_cache_read_tokens = total(metrics.requests, 'cache_read_tokens');
  metrics.provider_cache_write_tokens = total(metrics.requests, 'cache_write_tokens');
  metrics.correct_answers = metrics.answers.reduce((sum, answer, index) => sum + Number(answer === expected[index]), 0);
  metrics.success = metrics.completion === 'final' && metrics.correct_answers === questions.length
    && metrics.readCallTurns.includes(0) && metrics.toolErrors === 0 && metrics.provider_input_tokens !== null;
  metrics.folded_source_requests = metrics.requests.filter(item => item.references > 0).length;
  metrics.full_source_requests = metrics.requests.filter(item => item.full_source_copies > 0).length;
  return { mode, pair, session, scope, completion: metrics.completion, answers: metrics.answers,
    correct_answers: metrics.correct_answers, success: metrics.success, read_calls: metrics.readCalls,
    read_call_user_turns: metrics.readCallTurns, recovery_tool_calls: metrics.recoveryCalls,
    tool_errors: metrics.toolErrors, request_count: metrics.request_count, folded_source_requests: metrics.folded_source_requests,
    full_source_requests: metrics.full_source_requests, provider_model_reported: metrics.providerModel,
    provider_input_tokens: metrics.provider_input_tokens, provider_output_tokens: metrics.provider_output_tokens,
    provider_cache_read_tokens: metrics.provider_cache_read_tokens, provider_cache_write_tokens: metrics.provider_cache_write_tokens,
    end_to_end_ms: metrics.wall_ms, requests: metrics.requests };
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('usage: bun scripts/live-completed-source-retention-benchmark.mjs --output docs/benchmarks/<name>.json [--pairs 1-5] [--scenario related|unrelated]');
const outputPath = resolve(args[outputIndex + 1]);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : process.env.MAGPIE_SOURCE_READ_BENCH_MODEL || 'claude-sonnet-5';
if (!model) throw new Error('model_required');
const baseUrl = process.env.HARBOR_MODEL_BASE_URL || process.env.ANTHROPIC_BASE_URL;
const apiKey = process.env.HARBOR_MODEL_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
if (!baseUrl || !apiKey) throw new Error('provider_route_credentials_missing');
const endpoint = endpointFor(baseUrl);
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookHash = sha256(await readFile(join(rootPath, 'src', 'context.hooks.ts')));
const taskHash = sha256(JSON.stringify([systemPrompt, questions, source]));
await mkdir(dirname(outputPath), { recursive: true });
try { await access(outputPath); throw new Error('output_already_exists'); }
catch (error) { if (error.message === 'output_already_exists' || error.code !== 'ENOENT') throw error; }

const previousStateDir = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const root = await mkdtemp(join(tmpdir(), 'magpie-completed-source-'));
const cwd = join(root, 'cwd');
const workerPath = join(cwd, 'worker.ts');
const stateDir = join(root, 'state');
process.env.XDG_CONFIG_HOME = join(root, 'config');
await mkdir(join(cwd, '.git'), { recursive: true, mode: 0o700 });
await writeFile(workerPath, source, { mode: 0o600 });

let report = { schema_version: 1, benchmark: `live-completed-source-read-retention-${scenario}`, generated_at: new Date().toISOString(),
  claim_under_test: 'After a full source read has informed a completed assistant answer, folding it on a later user turn preserves answers and lowers provider input tokens when the follow-up does not require source recovery.',
  model_requested: model, route: 'OpenAI-compatible /v1/chat/completions',
  usage_source: 'provider response usage.prompt_tokens and usage.completion_tokens; cache fields recorded only when explicitly returned',
  implementation: { hook: 'src/context.hooks.ts:onRequest', hook_sha256: hookHash, published_package_loaded: false },
  design: { planned_pairs: PAIRS, order: 'alternating baseline/folding, then folding/baseline', max_requests_per_user_turn: MAX_REQUESTS_PER_USER_TURN,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    task_sha256: taskHash, source_sha256: sha256(source), source_utf8_bytes: Buffer.byteLength(source),
    scenario, source_question_index: firstIndex, related_followup_index: scenario === 'related' ? followupIndex : null,
    questions, expected_answers: expected, baseline_delay_requests: 999, folding_delay_requests: 0,
    min_savings_tokens: 256, isolated_temp_workspace: true, bounded_tool_runner: true },
  machine_at_start: { load_average: loadavg(), logical_cores: cpus().length }, pairs: [], summary: null,
  limitations: ['The task deliberately asks two questions about one generated file; it does not measure ordinary follow-up prevalence.',
    'The agent may need an extra recovery or read tool call; those calls and their provider tokens are included.',
    'This is a real provider with a bounded local tool loop, not Magpie/OpenCode host dispatch.',
    'Provider token counts are not billing amounts; no price schedule was applied.',
    'Three pairs are exploratory and wall-clock differences are not a speedup claim.'] };
let runError = null;
try {
  for (let pair = 1; pair <= PAIRS; pair++) {
    const order = pair % 2 ? ['baseline', 'folding'] : ['folding', 'baseline'];
    const item = { pair, order, baseline: null, folding: null, valid: false, deltas: null };
    for (const mode of order) {
      const trial = await runArm({ mode, pair, model, endpoint, apiKey, cwd, workerPath, stateDir });
      item[mode] = trial;
      if (trial.completion === 'provider-error') throw new Error(`provider_unavailable_${trial.error}`);
    }
    const baseline = item.baseline;
    const folding = item.folding;
    item.valid = baseline.success && folding.success;
    if (baseline.provider_input_tokens !== null && folding.provider_input_tokens !== null) item.deltas = {
      provider_input_tokens_saved: baseline.provider_input_tokens - folding.provider_input_tokens,
      provider_output_tokens_delta: folding.provider_output_tokens === null || baseline.provider_output_tokens === null
        ? null : folding.provider_output_tokens - baseline.provider_output_tokens,
      end_to_end_ms_saved: baseline.end_to_end_ms - folding.end_to_end_ms,
      recovery_tool_calls_added: folding.recovery_tool_calls - baseline.recovery_tool_calls,
    };
    report.pairs.push(item);
  }
  const valid = report.pairs.filter(pair => pair.valid);
  const inputDeltas = valid.map(pair => pair.deltas.provider_input_tokens_saved);
  const byteDeltas = valid.map(pair => pair.baseline.requests.reduce((sum, request) => sum + request.sent_request_json_bytes, 0)
    - pair.folding.requests.reduce((sum, request) => sum + request.sent_request_json_bytes, 0));
  report.summary = { planned_pairs: PAIRS, completed_pairs: report.pairs.length, valid_pairs: valid.length,
    correct_answers: report.pairs.reduce((sum, pair) => sum + (pair.baseline?.correct_answers ?? 0) + (pair.folding?.correct_answers ?? 0), 0),
    provider_input_token_savings: { median: median(inputDeltas), range: range(inputDeltas), positive_pairs: inputDeltas.filter(value => value > 0).length },
    sent_request_json_bytes_saved: { median: median(byteDeltas), range: range(byteDeltas) },
    folding_recovery_calls: valid.reduce((sum, pair) => sum + pair.folding.recovery_tool_calls, 0),
    baseline_recovery_calls: valid.reduce((sum, pair) => sum + pair.baseline.recovery_tool_calls, 0),
    cache_usage_reported_in_all_requests: report.pairs.length > 0 && report.pairs.every(pair =>
      [pair.baseline, pair.folding].filter(Boolean).every(arm => arm.requests.every(request =>
        request.usage.cache_read_tokens !== null && request.usage.cache_write_tokens !== null))) };
} catch (error) { runError = error.message; }
report.run_error = runError;
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
if (previousStateDir === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousStateDir;
if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = previousConfigHome;
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ status: runError ? 'incomplete' : report.summary.valid_pairs === PAIRS ? 'complete' : 'inconclusive',
  output: outputPath, summary: report.summary, reason: runError }));
if (runError) process.exitCode = 1;
