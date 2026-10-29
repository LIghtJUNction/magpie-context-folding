#!/usr/bin/env bun
// Measure provider input overhead from guidance on a short request rejected by the current gate.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../src/context.hooks.ts';
import { appendGuidance, containsGuidance, defaultRecoveryCommand } from '../src/guidance.ts';

const args = process.argv.slice(2);
const valueAfter = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const outputArg = valueAfter('--output');
if (!outputArg) throw new Error('usage: bun scripts/live-guidance-overhead-benchmark.mjs --output docs/benchmarks/<name>.json [--pairs 1-5] [--model name]');
const pairCount = Number(valueAfter('--pairs') ?? 3);
if (!Number.isSafeInteger(pairCount) || pairCount < 1 || pairCount > 5) throw new Error('pair_count_invalid');
const outputPath = resolve(outputArg);
await mkdir(dirname(outputPath), { recursive: true });
try { await access(outputPath); throw new Error('output_already_exists'); }
catch (error) { if (error.message === 'output_already_exists' || error.code !== 'ENOENT') throw error; }
const model = valueAfter('--model') || process.env.MAGPIE_SOURCE_READ_BENCH_MODEL || 'claude-sonnet-5';
const baseUrl = process.env.HARBOR_MODEL_BASE_URL || process.env.ANTHROPIC_BASE_URL;
const apiKey = process.env.HARBOR_MODEL_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
if (!baseUrl || !apiKey) throw new Error('provider_route_credentials_missing');

const endpointFor = base => {
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) throw new Error('provider_base_url_invalid');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path.endsWith('/v1') ? path : `${path}/v1`}/chat/completions`;
};
const endpoint = endpointFor(baseUrl);
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usageSummary(reply) {
  const usage = reply?.usage ?? {};
  const prompt = usage.prompt_tokens_details ?? {};
  const input = usage.input_tokens_details ?? {};
  return {
    input_tokens: safeNumber(usage.prompt_tokens ?? usage.input_tokens),
    output_tokens: safeNumber(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: safeNumber(usage.total_tokens),
    cache_read_tokens: safeNumber(prompt.cached_tokens ?? input.cached_tokens ?? usage.cache_read_input_tokens),
    cache_write_tokens: safeNumber(prompt.cache_write_tokens ?? input.cache_write_tokens ?? usage.cache_creation_input_tokens),
  };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
async function request(body) {
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_network_error');
  }
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  try { return await response.json(); } catch { throw new Error('provider_invalid_json'); }
}

const command = defaultRecoveryCommand();
const guidanceOptions = { command, minSavingsTokens: 256 };
const system = 'Follow the user request exactly. Do not add commentary.';
const question = 'Reply with exactly the word SAPPHIRE and nothing else.';
const tools = [{ type: 'function', function: { name: 'exec_command', description: 'Run a local command if needed.',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } } }];
const bodyFor = () => ({ model, temperature: 0, max_tokens: 16, tools,
  messages: [{ role: 'system', content: system }, { role: 'user', content: question }] });
const contextFor = (session, cwd) => ({ protocol: 'chat', model, session, cwd, origin: 'guidance-overhead-benchmark', agent: 'tool-loop',
  options: { minSavingsTokens: 256, shellToolName: 'exec_command', recoveryCommand: command }, state: {} });

await mkdir(dirname(outputPath), { recursive: true });
const previousStateDir = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const root = await mkdtemp(join(tmpdir(), 'magpie-guidance-overhead-'));
const cwd = join(root, 'cwd');
const stateDir = join(root, 'state');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = stateDir;
await mkdir(join(cwd, '.git'), { recursive: true, mode: 0o700 });

const report = {
  schema_version: 1,
  benchmark: 'live-guidance-overhead-current-gate',
  generated_at: new Date().toISOString(),
  claim_under_test: 'On a short request below the current guidance threshold, provider input tokens are lower when the gate omits guidance than when the same guidance is forced in.',
  provider_model_requested: model,
  gate_source_sha256: sha256(await readFile(join(rootPath, 'src', 'context.hooks.ts'))),
  guidance_source_sha256: sha256(await readFile(join(rootPath, 'src', 'guidance.ts'))),
  request_sha256: sha256(JSON.stringify({ system, question, tools })),
  planned_pairs: pairCount,
  pairs: [],
  run_error: null,
};

try {
  for (let pair = 1; pair <= pairCount; pair++) {
    const order = pair % 2 ? ['gated', 'forced'] : ['forced', 'gated'];
    const result = { pair, order, arms: {} };
    for (const mode of order) {
      const body = bodyFor();
      const session = `guidance-overhead-${String(pair).padStart(2, '0')}-${mode}`;
      const projected = mode === 'gated'
        ? await onRequest(structuredClone(body), contextFor(session, cwd))
        : appendGuidance(body, 'chat', guidanceOptions);
      const guideAdded = containsGuidance(projected, 'chat');
      if ((mode === 'gated' && guideAdded) || (mode === 'forced' && !guideAdded)) {
        throw new Error(`guidance_arm_invalid:${mode}`);
      }
      let reply;
      try { reply = await request(projected); }
      catch (error) { throw new Error(`${mode}:${error.message}`); }
      const choice = reply?.choices?.[0];
      const answer = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
      const inputTokens = usageSummary(reply).input_tokens;
      result.arms[mode] = {
        guide_added: guideAdded,
        request_json_bytes: Buffer.byteLength(JSON.stringify(projected)),
        provider_model: typeof reply.model === 'string' ? reply.model : null,
        finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
        exact_answer: answer === 'SAPPHIRE',
        usage: usageSummary(reply),
      };
      if (inputTokens === null) throw new Error(`provider_input_usage_missing:${mode}`);
    }
    const gated = result.arms.gated.usage.input_tokens;
    const forced = result.arms.forced.usage.input_tokens;
    result.provider_input_tokens_saved = forced - gated;
    result.valid = result.arms.gated.exact_answer && result.arms.forced.exact_answer;
    report.pairs.push(result);
  }
} catch (error) {
  report.run_error = error.message;
} finally {
  if (previousStateDir === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousStateDir;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(root, { recursive: true, force: true });
}

const validPairs = report.pairs.filter(pair => pair.valid);
const savings = validPairs.map(pair => pair.provider_input_tokens_saved);
report.summary = {
  completed_pairs: report.pairs.length,
  valid_pairs: validPairs.length,
  exact_answers: report.pairs.reduce((sum, pair) => sum + Number(pair.arms.gated?.exact_answer ?? false) + Number(pair.arms.forced?.exact_answer ?? false), 0),
  provider_input_tokens_saved_by_gate: savings.length ? { median: median(savings), range: [Math.min(...savings), Math.max(...savings)], positive_pairs: savings.filter(value => value > 0).length } : null,
  request_json_bytes_saved_by_gate: validPairs.map(pair => pair.arms.forced.request_json_bytes - pair.arms.gated.request_json_bytes),
  cache_usage_reported_for_all_requests: report.pairs.length > 0 && report.pairs.every(pair =>
    ['gated', 'forced'].every(mode => pair.arms[mode]?.usage.cache_read_tokens !== null && pair.arms[mode]?.usage.cache_write_tokens !== null)),
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: report.run_error ? 'incomplete' : report.summary.valid_pairs === pairCount ? 'complete' : 'inconclusive',
  output: outputPath, summary: report.summary, reason: report.run_error }));
if (report.run_error) process.exitCode = 1;
