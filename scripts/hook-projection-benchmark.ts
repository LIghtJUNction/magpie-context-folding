import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendGuidance, appendGuidanceToCleanBody, defaultRecoveryCommand, withoutGuidance } from '../src/guidance.js';
import { createJsonMeasurementCache, estimateTokens } from '../src/metrics.js';
import { extractSpans, projectExtractedSpans, replaceExtractedSpans, type Protocol } from '../src/protocol.js';
import { appendRecoveryMetadata, withoutRecoveryMetadata } from '../src/recovery.js';
import { cleanRequestBody } from '../src/request-clean.js';

const args = process.argv.slice(2);
let outputPath: string | undefined;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: hook-projection-benchmark.ts [--output PATH]');
  outputPath = resolve(args[1]!);
}

const protocol = 'chat' as const;
const protocols: readonly Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];
const options = { command: defaultRecoveryCommand() };
const profileOnly = process.env.MAGPIE_HOOK_PROJECTION_PROFILE_ONLY === '1';
const messages: Record<string, unknown>[] = [
  { role: 'system', content: 'Preserve the task constraints.' },
  { role: 'user', content: 'Continue the analysis.' },
];
for (let index = 0; index < 96; index++) {
  messages.push({ role: 'assistant', content: `Stage ${index}: ${'x'.repeat(4096)}` });
  messages.push({ role: 'user', content: `Continue from stage ${index}.` });
}
const raw = { model: 'projection-benchmark', tools: [{ type: 'function', function: { name: 'exec_command' } }], messages };
const scope = 'a'.repeat(64);
const dirty = appendRecoveryMetadata(appendGuidance(raw, protocol, options), protocol, scope);
const before = structuredClone(dirty);
const expected = appendGuidance(raw, protocol, options);
function foldRequest(foldProtocol: Protocol): Record<string, unknown> {
  const detail = (index: number) => `<!-- @context-fold begin projection-${index} -->\n${'d'.repeat(4096)}\n<!-- @context-fold end projection-${index} -->`;
  const items: { role: 'user' | 'assistant'; text: string }[] = [{ role: 'user', text: 'Continue the analysis.' }];
  for (let index = 0; index < 96; index++) {
    items.push({ role: 'assistant', text: index < 3 ? detail(index) : `Stage ${index}: ${'x'.repeat(4096)}` });
    items.push({ role: 'user', text: `Continue from stage ${index}.` });
  }
  if (foldProtocol === 'chat') return {
    model: 'projection-benchmark', tools: [{ type: 'function', function: { name: 'exec_command' } }],
    messages: [{ role: 'system', content: 'Preserve the task constraints.' },
      ...items.map(item => ({ role: item.role, content: item.text }))],
  };
  if (foldProtocol === 'responses') return {
    model: 'projection-benchmark', instructions: 'Preserve the task constraints.',
    tools: [{ type: 'function', name: 'exec_command' }],
    input: items.map(item => ({ role: item.role, content: [{
      type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text,
    }] })),
  };
  if (foldProtocol === 'anthropic') return {
    model: 'projection-benchmark', system: [{ type: 'text', text: 'Preserve the task constraints.' }],
    tools: [{ name: 'exec_command', input_schema: { type: 'object' } }],
    messages: items.map(item => ({ role: item.role, content: item.role === 'assistant'
      ? [{ type: 'text', text: item.text }] : item.text })),
  };
  return {
    model: 'projection-benchmark', systemInstruction: { parts: [{ text: 'Preserve the task constraints.' }] },
    tools: [{ functionDeclarations: [{ name: 'exec_command' }] }],
    contents: items.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.text }] })),
  };
}

// Reproduce the prior guide-only path, including two input-cleaning clones,
// discarded guidance validation, empty replacement, and final injection.
const legacy = () => {
  const clean = withoutGuidance(withoutRecoveryMetadata(dirty, protocol), protocol);
  const spans = extractSpans(clean, protocol);
  appendGuidance(clean, protocol, options);
  return appendGuidance(replaceExtractedSpans(clean, new Map(), protocol, spans), protocol, options);
};
const optimized = () => {
  const clean = cleanRequestBody(dirty, protocol);
  extractSpans(clean, protocol);
  return appendGuidanceToCleanBody(clean, protocol, options);
};

if (!profileOnly) {
  for (const output of [legacy(), optimized()]) assert.deepEqual(output, expected);
  assert.deepEqual(dirty, before);
}

const samples = { legacy: [] as number[], optimized: [] as number[] };
const rounds = 15;
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? ['legacy', 'optimized'] as const : ['optimized', 'legacy'] as const;
  for (const side of order) {
    const start = performance.now();
    const output = side === 'legacy' ? legacy() : optimized();
    samples[side].push(performance.now() - start);
    if (!profileOnly) {
      assert.deepEqual(output, expected);
      assert.deepEqual(dirty, before);
    }
  }
}
const summary = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return { medianMs: sorted[Math.floor(sorted.length / 2)]!, minMs: sorted[0]!, maxMs: sorted.at(-1)!, samplesMs: values };
};
const spanProjections = [];
for (const foldProtocol of protocols) {
  const foldBody = foldRequest(foldProtocol);
  const foldSpans = extractSpans(foldBody, foldProtocol);
  const markedSpans = foldSpans.filter(span => span.text.includes('<!-- @context-fold begin projection-'));
  assert.equal(markedSpans.length, 3, `${foldProtocol} fixture must expose three marked assistant spans`);
  const foldReplacements = new Map(markedSpans.map((span, index) =>
    [span.id, `[[cf:v2:${'a'.repeat(23)}${index.toString(16)}]]`]));
  const foldExpected = replaceExtractedSpans(foldBody, foldReplacements, foldProtocol, foldSpans);
  const foldBefore = structuredClone(foldBody);
  const measurementInput = { ...foldBody };
  const previousProjection = projectExtractedSpans(foldBody,
    new Map([...foldReplacements].slice(0, 1)), foldProtocol, foldSpans);
  const legacyMeasurements = () => ({
    netSaving: estimateTokens(foldBody) - estimateTokens(foldExpected),
    estimatedNetSavings: estimateTokens(foldBody) - estimateTokens(foldExpected),
    beforeBytes: Buffer.byteLength(JSON.stringify(measurementInput)),
    afterBytes: Buffer.byteLength(JSON.stringify(foldExpected)),
    foldedTokensEstimated: Math.max(0, estimateTokens(previousProjection) - estimateTokens(foldExpected)),
    estimatedTokenDelta: estimateTokens(measurementInput) - estimateTokens(foldExpected),
  });
  const cachedMeasurements = () => {
    const measure = createJsonMeasurementCache();
    const input = measure(measurementInput);
    const body = measure(foldBody);
    const result = measure(foldExpected);
    const previous = measure(previousProjection);
    return {
      netSaving: body.estimatedTokens - result.estimatedTokens,
      estimatedNetSavings: body.estimatedTokens - result.estimatedTokens,
      beforeBytes: input.bytes,
      afterBytes: result.bytes,
      foldedTokensEstimated: Math.max(0, previous.estimatedTokens - result.estimatedTokens),
      estimatedTokenDelta: input.estimatedTokens - result.estimatedTokens,
    };
  };
  const expectedMeasurements = legacyMeasurements();
  assert.deepEqual(cachedMeasurements(), expectedMeasurements);
  const measurementSamples = { repeatedSerialization: [] as number[], cached: [] as number[] };
  const samples = { deepClone: [] as number[], copyOnWrite: [] as number[] };
  const batchSamples = { deepClone: [] as number[], copyOnWrite: [] as number[] };
  const copyOnWrite = () => projectExtractedSpans(foldBody, foldReplacements, foldProtocol, foldSpans);
  const deepCloneBatch = () => Array.from({ length: 3 }, () =>
    replaceExtractedSpans(foldBody, foldReplacements, foldProtocol, foldSpans));
  const copyOnWriteBatch = () => Array.from({ length: 3 }, () =>
    projectExtractedSpans(foldBody, foldReplacements, foldProtocol, foldSpans));
  const historyKey = foldProtocol === 'responses' ? 'input' : foldProtocol === 'gemini' ? 'contents' : 'messages';
  const untouchedIndex = foldProtocol === 'chat' ? 3 : 2;
  if (!profileOnly) {
    assert.deepEqual(copyOnWrite(), foldExpected);
    assert.deepEqual(foldBody, foldBefore);
    for (const span of markedSpans) {
      assert.notStrictEqual((copyOnWrite()[historyKey] as unknown[])[span.messageIndex],
        (foldBody[historyKey] as unknown[])[span.messageIndex]);
    }
    assert.strictEqual((copyOnWrite()[historyKey] as unknown[])[untouchedIndex], (foldBody[historyKey] as unknown[])[untouchedIndex]);
  }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ['repeatedSerialization', 'cached'] as const : ['cached', 'repeatedSerialization'] as const;
    for (const side of order) {
      const start = performance.now();
      const output = side === 'repeatedSerialization' ? legacyMeasurements() : cachedMeasurements();
      measurementSamples[side].push(performance.now() - start);
      assert.deepEqual(output, expectedMeasurements);
    }
  }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ['deepClone', 'copyOnWrite'] as const : ['copyOnWrite', 'deepClone'] as const;
    for (const side of order) {
      const start = performance.now();
      const output = side === 'deepClone'
        ? replaceExtractedSpans(foldBody, foldReplacements, foldProtocol, foldSpans) : copyOnWrite();
      samples[side].push(performance.now() - start);
      if (!profileOnly) {
        assert.deepEqual(output, foldExpected);
        assert.deepEqual(foldBody, foldBefore);
      }
    }
  }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ['deepClone', 'copyOnWrite'] as const : ['copyOnWrite', 'deepClone'] as const;
    for (const side of order) {
      const start = performance.now();
      const output = side === 'deepClone' ? deepCloneBatch() : copyOnWriteBatch();
      batchSamples[side].push(performance.now() - start);
      if (!profileOnly) {
        assert.deepEqual(output, [foldExpected, foldExpected, foldExpected]);
        assert.deepEqual(foldBody, foldBefore);
      }
    }
  }
  spanProjections.push({
    protocol: foldProtocol,
    requestBytes: Buffer.byteLength(JSON.stringify(foldBody)),
    replacedRegions: foldReplacements.size,
    requestMeasurements: {
      repeatedSerialization: summary(measurementSamples.repeatedSerialization),
      cached: summary(measurementSamples.cached),
      fullFoldPathSerializationPasses: { repeated: 10, cached: 5 },
    },
    deepClone: summary(samples.deepClone),
    copyOnWrite: summary(samples.copyOnWrite),
    threeProjectionBatch: {
      deepClone: summary(batchSamples.deepClone),
      copyOnWrite: summary(batchSamples.copyOnWrite),
    },
  });
}
const sourceFiles = ['scripts/hook-projection-benchmark.ts', 'src/context.hooks.ts', 'src/metrics.ts', 'src/request-clean.ts',
  'src/guidance.ts', 'src/recovery.ts', 'src/protocol.ts'];
const report = {
  benchmark: 'synthetic-context-folding-hook-projection-and-measurement',
  completedAt: new Date().toISOString(),
  sourceRevision: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFilesSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  fixture: { protocol, assistantMessages: 96, messageBytes: 4096, requestBytes: Buffer.byteLength(JSON.stringify(dirty)),
    folds: 0, projection: 'request cleanup and guide-only projection; store, model, and network excluded' },
  outputBytes: Buffer.byteLength(JSON.stringify(expected)),
  roundsPerSide: rounds,
  correctness: profileOnly ? 'not checked in profile-only mode'
    : 'guide-only outputs and all four protocol fold projections deep-equal; inputs unchanged; copy-on-write sharing checked; cached request measurements equal repeated serialization',
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  legacy: summary(samples.legacy),
  optimized: summary(samples.optimized),
  spanProjections,
  limiter: 'synthetic projection and measurement paths; guide-only preparation uses Chat; folding projection covers all four protocols; no complete hook, store, network, or model call',
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, json, 'utf8');
console.log(json.trimEnd());
