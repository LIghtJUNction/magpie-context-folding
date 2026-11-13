#!/usr/bin/env bun
// Five alternating live-provider pairs. Claim under test: folding an identical
// complete source read reduces provider-reported input tokens without changing
// the answer. This synthetic task tests the mechanism, not duplicate-read prevalence.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { onRequest, onResponse } from '../src/context.hooks.ts';
import { defaultRecoveryCommand, shellQuote } from '../src/guidance.ts';
import { Store } from '../src/store.ts';
import { execute } from '../src/tool.ts';

const PAIRS = 5;
const MAX_TURNS = 5;
const source = Array.from({ length: 360 }, (_, index) =>
  `export function operation${index}() { return ${index}; }\n`).join('');
const expected = '237';
const systemPrompt = [
  'You are working in a local project. Use read_file to inspect source; do not guess.',
  'You must call read_file on worker.ts exactly twice, in separate assistant turns.',
  'First call it once and wait for its result. Only then call it again on the same path.',
  'Do not answer until both tool results have arrived. Do not use other tools unless the context-folding instructions require source recovery.',
  'Then reply with only the decimal integer returned by operation237().',
].join(' ');
const userPrompt = 'What integer does operation237() in worker.ts return? Follow the two-read requirement.';
const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read one complete UTF-8 project file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'exec_command', description: 'Run the injected context archive recovery command or cat worker.ts.',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } } },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageSummary(reply) {
  const usage = reply?.usage ?? {};
  const promptDetails = usage.prompt_tokens_details ?? {};
  const inputDetails = usage.input_tokens_details ?? {};
  return {
    input_tokens: safeNumber(usage.prompt_tokens),
    output_tokens: safeNumber(usage.completion_tokens),
    total_tokens: safeNumber(usage.total_tokens),
    cache_read_tokens: safeNumber(promptDetails.cached_tokens ?? promptDetails.cache_read_input_tokens
      ?? inputDetails.cached_tokens ?? inputDetails.cache_read_tokens ?? usage.cache_read_input_tokens),
    cache_write_tokens: safeNumber(promptDetails.cache_write_tokens ?? promptDetails.cache_creation_input_tokens
      ?? inputDetails.cache_write_tokens ?? usage.cache_creation_input_tokens),
  };
}

function completeTotal(records, key) {
  if (!records.length || records.some(item => item.usage[key] === null)) return null;
  return records.reduce((sum, item) => sum + item.usage[key], 0);
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function range(values) {
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

function outputText(body) {
  return body.messages.filter(item => item?.role === 'tool' && typeof item.content === 'string')
    .map(item => item.content);
}

function functionCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function initialBody(model) {
  return { model, temperature: 0, max_tokens: 128, tools,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] };
}

function contextFor({ model, session, cwd, delayRequests, state }) {
  return { protocol: 'chat', model, session, origin: 'live-source-read-benchmark', agent: 'tool-loop', cwd,
    options: { delayRequests, minSavingsTokens: 256, shellToolName: 'exec_command', recoveryCommand: defaultRecoveryCommand() }, state };
}

function getEndpoint(base) {
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('provider_base_url_invalid');
  }
  const rootPath = url.pathname.replace(/\/+$/, '');
  const versioned = rootPath.endsWith('/v1') ? rootPath : `${rootPath}/v1`;
  return `${url.origin}${versioned}/chat/completions`;
}

async function request(endpoint, apiKey, body) {
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_network_error');
  }
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  try { return await response.json(); }
  catch { throw new Error('provider_invalid_json'); }
}

async function executeTool({ call, workerPath, stateDir, scope, metrics }) {
  const name = call?.function?.name;
  let args;
  try { args = JSON.parse(call.function.arguments); }
  catch { metrics.toolErrors++; return JSON.stringify({ error: 'invalid tool arguments' }); }
  if (name === 'read_file') {
    metrics.readCalls++;
    metrics.readCallTurns.push(metrics.currentTurn);
    if (args.path !== 'worker.ts' && args.path !== './worker.ts') {
      metrics.toolErrors++;
      return JSON.stringify({ error: 'unknown file' });
    }
    const started = performance.now();
    const text = await readFile(workerPath, 'utf8');
    metrics.toolMs += performance.now() - started;
    metrics.readResults.push({ turn: metrics.currentTurn, utf8_bytes: Buffer.byteLength(text), sha256: sha256(text) });
    return text;
  }
  if (name === 'exec_command') {
    metrics.otherToolCalls++;
    const command = typeof args.cmd === 'string' ? args.cmd : args.command;
    if (command === 'cat worker.ts') return await readFile(workerPath, 'utf8');
    const prefix = `${defaultRecoveryCommand()} read --state-dir ${shellQuote(stateDir)} --scope `;
    if (typeof command === 'string' && command.startsWith(prefix)) {
      const rest = command.slice(prefix.length);
      const match = /^([a-f0-9]{64}) --id ([a-f0-9]{12,64})( --restore)?$/.exec(rest);
      if (match && match[1] === scope) {
        return execute({ action: 'read', scope, id: match[2], peek: !match[3], limit: 24000 });
      }
    }
    metrics.toolErrors++;
    return JSON.stringify({ error: 'command is outside this benchmark allowlist' });
  }
  metrics.toolErrors++;
  return JSON.stringify({ error: 'unsupported tool' });
}

async function runArm({ mode, pair, model, endpoint, apiKey, cwd, workerPath, stateDir }) {
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDir;
  const store = new Store();
  const session = `live-read-pair-${String(pair).padStart(2, '0')}`;
  const origin = 'live-source-read-benchmark';
  const agent = 'tool-loop';
  const scope = await store.scopeFor(JSON.stringify([session, origin, agent, cwd]));
  const state = {};
  const context = contextFor({ model, session, cwd, delayRequests: mode === 'baseline' ? 999 : 0, state });
  const body = initialBody(model);
  const requests = [];
  const metrics = { readCalls: 0, readCallTurns: [], readResults: [], otherToolCalls: 0,
    toolErrors: 0, currentTurn: -1, hookMs: 0, providerMs: 0, toolMs: 0, finalAnswer: null,
    completion: 'max-turns', providerModel: null };
  const started = performance.now();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    metrics.currentTurn = turn;
    const rawBody = structuredClone(body);
    const rawBytes = Buffer.byteLength(JSON.stringify(rawBody));
    const hookStarted = performance.now();
    const projected = await onRequest(rawBody, context);
    metrics.hookMs += performance.now() - hookStarted;
    const sentBytes = Buffer.byteLength(JSON.stringify(projected));
    const references = outputText(projected).filter(text => /^\[\[cf:v2:[a-f0-9]{12,64}\]\]$/.test(text)).length;
    const fullSourceCopies = outputText(projected).filter(text => text === source).length;
    const providerStarted = performance.now();
    let reply;
    try {
      reply = await request(endpoint, apiKey, projected);
    } catch (error) {
      metrics.providerMs += performance.now() - providerStarted;
      await onResponse({}, { ...context, success: false, request: projected, protocol: 'chat' });
      requests.push({ turn, raw_request_json_bytes: rawBytes, sent_request_json_bytes: sentBytes,
        references, full_source_copies: fullSourceCopies, status: 'provider-error', error_code: error.message,
        usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null } });
      metrics.completion = 'provider-error';
      metrics.providerError = error.message;
      break;
    }
    metrics.providerMs += performance.now() - providerStarted;
    metrics.providerModel ??= typeof reply.model === 'string' ? reply.model : null;
    const usage = usageSummary(reply);
    const choice = reply?.choices?.[0];
    requests.push({ turn, raw_request_json_bytes: rawBytes, sent_request_json_bytes: sentBytes,
      references, full_source_copies: fullSourceCopies,
      finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      usage });
    await onResponse(reply, { ...context, success: true, request: projected, protocol: 'chat' });

    if (!choice || !choice.message || choice.message.role !== 'assistant') {
      metrics.completion = 'invalid-provider-response';
      break;
    }
    const assistant = choice.message;
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!calls.length) {
      metrics.finalAnswer = typeof assistant.content === 'string' ? assistant.content.trim() : null;
      metrics.completion = choice.finish_reason === 'stop' ? 'final' : 'incomplete-final';
      break;
    }
    body.messages.push(assistant);
    for (const call of calls) {
      if (typeof call?.id !== 'string' || !call.id) {
        metrics.toolErrors++;
        metrics.completion = 'invalid-tool-call';
        break;
      }
      const toolText = await executeTool({ call, workerPath, stateDir, scope, metrics });
      body.messages.push({ role: 'tool', tool_call_id: call.id, content: toolText });
    }
    if (metrics.completion === 'invalid-tool-call') break;
  }

  metrics.wallMs = performance.now() - started;
  metrics.requestCount = requests.length;
  metrics.foldedSourceReads = requests.reduce((sum, item) => sum + item.references, 0);
  metrics.inputTokens = completeTotal(requests.filter(item => item.status !== 'provider-error'), 'input_tokens');
  metrics.outputTokens = completeTotal(requests.filter(item => item.status !== 'provider-error'), 'output_tokens');
  metrics.cacheReadTokens = completeTotal(requests.filter(item => item.status !== 'provider-error'), 'cache_read_tokens');
  metrics.cacheWriteTokens = completeTotal(requests.filter(item => item.status !== 'provider-error'), 'cache_write_tokens');
  metrics.correct = metrics.finalAnswer === expected;
  metrics.success = metrics.completion === 'final' && metrics.correct && metrics.readCalls === 2
    && new Set(metrics.readCallTurns).size === 2 && metrics.toolErrors === 0 && metrics.inputTokens !== null;
  return { mode, pair, session, scope, completion: metrics.completion, final_answer: metrics.finalAnswer,
    answer_correct: metrics.correct, success: metrics.success, read_calls: metrics.readCalls,
    read_call_turns: metrics.readCallTurns, read_results: metrics.readResults,
    other_tool_calls: metrics.otherToolCalls, tool_errors: metrics.toolErrors,
    request_count: metrics.requestCount, auto_folded_source_reads: metrics.foldedSourceReads,
    provider_model_reported: metrics.providerModel, provider_input_tokens: metrics.inputTokens,
    provider_output_tokens: metrics.outputTokens, provider_cache_read_tokens: metrics.cacheReadTokens,
    provider_cache_write_tokens: metrics.cacheWriteTokens, end_to_end_ms: Math.round(metrics.wallMs),
    provider_wait_ms: Math.round(metrics.providerMs), hook_on_request_ms: Math.round(metrics.hookMs),
    local_tool_ms: Math.round(metrics.toolMs), requests };
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('usage: bun scripts/live-source-read-agent-benchmark.mjs --output docs/benchmarks/<name>.json');
  process.exit(2);
}
const outputPath = resolve(args[outputIndex + 1]);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : process.env.MAGPIE_SOURCE_READ_BENCH_MODEL || 'claude-sonnet-5';
if (!model) throw new Error('model_required');

const baseUrl = process.env.HARBOR_MODEL_BASE_URL || process.env.ANTHROPIC_BASE_URL;
const apiKey = process.env.HARBOR_MODEL_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
if (!baseUrl || !apiKey) throw new Error('provider_route_credentials_missing');
const endpoint = getEndpoint(baseUrl);
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = join(rootPath, 'src', 'context.hooks.ts');
const hookHash = sha256(await readFile(hookPath));
const sourceHash = sha256(source);
const taskHash = sha256(JSON.stringify([systemPrompt, userPrompt]));
const outputDir = dirname(outputPath);
await mkdir(outputDir, { recursive: true });
try { await access(outputPath); throw new Error('output_already_exists'); }
catch (error) { if (error.message === 'output_already_exists' || error.code !== 'ENOENT') throw error; }

const previousStateDir = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const root = await mkdtemp(join(tmpdir(), 'magpie-live-source-read-'));
const cwd = join(root, 'cwd');
const workerPath = join(cwd, 'worker.ts');
const stateDir = join(root, 'state');
const configHome = join(root, 'config');
await mkdir(join(cwd, '.git'), { recursive: true, mode: 0o700 });
await writeFile(workerPath, source, { mode: 0o600 });
process.env.XDG_CONFIG_HOME = configHome;
process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDir;

const preflightState = join(root, 'preflight-state');
let report;
let runError = null;
try {
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = preflightState;
  const preflightContext = contextFor({ model, session: 'source-read-preflight', cwd,
    delayRequests: 0, state: {} });
  const preflightBody = initialBody(model);
  preflightBody.messages.push(
    { role: 'assistant', tool_calls: [functionCall('preflight-1', 'read_file', { path: 'worker.ts' })] },
    { role: 'tool', tool_call_id: 'preflight-1', content: source },
    { role: 'assistant', tool_calls: [functionCall('preflight-2', 'read_file', { path: 'worker.ts' })] },
    { role: 'tool', tool_call_id: 'preflight-2', content: source },
  );
  const preflightProjected = await onRequest(preflightBody, preflightContext);
  const preflightOutputs = outputText(preflightProjected);
  const preflightPassed = preflightOutputs.length === 2 && preflightOutputs[0] === source
    && /^\[\[cf:v2:[a-f0-9]{12,64}\]\]$/.test(preflightOutputs[1]);
  if (!preflightPassed) throw new Error('hook_preflight_failed_before_provider_requests');

  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDir;
  const store = new Store();
  if (resolve(store.directory) !== resolve(stateDir)) throw new Error('isolated_state_dir_mismatch');
  const load = loadavg();
  report = { schema_version: 1, benchmark: 'live-repeated-source-read-agent-pairs',
    generated_at: new Date().toISOString(), claim_under_test: 'Automatic folding lowers provider-reported input tokens while preserving the answer on a forced repeated-read tool loop.',
    model_requested: model, route: 'OpenAI-compatible /v1/chat/completions', usage_source: 'provider response usage.prompt_tokens and usage.completion_tokens; cache fields recorded only when explicitly returned',
    implementation: { hook: 'src/context.hooks.ts:onRequest', hook_sha256: hookHash, published_package_loaded: false },
    design: { planned_pairs: PAIRS, order: 'alternating baseline/folding, then folding/baseline', max_turns_per_arm: MAX_TURNS,
      temperature: 0, task_sha256: taskHash, source_path: 'worker.ts', source_utf8_bytes_per_read: Buffer.byteLength(source),
      source_sha256: sourceHash, required_read_calls: 2, required_separate_turns: true,
      hook_options: { baseline_delay_requests: 999, folding_delay_requests: 0, min_savings_tokens: 256 },
      isolated_temp_workspace: true, bounded_tool_runner: true },
    trial_loaded_from: 'current worktree hook, not the installed package',
    machine_at_start: { load_average: load, logical_cores: cpus().length },
    preflight: { passed: true, auto_reference_detected: true }, pairs: [], summary: null, run_error: null,
    limitations: ['The task deliberately requires the same source read twice; it does not measure how often ordinary agents repeat reads.',
      'This uses the real provider and production hook with a bounded local tool loop, not Magpie/OpenCode host dispatch.',
      'Provider token counts and cache counts are not a billing amount; no price schedule was applied.',
      'Five pairs are a small sample; wall-clock results are exploratory and no speedup claim is made.'] };

  for (let pair = 1; pair <= PAIRS; pair++) {
    const order = pair % 2 === 1 ? ['baseline', 'folding'] : ['folding', 'baseline'];
    const pairResult = { pair, order, baseline: null, folding: null, valid: false, deltas: null };
    for (const mode of order) {
      const trial = await runArm({ mode, pair, model, endpoint, apiKey, cwd, workerPath, stateDir });
      pairResult[mode] = trial;
      if (trial.completion === 'provider-error') {
        report.pairs.push(pairResult);
        throw new Error(`provider_unavailable_${trial.completion}`);
      }
    }
    const baseline = pairResult.baseline;
    const folding = pairResult.folding;
    pairResult.valid = baseline.success && folding.success && baseline.request_count === folding.request_count
      && baseline.read_calls === folding.read_calls && baseline.final_answer === folding.final_answer
      && baseline.auto_folded_source_reads === 0 && folding.auto_folded_source_reads > 0;
    if (pairResult.valid) {
      pairResult.deltas = {
        provider_input_tokens_saved: baseline.provider_input_tokens - folding.provider_input_tokens,
        provider_output_tokens_saved: baseline.provider_output_tokens !== null && folding.provider_output_tokens !== null
          ? baseline.provider_output_tokens - folding.provider_output_tokens : null,
        sent_request_json_bytes_saved: baseline.requests.reduce((sum, item) => sum + item.sent_request_json_bytes, 0)
          - folding.requests.reduce((sum, item) => sum + item.sent_request_json_bytes, 0),
        end_to_end_ms_saved: baseline.end_to_end_ms - folding.end_to_end_ms,
      };
    }
    report.pairs.push(pairResult);
  }
} catch (error) {
  runError = error?.message === 'provider_unavailable_provider-error' ? 'provider request failed; remaining pairs not run'
    : typeof error?.message === 'string' ? error.message : 'benchmark_failed';
} finally {
  if (report) {
    const valid = report.pairs.filter(item => item.valid);
    const inputDeltas = valid.map(item => item.deltas.provider_input_tokens_saved);
    const byteDeltas = valid.map(item => item.deltas.sent_request_json_bytes_saved);
    const wallDeltas = valid.map(item => item.deltas.end_to_end_ms_saved);
    report.summary = { planned_pairs: PAIRS, completed_pairs: report.pairs.length,
      valid_pairs: valid.length, correct_answers: report.pairs.reduce((sum, pair) =>
        sum + Number(pair.baseline?.answer_correct === true) + Number(pair.folding?.answer_correct === true), 0),
      provider_input_token_savings: { median: median(inputDeltas), range: range(inputDeltas), positive_pairs: inputDeltas.filter(value => value > 0).length },
      sent_request_json_byte_savings: { median: median(byteDeltas), range: range(byteDeltas) },
      end_to_end_milliseconds_saved: { median: median(wallDeltas), range: range(wallDeltas) },
      cache_usage_reported_in_all_requests: report.pairs.length > 0 && report.pairs.every(pair =>
        [pair.baseline, pair.folding].filter(Boolean).every(arm => arm.requests.every(request =>
          request.usage.cache_read_tokens !== null && request.usage.cache_write_tokens !== null))) };
    report.run_error = runError;
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (previousStateDir === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousStateDir;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(root, { recursive: true, force: true });
}

if (runError) {
  console.error(JSON.stringify({ status: 'incomplete', output: outputPath, reason: runError, pairs: report?.pairs.length ?? 0 }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: report.summary.valid_pairs === PAIRS ? 'complete' : 'inconclusive', output: outputPath, summary: report.summary }));
}
