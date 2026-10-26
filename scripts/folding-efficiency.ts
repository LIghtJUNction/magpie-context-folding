/** Offline, fixed-workload comparison. Never contacts an inference or accounting endpoint. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Snapshot } from '../src/store.js';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const baselineRef = 'e04055e9363add8ce07d6947547dcbb5fadb9dc9';
const rounds = 12;
const headChars = 400;
const summaries = [
  'Completed evidence: selected modules passed their recorded input and output checks. Read the archived evidence before relying on individual details. '.repeat(12).slice(0, 1600).trim(),
  'Completed checks passed; archived observations remain available for exact inspection. '.repeat(11).slice(0, 900).trim(),
  'Completed checks passed; consult original evidence for details.',
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const textBytes = (text: string) => Buffer.byteLength(text);
const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
type Body = Record<string, unknown>;
type Message = Record<string, unknown>;
type Measurement = {
  round: number; stage: number; originalRequestBytes: number; outgoingRequestBytes: number;
  originalBytesDiv4Estimate: number; outgoingBytesDiv4Estimate: number;
  representationContentUtf8Bytes: number; representationJsonStringBytes: number;
  summaryContentUtf8Bytes: number; retainedOpeningUtf8Bytes: number; representationOtherUtf8Bytes: number;
  guideAndBudgetSerializedOverheadBytes: number; foldedSpans: number;
  originalMessageCount: number; outgoingMessageCount: number; toolDefinitions: number; toolCalls: number;
  originalToolArgumentsBytes: number; hookMs: number; layerCount: number;
};
type WorkerResult = {
  label: string; stateDirectory: string; scope: string; fixtureSha256: string;
  options: unknown; summaries: string[]; targetIds: string[]; measurements: Measurement[];
  recovery: { originalEntries: number; layers: number; paginatedReadCalls: number; exact: true; chainsReachOriginal: true };
  warmReplay: { requests: number; layersBefore: number; layersAfter: number; bytesStable: true; outputStable: true };
  markOperations: { stage: number; argumentsBytes: number; resultBytes: number }[];
  networkCallsAttempted: number; stateDatabaseBytes: number;
};

function fixture(): Body[] {
  const messages: Message[] = [
    { role: 'system', content: 'Preserve active requirements and distinguish tool evidence from assistant conclusions.' },
    { role: 'user', content: 'Inspect eight independent modules. Preserve exact historical evidence for recovery.' },
  ];
  for (let module = 0; module < 8; module++) {
    // Prefix every line with its independent module: these are not file revisions or similar-result aliases.
    const evidence = Array.from({ length: 600 }, (_, line) =>
      `Module_${module} evidence_${line}: verified inputs, outputs, ownership and expected behavior; completed local observation. 中文😀 quote=" slash=\\\n`).join('');
    const reasoning = Array.from({ length: 300 }, (_, line) =>
      `Review_${module} decision_${line}: the module's recorded observations support completion; inspect archived source before reusing exact details.\n`).join('');
    messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `call_${module}`, type: 'function', function: {
        name: 'inspect_module', arguments: JSON.stringify({ module, checks: ['inputs', 'outputs'], limit: 600 }),
      } }] },
      { role: 'tool', tool_call_id: `call_${module}`, content: evidence },
      { role: 'assistant', content: reasoning },
    );
  }
  const tools = [
    { type: 'function', function: { name: 'context_folding', description: 'Recover exact archived history.', parameters: {
      type: 'object', properties: { action: { type: 'string' }, scope: { type: 'string' }, id: { type: 'string' } },
    } } },
    { type: 'function', function: { name: 'inspect_module', parameters: { type: 'object', properties: {
      module: { type: 'integer' }, checks: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' },
    } } } },
  ];
  const result: Body[] = [];
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) messages.push({ role: 'assistant', content: `Round ${round - 1}: retain current requirements and exact evidence references.` });
    messages.push({ role: 'user', content: `Round ${round}: continue the fixed review; retain current requirements and all exact recovery references.` });
    result.push(structuredClone({ model: 'offline-fixed-workload', stream: false, temperature: 0, tools, messages }));
  }
  return result;
}

function toolStructure(body: Body) {
  const messages = body.messages as Message[];
  return {
    tools: body.tools,
    calls: messages.flatMap((message, index) => Array.isArray(message.tool_calls) ? [{ index, calls: message.tool_calls }] : []),
    results: messages.flatMap((message, index) => message.role === 'tool' ? [{ index, id: message.tool_call_id }] : []),
    roles: messages.map(message => message.role),
  };
}

async function worker(label: string, sourceDirectory: string, output: string): Promise<void> {
  let networkCallsAttempted = 0;
  globalThis.fetch = (() => {
    networkCallsAttempted++;
    throw new Error('Network is forbidden in the offline efficiency comparison');
  }) as unknown as typeof fetch;
  const hooks = await import(pathToFileURL(join(sourceDirectory, 'context.hooks.ts')).href) as typeof import('../src/context.hooks.js');
  const protocol = await import(pathToFileURL(join(sourceDirectory, 'protocol.ts')).href) as typeof import('../src/protocol.js');
  const archive = await import(pathToFileURL(join(sourceDirectory, 'store.ts')).href) as typeof import('../src/store.js');
  const tool = await import(pathToFileURL(join(sourceDirectory, 'tool.ts')).href) as typeof import('../src/tool.js');
  const { loadOptions } = await import(pathToFileURL(join(sourceDirectory, 'config.ts')).href) as typeof import('../src/config.js');
  const bodies = fixture();
  const originalFixture = JSON.stringify(bodies);
  // Exact intelligence defaults, with automatic selection disabled solely to apply identical supplied summaries.
  const options = { mode: 'intelligence', thresholdTokens: 64_000, keepRecentMessages: 12, headChars,
    policy: { mode: 'bytes', autoRoles: [] } };
  // Omit cwd from the scope: state keys differ between independent stores, while scope metadata stays equal length.
  const context = { protocol: 'chat', model: 'offline-fixed-workload', session: 'efficiency-fixed-workload', options };
  const effectiveOptions = await loadOptions(options);
  assert.equal(effectiveOptions.mode, 'intelligence');
  assert.equal(effectiveOptions.thresholdTokens, 64_000);
  assert.equal(effectiveOptions.keepRecentMessages, 12);
  assert.equal(effectiveOptions.headChars, headChars);
  assert.equal(effectiveOptions.policy.mode, 'bytes');
  assert.deepEqual(effectiveOptions.policy.autoRoles, []);
  const expectedOriginals = new Map(bodies.flatMap(body => protocol.extractSpans(body, 'chat')).map(span => [span.id, span.text]));
  const expectedLayers = new Map<string, string[]>();
  const markOperations: WorkerResult['markOperations'] = [];
  const stateDirectory = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  assert.ok(stateDirectory);
  const store = new archive.Store(stateDirectory);
  await hooks.onRequest(bodies[0], context); // Identical unmeasured discovery; no model call.
  const scope = await store.scopeFor(JSON.stringify([context.session, '', '', '']));
  const spans = protocol.extractSpans(bodies[0]!, 'chat');
  const targets = spans.filter(span => (span.role === 'tool' || span.role === 'assistant') && span.text.length > 20_000).slice(0, 6);
  assert.equal(targets.length, 6);
  const snapshot = () => store.transaction(scope, false, 64 * 1024 * 1024, value => structuredClone(value));
  const measurements: Measurement[] = [];
  let outgoing: Body = {};
  for (let index = 0; index < rounds; index++) {
    const body = bodies[index]!;
    const stage = Math.floor(index / 4);
    if (index % 4 === 0) {
      const argumentsValue = { scope, action: 'mark', marks: targets.map(target => ({
        id: target.id, disposition: 'foldable', summary: summaries[stage]!,
      })) };
      const marked = JSON.parse(await tool.execute(argumentsValue));
      assert.ok(!marked.error, JSON.stringify(marked));
      markOperations.push({ stage: stage + 1, argumentsBytes: bytes(argumentsValue), resultBytes: bytes(marked) });
    }
    const start = performance.now();
    outgoing = await hooks.onRequest(body, context) as Body;
    const hookMs = performance.now() - start;
    const state = await snapshot();
    assert.equal(state.appliedMode, 'intelligence');
    const targetEntries = targets.map(target => state.entries.find(entry => entry.id === target.id)!);
    assert.ok(targetEntries.every(entry => entry && entry.folded && entry.layers.length === stage + 1), JSON.stringify(state.decision));
    assert.ok(targetEntries.every(entry => entry.mark.disposition === 'foldable' && entry.mark.summary === summaries[stage]));
    for (const entry of targetEntries) {
      assert.ok(entry.folded!.includes(summaries[stage]!));
      assert.ok(entry.folded!.includes(JSON.stringify(entry.text.slice(0, headChars))));
      const previous = expectedLayers.get(entry.id) ?? [];
      if (index % 4 === 0) { previous.push(entry.folded!); expectedLayers.set(entry.id, previous); }
      else assert.equal(entry.folded, previous.at(-1));
    }
    const replacements = new Map(targetEntries.map(entry => [entry.id, entry.folded!]));
    const withoutGuide = protocol.replaceSpans(body, replacements, 'chat');
    const foldedSpans = protocol.extractSpans(withoutGuide, 'chat');
    const outgoingSpans = protocol.extractSpans(outgoing, 'chat');
    // Compare every history slot except the final user span to which the hook appends its guidance.
    assert.equal(outgoingSpans.length, foldedSpans.length);
    for (let position = 0; position < foldedSpans.length - 1; position++) {
      assert.equal(outgoingSpans[position]!.text, foldedSpans[position]!.text);
    }
    const guideRemoved = structuredClone(outgoing);
    const outgoingMessages = guideRemoved.messages as Message[];
    const inputLastMessage = (body.messages as Message[]).at(-1)!;
    assert.equal(typeof outgoingMessages.at(-1)!.content, 'string');
    assert.ok((outgoingMessages.at(-1)!.content as string).startsWith(inputLastMessage.content as string));
    assert.ok((outgoingMessages.at(-1)!.content as string).includes(`<context-folding scope=${scope}>`));
    assert.ok((outgoingMessages.at(-1)!.content as string).includes('<context-budget>'));
    outgoingMessages[outgoingMessages.length - 1]!.content = inputLastMessage.content;
    assert.deepEqual(guideRemoved, withoutGuide, 'Only selected text spans and the appended guide may change');
    assert.deepEqual(toolStructure(outgoing), toolStructure(body), 'Tool definitions, calls, arguments, IDs, roles and message counts must be preserved');
    const contentBytes = targetEntries.reduce((sum, entry) => sum + textBytes(entry.folded!), 0);
    const summaryBytes = targetEntries.reduce((sum) => sum + textBytes(summaries[stage]!), 0);
    const openingBytes = targetEntries.reduce((sum, entry) => sum + textBytes(entry.text.slice(0, headChars)), 0);
    const structure = toolStructure(body);
    const calls = structure.calls.flatMap(item => item.calls as { function: { arguments: string } }[]);
    measurements.push({ round: index + 1, stage: stage + 1,
      originalRequestBytes: bytes(body), outgoingRequestBytes: bytes(outgoing),
      originalBytesDiv4Estimate: Math.ceil(bytes(body) / 4), outgoingBytesDiv4Estimate: Math.ceil(bytes(outgoing) / 4),
      representationContentUtf8Bytes: contentBytes,
      representationJsonStringBytes: targetEntries.reduce((sum, entry) => sum + bytes(entry.folded), 0),
      summaryContentUtf8Bytes: summaryBytes, retainedOpeningUtf8Bytes: openingBytes,
      representationOtherUtf8Bytes: contentBytes - summaryBytes - openingBytes,
      guideAndBudgetSerializedOverheadBytes: bytes(outgoing) - bytes(withoutGuide),
      foldedSpans: targetEntries.length, originalMessageCount: (body.messages as unknown[]).length,
      outgoingMessageCount: (outgoing.messages as unknown[]).length, toolDefinitions: (body.tools as unknown[]).length,
      toolCalls: calls.length, originalToolArgumentsBytes: calls.reduce((sum, call) => sum + textBytes(call.function.arguments), 0),
      hookMs, layerCount: targetEntries.reduce((sum, entry) => sum + entry.layers.length, 0),
    });
  }
  assert.equal(JSON.stringify(bodies), originalFixture, 'Hooks must not mutate the original workload');
  const before = await snapshot();
  const layerCount = (value: Snapshot) => value.entries.reduce((sum, entry) => sum + entry.layers.length, 0);
  const layerState = (value: Snapshot) => value.entries.map(entry => ({ id: entry.id, text: entry.text, mark: entry.mark, folded: entry.folded, layers: entry.layers }));
  for (let replay = 0; replay < 5; replay++) {
    assert.deepEqual(await hooks.onRequest(bodies.at(-1), context), outgoing);
  }
  const after = await snapshot();
  assert.deepEqual(layerState(after), layerState(before), 'Warm replay must not add layers or change archive contents');
  let paginatedReadCalls = 0;
  async function recover(id: string, layer: string, expected: string) {
    let recovered = '';
    let offset: number | null = 0;
    let previousId: string | null = null;
    while (offset !== null) {
      const page = JSON.parse(await tool.execute({ scope, action: 'read', id, layer, offset, limit: 4096, peek: true }));
      assert.ok(!page.error, JSON.stringify(page));
      paginatedReadCalls++;
      assert.equal(page.sha256, sha256(expected));
      previousId = page.previousId;
      recovered += page.text;
      assert.ok(page.nextOffset === null || page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(recovered, expected);
    return previousId;
  }
  let restoredLayers = 0;
  assert.deepEqual(new Set(after.entries.map(entry => entry.id)), new Set(expectedOriginals.keys()),
    'Every span from the fixed request history must remain archived');
  // Recover every original archived span, including active and never-folded content.
  for (const entry of after.entries) {
    assert.equal(entry.text, expectedOriginals.get(entry.id), 'Archived original differs from the fixed source history');
    await recover(entry.id, 'original', expectedOriginals.get(entry.id)!);
    let next = entry.layers.at(-1)?.id ?? 'original';
    const visited = new Set<string>();
    while (next !== 'original') {
      assert.ok(!visited.has(next), 'Layer chain must be acyclic');
      visited.add(next);
      const layer = entry.layers.find(item => item.id === next);
      assert.ok(layer);
      const expectedLayer = expectedLayers.get(entry.id)?.[entry.layers.length - visited.size];
      assert.equal(layer.text, expectedLayer, 'Archived layer differs from its original outgoing representation');
      next = (await recover(entry.id, layer.id, expectedLayer!))!;
      restoredLayers++;
    }
    assert.equal(visited.size, entry.layers.length, 'All layers must be reachable from the latest layer');
  }
  assert.equal(networkCallsAttempted, 0);
  assert.deepEqual((await readdir(stateDirectory)).sort(), ['state.sqlite'], 'Archive must not leave per-request files');
  const result: WorkerResult = {
    label, stateDirectory, scope, fixtureSha256: sha256(originalFixture), options: effectiveOptions, summaries, targetIds: targets.map(target => target.id), measurements, markOperations,
    recovery: { originalEntries: after.entries.length, layers: restoredLayers, paginatedReadCalls, exact: true, chainsReachOriginal: true },
    warmReplay: { requests: 5, layersBefore: layerCount(before), layersAfter: layerCount(after), bytesStable: true, outputStable: true },
    networkCallsAttempted, stateDatabaseBytes: (await stat(join(stateDirectory, 'state.sqlite'))).size,
  };
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
}

async function main() {
  const jobRoot = process.argv[2];
  assert.ok(jobRoot, 'Pass the workflow job temporary directory as the first argument');
  const job = await mkdtemp(join(resolve(jobRoot), 'magpie-folding-efficiency-'));
  const files = git('ls-tree', '-r', '--name-only', baselineRef, 'src').trim().split('\n').filter(Boolean);
  const currentFiles = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'src').trim().split('\n').filter(file => file.endsWith('.ts'));
  const manifest: { label: string; path: string; sha256: string }[] = [];
  for (const label of ['baseline', 'current']) {
    const root = join(job, label);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git')); // Stop project configuration discovery inside this isolated directory.
    await mkdir(join(root, 'config'));
    await mkdir(join(root, 'state'));
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of label === 'baseline' ? files : currentFiles) {
      const content = label === 'baseline' ? git('show', `${baselineRef}:${file}`) : await readFile(join(repository, file), 'utf8');
      const target = join(root, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
      manifest.push({ label, path: file, sha256: sha256(content) });
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
  }
  const run = async (label: string) => {
    const root = join(job, label);
    const output = join(job, `${label}-result.json`);
    const child = Bun.spawn([process.execPath, script, '--worker', label, join(root, 'src'), output], {
      cwd: root, env: { ...process.env, MAGPIE_CONTEXT_FOLDING_STATE_DIR: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(exitCode, 0, `${label} worker failed; retained job ${job}\n${stdout}\n${stderr}`);
    assert.equal(stderr, '', `${label} hook emitted diagnostics`);
    return JSON.parse(await readFile(output, 'utf8')) as WorkerResult;
  };
  const [baseline, current] = await Promise.all([run('baseline'), run('current')]);
  for (const source of manifest.filter(value => value.label === 'current')) {
    assert.equal(sha256(await readFile(join(repository, source.path), 'utf8')), source.sha256,
      `Current source changed while measuring; retained non-final job ${job}: ${source.path}`);
  }
  assert.equal(baseline.fixtureSha256, current.fixtureSha256);
  assert.deepEqual(baseline.options, current.options);
  assert.deepEqual(baseline.summaries, current.summaries);
  assert.deepEqual(baseline.targetIds, current.targetIds);
  assert.deepEqual(baseline.markOperations, current.markOperations, 'Mark tool argument/result volume must stay fixed');
  const comparisons = baseline.measurements.map((old, index) => {
    const next = current.measurements[index]!;
    for (const key of ['originalRequestBytes', 'originalMessageCount', 'outgoingMessageCount', 'toolDefinitions', 'toolCalls',
      'originalToolArgumentsBytes', 'foldedSpans', 'summaryContentUtf8Bytes', 'retainedOpeningUtf8Bytes', 'layerCount'] as const) {
      assert.equal(old[key], next[key], `Workload mismatch: ${key}`);
    }
    return { round: old.round, stage: old.stage, originalBytes: old.originalRequestBytes,
      baselineFoldedBytes: old.outgoingRequestBytes, currentFoldedBytes: next.outgoingRequestBytes,
      incrementalOptimizationBytes: old.outgoingRequestBytes - next.outgoingRequestBytes,
      incrementalOptimizationPercent: (old.outgoingRequestBytes - next.outgoingRequestBytes) / old.outgoingRequestBytes * 100,
      baselineRepresentationBytes: old.representationJsonStringBytes, currentRepresentationBytes: next.representationJsonStringBytes,
      baselineGuideAndBudgetOverheadBytes: old.guideAndBudgetSerializedOverheadBytes,
      currentGuideAndBudgetOverheadBytes: next.guideAndBudgetSerializedOverheadBytes };
  });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const totals = {
    originalBytes: sum(comparisons.map(value => value.originalBytes)),
    baselineFoldedBytes: sum(comparisons.map(value => value.baselineFoldedBytes)),
    currentFoldedBytes: sum(comparisons.map(value => value.currentFoldedBytes)),
    originalEstimatedTokens: sum(baseline.measurements.map(value => value.originalBytesDiv4Estimate)),
    baselineFoldedEstimatedTokens: sum(baseline.measurements.map(value => value.outgoingBytesDiv4Estimate)),
    currentFoldedEstimatedTokens: sum(current.measurements.map(value => value.outgoingBytesDiv4Estimate)),
    existingFoldingSavedBytes: sum(comparisons.map(value => value.originalBytes - value.baselineFoldedBytes)),
    baselineGuideAndBudgetOverheadBytes: sum(comparisons.map(value => value.baselineGuideAndBudgetOverheadBytes)),
    currentGuideAndBudgetOverheadBytes: sum(comparisons.map(value => value.currentGuideAndBudgetOverheadBytes)),
    baselineRepresentationJsonStringBytes: sum(comparisons.map(value => value.baselineRepresentationBytes)),
    currentRepresentationJsonStringBytes: sum(comparisons.map(value => value.currentRepresentationBytes)),
    markArgumentsBytesPerVersion: sum(baseline.markOperations.map(value => value.argumentsBytes)),
    markResultBytesPerVersion: sum(baseline.markOperations.map(value => value.resultBytes)),
    incrementalOptimizationBytes: sum(comparisons.map(value => value.incrementalOptimizationBytes)),
    incrementalOptimizationPercent: sum(comparisons.map(value => value.incrementalOptimizationBytes)) / sum(comparisons.map(value => value.baselineFoldedBytes)) * 100,
  };
  const result = {
    generatedAt: new Date().toISOString(), job, baselineRef, currentHead: git('rev-parse', 'HEAD').trim(),
    benchmarkSha256: sha256(await readFile(script, 'utf8')),
    currentWorkingTree: git('status', '--short'), runtime: process.versions.bun, manifest,
    workload: { rounds, summaries, headChars, mode: 'intelligence', discoveryHookCallsPerVersion: 1,
      measuredHookCallsPerVersion: rounds, warmReplayCallsPerVersion: 5, markBatchesPerVersion: 3,
      modelRequests: 0, accountingRequests: 0, fixedHistorySha256: baseline.fixtureSha256 },
    measurement: 'UTF-8 bytes of complete JSON.stringify(request); bytes/4 estimates rounded up per request. Transport framing and provider tokenization are not measured.',
    comparisons, totals, baseline, current,
    limitations: [
      'Offline serialization and archive recovery evidence only; no paid or local model inference was run.',
      'Exact recoverability does not establish equal intelligence, answer quality, or equal billed tokens.',
      'No billing savings or seven-day quota guarantee: remaining quota, reset time/window, real input/output rates, model prices, cache behavior, recovery frequency and added output are missing.',
      'Recovery tool reads are local verification operations outside the fixed request total; their provider-side tokens and fees were not measured.',
      'Hook timings are observations from concurrent local workers, not model latency or a controlled runtime speed comparison.',
      'Original history remains identical. Automatic selection is disabled in both versions so precisely the same six spans receive the same three supplied summaries.',
    ],
  };
  const outputPath = join(job, 'result.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outputPath, totals, recovery: { baseline: baseline.recovery, current: current.recovery },
    warmReplay: { baseline: baseline.warmReplay, current: current.warmReplay }, modelRequests: 0 }));
}

if (process.argv[2] === '--worker') {
  assert.ok(process.argv[3] && process.argv[4] && process.argv[5]);
  await worker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await main();
}
