/** Offline comparison of exact duplicate tool output folding; no inference or network access. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const baselineRef = 'e04055e9363add8ce07d6947547dcbb5fadb9dc9';
const rounds = 12;
const outputText = Array.from({ length: 800 }, (_, i) =>
  `Identical tool evidence line ${i}: verified input, output, ownership and expected behavior. 中文😀 quote=" slash=\\\n`).join('');
const summary = 'Repeated tool evidence is preserved in full at its first protected occurrence; inspect the archive for exact recovery.';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
type RecordValue = Record<string, unknown>;
type Result = { label: string; fixtureSha256: string; measurements: { round: number; originalRequestBytes: number; outgoingRequestBytes: number; hookMs: number; toolCalls: number; toolDefinitions: number; messageCount: number; foldedOutputs: number }[]; recovery: { originals: number; layers: number; exact: true }; networkCallsAttempted: number };

function fixture(): RecordValue {
  const messages: RecordValue[] = [{ role: 'system', content: 'Review the recorded tool evidence.' },
    { role: 'user', content: 'Inspect repeated module outputs.' }];
  for (let i = 0; i < 8; i++) {
    const callId = `duplicate_call_${i}`;
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'inspect', arguments: JSON.stringify({ item: i, mode: 'full' }) } }] });
    messages.push({ role: 'tool', tool_call_id: callId, content: outputText });
  }
  return { model: 'offline-duplicate-workload', stream: false, temperature: 0,
    tools: [
      { type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: { item: { type: 'integer' }, mode: { type: 'string' } } } } },
    ], messages };
}

function toolStructure(body: RecordValue) {
  const messages = body.messages as RecordValue[];
  return { tools: body.tools, calls: messages.filter(m => Array.isArray(m.tool_calls)).map(m => m.tool_calls),
    resultIds: messages.filter(m => m.role === 'tool').map(m => m.tool_call_id) };
}

async function worker(label: string, src: string, resultFile: string): Promise<void> {
  let networkCallsAttempted = 0;
  globalThis.fetch = (() => { networkCallsAttempted++; throw new Error('Network is forbidden'); }) as unknown as typeof fetch;
  const hooks = await import(pathToFileURL(join(src, 'context.hooks.ts')).href) as typeof import('../src/context.hooks.js');
  const protocol = await import(pathToFileURL(join(src, 'protocol.ts')).href) as typeof import('../src/protocol.js');
  const { Store } = await import(pathToFileURL(join(src, 'store.ts')).href) as typeof import('../src/store.js');
  const { execute } = await import(pathToFileURL(join(src, 'tool.ts')).href) as typeof import('../src/tool.js');
  const body = fixture();
  const fixtureJSON = JSON.stringify(body);
  const context = { protocol: 'chat', model: 'offline-duplicate-workload', session: 'duplicate-efficiency',
    options: { mode: 'intelligence', thresholdTokens: 1, keepRecentMessages: 1, headChars: 400, policy: { mode: 'bytes', autoRoles: [] } } };
  const stateDir = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  assert.ok(stateDir);
  const store = new Store(stateDir);
  await hooks.onRequest(body, context);
  const scope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
  const spans = protocol.extractSpans(body, 'chat');
  const toolSpans = spans.filter(span => span.role === 'tool');
  assert.equal(toolSpans.length, 8);
  assert.ok(toolSpans.every(span => span.text === outputText));
  const targetSpans = toolSpans.slice(0, 7);
  const markArgs = { scope, action: 'mark', marks: targetSpans.map(span => ({ id: span.id, disposition: 'foldable', summary })) };
  const marked = JSON.parse(await execute(markArgs));
  assert.ok(!marked.error, JSON.stringify(marked));
  const measurements: Result['measurements'] = [];
  let outgoing: RecordValue = {};
  for (let round = 1; round <= rounds; round++) {
    const request = structuredClone(body);
    const start = performance.now();
    outgoing = await hooks.onRequest(request, context) as RecordValue;
    const hookMs = performance.now() - start;
    assert.deepEqual(toolStructure(outgoing), toolStructure(request), 'Tool definitions, calls, IDs and arguments must not change');
    assert.equal(JSON.stringify(body), fixtureJSON, 'Original fixed workload must not be mutated');
    const foldedOutputs = (outgoing.messages as RecordValue[]).filter(message => message.role === 'tool' && message.content !== outputText).length;
    measurements.push({ round, originalRequestBytes: serializedBytes(request), outgoingRequestBytes: serializedBytes(outgoing), hookMs,
      toolCalls: (request.messages as RecordValue[]).filter(message => Array.isArray(message.tool_calls)).length,
      toolDefinitions: (request.tools as unknown[]).length, messageCount: (request.messages as unknown[]).length, foldedOutputs });
  }
  const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, value => structuredClone(value));
  let recovered = 0;
  let layers = 0;
  for (const entry of snapshot.entries) {
    if (entry.text !== outputText) continue;
    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = JSON.parse(await execute({ scope, action: 'read', id: entry.id, offset, limit: 4096 }));
      assert.ok(!page.error, JSON.stringify(page));
      text += page.text;
      offset = page.nextOffset;
    }
    assert.equal(text, outputText);
    recovered++;
    layers += entry.layers.length;
  }
  assert.equal(recovered, 8);
  assert.equal(networkCallsAttempted, 0);
  await writeFile(resultFile, JSON.stringify({ label, fixtureSha256: sha256(fixtureJSON), measurements,
    recovery: { originals: recovered, layers, exact: true }, networkCallsAttempted }, null, 2), { flag: 'wx', mode: 0o600 });
}

async function main() {
  const requestedTemp = resolve(process.argv[2] ?? '');
  assert.ok(process.argv[2], 'Pass the authorized temporary directory');
  const allowedTemp = '/home/lightjunction/.claude/jobs/1c0cc0a1/tmp';
  assert.equal(requestedTemp, allowedTemp, 'Temporary files are restricted to the authorized job directory');
  const job = await mkdtemp(join(allowedTemp, 'magpie-duplicate-efficiency-'));
  const manifest: { label: string; path: string; sha256: string }[] = [];
  for (const label of ['baseline', 'current']) {
    const root = join(job, label);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'config'));
    await mkdir(join(root, 'state'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
    await (await import('node:fs/promises')).symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    const files = label === 'baseline' ? git('ls-tree', '-r', '--name-only', baselineRef, 'src').trim().split('\n').filter(Boolean)
      : git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'src').trim().split('\n').filter(path => path.endsWith('.ts'));
    for (const path of files) {
      const content = label === 'baseline' ? git('show', `${baselineRef}:${path}`) : await readFile(join(repository, path), 'utf8');
      await writeFile(join(root, path), content, { flag: 'wx', mode: 0o600 });
      manifest.push({ label, path, sha256: sha256(content) });
    }
  }
  const run = async (label: string): Promise<Result> => {
    const root = join(job, label), result = join(job, `${label}.json`);
    const child = Bun.spawn([process.execPath, script, '--worker', label, join(root, 'src'), result], {
      cwd: root, env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, `${label} worker failed in ${job}\n${stdout}\n${stderr}`);
    assert.equal(stderr, '');
    return JSON.parse(await readFile(result, 'utf8')) as Result;
  };
  const [baseline, current] = await Promise.all([run('baseline'), run('current')]);
  assert.equal(baseline.fixtureSha256, current.fixtureSha256);
  assert.equal(baseline.recovery.originals, current.recovery.originals);
  assert.equal(baseline.recovery.exact && current.recovery.exact, true);
  const comparisons = baseline.measurements.map((old, i) => {
    const now = current.measurements[i]!;
    assert.equal(old.originalRequestBytes, now.originalRequestBytes);
    assert.equal(old.toolCalls, now.toolCalls);
    assert.equal(old.toolDefinitions, now.toolDefinitions);
    assert.equal(old.messageCount, now.messageCount);
    return { round: old.round, originalRequestBytes: old.originalRequestBytes,
      baselineRequestBytes: old.outgoingRequestBytes, currentRequestBytes: now.outgoingRequestBytes,
      bytesSaved: old.outgoingRequestBytes - now.outgoingRequestBytes,
      percentSaved: (old.outgoingRequestBytes - now.outgoingRequestBytes) / old.outgoingRequestBytes * 100,
      baselineHookMs: old.hookMs, currentHookMs: now.hookMs, baselineFoldedOutputs: old.foldedOutputs, currentFoldedOutputs: now.foldedOutputs };
  });
  const totals = { rounds, originalRequestBytes: comparisons.reduce((s, x) => s + x.originalRequestBytes, 0),
    baselineRequestBytes: comparisons.reduce((s, x) => s + x.baselineRequestBytes, 0), currentRequestBytes: comparisons.reduce((s, x) => s + x.currentRequestBytes, 0),
    bytesSaved: comparisons.reduce((s, x) => s + x.bytesSaved, 0),
    percentSaved: comparisons.reduce((s, x) => s + x.bytesSaved, 0) / comparisons.reduce((s, x) => s + x.baselineRequestBytes, 0) * 100 };
  const report = { generatedAt: new Date().toISOString(), job, baselineRef, currentHead: git('rev-parse', 'HEAD').trim(), manifest,
    workload: { rounds, identicalToolOutputs: 8, explicitlyMarkedEligibleOutputs: 7, protectedFullCopy: 1, modelRequests: 0, networkCalls: 0 },
    measurement: 'UTF-8 bytes of JSON.stringify for the complete outgoing request; hook time is local wall time only.', totals, comparisons,
    recovery: { baseline: baseline.recovery, current: current.recovery }, baselineWorker: baseline, currentWorker: current,
    limitations: ['No model inference, token counting, billing, output quality evaluation, or network access was performed.',
      'Hook timings are noisy local observations; workers run concurrently and do not represent host latency.',
      'This synthetic workload uses one exact duplicate group and supplied summaries; automatic policy quality is not evaluated.'] };
  const output = join(job, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, totals, recovery: report.recovery, modelRequests: 0, networkCalls: 0 }));
}

if (process.argv[2] === '--worker') await worker(process.argv[3]!, process.argv[4]!, process.argv[5]!);
else await main();
