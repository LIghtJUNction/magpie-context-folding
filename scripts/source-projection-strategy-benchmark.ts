import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGuidanceToCleanBody, defaultRecoveryCommand } from '../src/guidance.js';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { Store, digest } from '../src/store.js';
import { focusedSourceExcerpt } from '../src/source-excerpt.js';
import { execute } from '../src/tool.js';

const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];
const question = 'What does operation238() return?';
const source = `const BASE_OFFSET = 17;\n${Array.from({ length: 2_400 }, (_, index) =>
  `export function operation${index}() { return ${1_000_000 + index}${index === 238 ? ' + BASE_OFFSET' : ''}; }`).join('\n')}`;
const sourceHash = digest(source);
const reference = `[[cf:v2:${sourceHash.slice(0, 12)}]]`;

function bodyFor(protocol: Protocol, userQuestion = question): Record<string, unknown> {
  const id = 'read-1';
  const args = { path: 'worker.ts' };
  if (protocol === 'chat') return {
    model: 'fixture', tools: [{ type: 'function', function: { name: 'exec_command' } }],
    messages: [{ role: 'system', content: 'Original requirements.' }, { role: 'user', content: userQuestion },
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: id, content: source }],
  };
  if (protocol === 'responses') return {
    model: 'fixture', instructions: 'Original requirements.', tools: [{ type: 'function', name: 'exec_command' }],
    input: [{ role: 'user', content: userQuestion },
      { type: 'function_call', call_id: id, name: 'read', arguments: JSON.stringify(args) },
      { type: 'function_call_output', call_id: id, output: source }],
  };
  if (protocol === 'anthropic') return {
    model: 'fixture', system: [{ type: 'text', text: 'Original requirements.' }],
    tools: [{ name: 'exec_command', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: userQuestion },
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: args }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: source }] }],
  };
  return {
    model: 'fixture', systemInstruction: { parts: [{ text: 'Original requirements.' }] },
    tools: [{ functionDeclarations: [{ name: 'exec_command' }] }],
    contents: [{ role: 'user', parts: [{ text: userQuestion }] },
      { role: 'model', parts: [{ functionCall: { id, name: 'read', args } }] },
      { role: 'user', parts: [{ functionResponse: { id, name: 'read', response: { output: source } } }] }],
  };
}

function history(body: Record<string, unknown>, protocol: Protocol): unknown[] {
  return (protocol === 'responses' ? body.input : protocol === 'gemini' ? body.contents : body.messages) as unknown[];
}

function replaceSpan(body: Record<string, unknown>, path: readonly (string | number)[], value: string): void {
  let parent: unknown = body;
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key]!;
  (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
}

async function withScope<T>(protocol: Protocol, run: (input: {
  directory: string; store: Store; scope: string; context: Record<string, unknown>;
}) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-source-projection-'));
  const previousState = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  await mkdir(join(directory, '.git'));
  const store = new Store();
  const context = { protocol, model: 'fixture', session: `source-projection-${protocol}`, cwd: directory,
    options: { delayRequests: 0 }, state: {} };
  const scope = await store.scopeFor(JSON.stringify([context.session, '', '', directory]));
  try { return await run({ directory, store, scope, context }); }
  finally {
    if (previousState === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
}

const languageCases: Array<[string, string, string, string, [number, number]]> = [
  ['worker.ts', 'export function operation238(value: number): { answer: number } {\n  const callback = () => ({ answer: value + 17 });\n  const text = `value } ${value}`;\n  return { answer: callback().answer, text: text + " #317" };\n}\nexport function helper() { return 8; }\n', 'operation238', 'text + " #317"', [1, 5]],
  ['worker.js', 'class Worker {\n  async operation238(value) {\n    const text = "brace } remains data";\n    if (value > 0) { return text + " #317"; }\n    return "fallback";\n  }\n}\n', 'operation238', 'text + " #317"', [2, 6]],
  ['worker.py', 'example = """\ndef operation238(): return -1\n"""\n@cache\ndef operation238(value):\n    note = "#317"\n    if value:\n        return note\n    return "fallback"\n\ndef helper():\n    return 8\n', 'operation238', 'return note', [4, 9]],
  ['worker.go', 'func (w *Worker) operation238(value int) map[string]int {\n  return map[string]int{"answer": value + 317}\n}\n', 'operation238', 'value + 317', [1, 3]],
  ['worker.rs', 'pub fn operation238(value: i32) -> i32 {\n  let transform = |x| { x + 317 };\n  transform(value)\n}\n', 'operation238', 'x + 317', [1, 4]],
  ['Worker.java', 'class Worker {\n  public int operation238(int value) {\n    if (value > 0) { return value + 317; }\n    return 0;\n  }\n}\n', 'operation238', 'value + 317', [2, 5]],
  ['worker.kt', 'class Worker {\n  fun operation238(value: Int): Int {\n    return value + 317\n  }\n}\n', 'operation238', 'value + 317', [2, 4]],
  ['worker.cpp', 'class Worker {\n  int operation238(int value) {\n    auto inner = [](int x) { return x + 317; };\n    return inner(value);\n  }\n};\n', 'operation238', 'x + 317', [2, 5]],
  ['worker.ts', 'const operation238 = (value: number): number => {\n  return value + 317;\n};\n', 'operation238', 'value + 317', [1, 3]],
  ['worker.ts', 'export function operation238(value: string) {\n  const text = `value=${/}/.test(value) ? 1 : 0}`;\n  return text;\n}\nexport function helper() { return 8; }\n', 'operation238', 'return text', [1, 4]],
  ['worker.js', 'function operation238(value) {\n  if (value) /}/.test(value);\n  return value;\n}\nfunction helper() { return 8; }\n', 'operation238', 'return value', [1, 4]],
  ['worker.ts', 'export function operation238<T extends { value: number }>(input: T): number {\n  const value = input.value;\n  return value + 317;\n}\nexport function helper() { return 8; }\n', 'operation238', 'value + 317', [1, 4]],
  ['worker.py', '@cache\nasync def operation238(value):\n    return value + 317\n\ndef helper():\n    return 8\n', 'operation238', 'value + 317', [1, 3]],
  ['worker.c', 'int helper(int value) { return value; }\nint operation238(int value) {\n  if (value > 0) { return value + 317; }\n  return 0;\n}\n', 'operation238', 'value + 317', [2, 5]],
  ['worker.cpp', 'template <typename T>\nT operation238(T value) {\n  return value;\n}\nint helper() { return 8; }\n', 'operation238', 'return value;', [1, 4]],
];

async function main() {
  const languageResults = languageCases.map(([path, text, name, expected, expectedLines]) => {
    const excerpt = focusedSourceExcerpt(text, path, name);
    const localReference = `[[cf:v2:${digest(text).slice(0, 12)}]]`;
    const expectedExcerpt = text.split('\n').slice(expectedLines[0] - 1, expectedLines[1]).join('\n') + '\n';
    return { path, sourceBytes: Buffer.byteLength(text), referenceJsonBytes: Buffer.byteLength(JSON.stringify(localReference)),
      referenceWithExcerptJsonBytes: excerpt ? Buffer.byteLength(JSON.stringify(`${localReference}\n${excerpt.text}`)) : null,
      lines: excerpt ? [excerpt.startLine, excerpt.endLine] : null,
      expectedCodeRetained: !!excerpt && excerpt.text.includes(expected),
      exactExpectedScope: !!excerpt && excerpt.startLine === expectedLines[0] && excerpt.endLine === expectedLines[1]
        && excerpt.text === expectedExcerpt };
  });
  const misses = languageResults.filter(result => !result.expectedCodeRetained || !result.exactExpectedScope).map(result => result.path);
  if (misses.length) throw new Error(`Focused source excerpt missed: ${misses.join(', ')}`);

  const cpuSamples: number[] = [];
  for (let sample = 0; sample < 36; sample++) {
    const start = performance.now();
    const excerpt = focusedSourceExcerpt(source, 'worker.ts', 'operation238');
    if (!excerpt?.text.includes('return 1000238')) throw new Error('Generated target function was not retained');
    if (sample >= 5) cpuSamples.push(performance.now() - start);
  }
  cpuSamples.sort((left, right) => left - right);
  const parameterShadowSource = 'const BASE_OFFSET = 17;\nexport function localValue(BASE_OFFSET: number) { return BASE_OFFSET; }\n';
  const localShadowSource = 'const BASE_OFFSET = 17;\nexport function localValue() { const BASE_OFFSET = 4; return BASE_OFFSET; }\n';
  const mutableGlobalSource = 'let BASE_OFFSET = 17;\nexport function localValue() { return BASE_OFFSET; }\n';
  const parameterShadow = focusedSourceExcerpt(parameterShadowSource, 'shadow.ts', 'localValue');
  const localShadow = focusedSourceExcerpt(localShadowSource, 'shadow.ts', 'localValue');
  const mutableGlobal = focusedSourceExcerpt(mutableGlobalSource, 'mutable.ts', 'localValue');
  const localShadowsExcluded = !parameterShadow?.dependencies?.some(item => item.name === 'BASE_OFFSET')
    && !localShadow?.dependencies?.some(item => item.name === 'BASE_OFFSET');
  const mutableGlobalExcluded = !mutableGlobal?.dependencies?.some(item => item.name === 'BASE_OFFSET');
  if (!localShadowsExcluded || !mutableGlobalExcluded) {
    throw new Error('A shadowed or mutable BASE_OFFSET must not be added as a literal dependency');
  }

  const protocolResults: Array<Record<string, boolean | number | string>> = [];
  for (const protocol of protocols) await withScope(protocol, async ({ directory, store, scope, context }) => {
    const input = bodyFor(protocol);
    const sourceSpan = extractSpans(input, protocol).find(span => span.role === 'tool' && span.source?.range === 'full');
    if (!sourceSpan) throw new Error(`No full source span detected for ${protocol}`);
    const command = defaultRecoveryCommand();
    const guidanceOptions = { command, minSavingsTokens: 256, scope, stateDirectory: store.directory };
    const fullWithGuidance = appendGuidanceToCleanBody(structuredClone(input), protocol, guidanceOptions);
    const referenceOnlyInput = structuredClone(input);
    replaceSpan(referenceOnlyInput, sourceSpan.path, reference);
    const referenceWithGuidance = appendGuidanceToCleanBody(referenceOnlyInput, protocol, guidanceOptions);
    const focused = await onRequest(input, context) as Record<string, unknown>;
    const focusedSpan = extractSpans(focused, protocol).find(span => span.role === 'tool');
    const grepResult = await execute({ action: 'grep', scope, id: sourceHash.slice(0, 12), query: 'operation238', limit: 1 });
    const dependencyResult = await execute({ action: 'grep', scope, id: sourceHash.slice(0, 12), query: 'BASE_OFFSET', limit: 1 });
    const snapshot = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    const archived = snapshot.entries.find(entry => entry.annotation?.sha256 === sourceHash);
    const prefixUnchanged = JSON.stringify(history(input, protocol).slice(0, sourceSpan.messageIndex))
      === JSON.stringify(history(focused, protocol).slice(0, sourceSpan.messageIndex));
    const result = {
      protocol, fullSourceJsonBytes: Buffer.byteLength(JSON.stringify(source)), referenceOnlyJsonBytes: Buffer.byteLength(JSON.stringify(reference)),
      focusedValueJsonBytes: Buffer.byteLength(JSON.stringify(focusedSpan?.text ?? '')),
      fullRequestBytesWithGuidance: Buffer.byteLength(JSON.stringify(fullWithGuidance)),
      referenceOnlyRequestBytesWithGuidance: Buffer.byteLength(JSON.stringify(referenceWithGuidance)),
      focusedRequestBytes: Buffer.byteLength(JSON.stringify(focused)),
      targetCodeRetained: !!focusedSpan?.text.includes('operation238() { return 1000238 + BASE_OFFSET; }'),
      dependencyDefinitionIncluded: !!focusedSpan?.text.includes('const BASE_OFFSET = 17;'),
      archiveExact: archived?.text === source, oneSearchRecoversTarget: grepResult.includes('operation238() { return 1000238 + BASE_OFFSET; }'),
      dependencySearchFindsDefinition: dependencyResult.includes('const BASE_OFFSET = 17;'),
      dependencyRecoveryPrompt: !!focusedSpan?.text.includes('Search archive for referenced names not shown.'),
      prefixBeforeSourceUnchanged: prefixUnchanged,
      globalGuidanceInjected: JSON.stringify(focused).includes('<context-folding>'),
      estimatedInputTokenProxy: Math.ceil(Buffer.byteLength(JSON.stringify(focused)) / 4),
      ambiguousQueriesRetainFullSource: false,
    };
    if (!result.targetCodeRetained || !result.dependencyDefinitionIncluded || !result.archiveExact || !result.oneSearchRecoversTarget
      || !result.dependencySearchFindsDefinition || !result.dependencyRecoveryPrompt
      || !result.prefixBeforeSourceUnchanged || result.globalGuidanceInjected) {
      throw new Error(`Focused projection invariant failed for ${protocol}: ${JSON.stringify(result)}`);
    }
    for (const query of ['Compare operation238() and operation237().', 'Compare operation238() with `operation237`.']) {
      const ambiguousInput = bodyFor(protocol, query);
      const ambiguous = await onRequest(ambiguousInput, context) as Record<string, unknown>;
      const ambiguousSpan = extractSpans(ambiguous, protocol).find(span => span.role === 'tool');
      if (ambiguousSpan?.text !== source || ambiguousSpan.text.includes('[[cf:')) {
        throw new Error(`Ambiguous symbol query did not retain the full source for ${protocol}: ${query}`);
      }
    }
    result.ambiguousQueriesRetainFullSource = true;
    protocolResults.push(result);
  });

  console.log(JSON.stringify({
    measuredAt: '2026-10-30',
    kind: 'local synthetic request projection; no Provider calls',
    task: question,
    source: { path: 'worker.ts', bytes: Buffer.byteLength(source), sha256: sourceHash,
      generatedFunctionCount: 2_400, reference: reference },
    dependencyChecks: { fileLevelLiteralIncluded: protocolResults.every(result => result.dependencyDefinitionIncluded),
      shadowedParameterAndLocalExcluded: localShadowsExcluded,
      mutableFileLevelValueExcluded: mutableGlobalExcluded },
    strategies: {
      fullSource: 'Keep complete tool result; baseline is measured with ordinary scoped recovery guidance.',
      referenceOnly: 'Replace tool result with archive reference; guidance stays in the global system/instructions field.',
      referencePlusExcerpt: 'Replace tool result with reference, exact target function and a local recovery command.' },
    protocolResults,
    focusedParserTiming: { warmupSamples: 5, measuredSamples: cpuSamples.length,
      medianMs: Number(cpuSamples[Math.floor(cpuSamples.length / 2)]!.toFixed(3)),
      minMs: Number(cpuSamples[0]!.toFixed(3)), maxMs: Number(cpuSamples.at(-1)!.toFixed(3)) },
    languageCases: languageResults,
    limitations: ['Synthetic source and explicit function lookup only.', 'Byte/4 is a size proxy, not provider tokenization or billing.',
      'Correct model answers, recovery-call avoidance, cache usage and dollars were not measured.'],
  }, null, 2));
}

await main();
