/** Reproducible local workload. Accounting here is explicitly synthetic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cpus, loadavg } from 'node:os';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { Store } from '../src/store.js';
import type { Entry } from '../src/store.js';
import { extractSpans } from '../src/protocol.js';
import { z } from 'zod';

const outputPath = resolve(process.argv[2] ?? '/tmp/magpie-context-folding-benchmark.json');
const directory = await mkdtemp(join(tmpdir(), 'context-folding-bench-'));
const previousDirectory = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
const server = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += String(chunk);
  const body = JSON.parse(input);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    requestHash: body.requestHash, model: body.model, protocol: body.protocol,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    beforeLowerTokens: JSON.stringify(body.before).length,
    afterUpperTokens: JSON.stringify(body.after).length,
    oldMinPricePerMillion: 1, newMaxPricePerMillion: 1, extraCostUpperUsd: 0,
    assumptions: ['SYNTHETIC ONLY: serialized UTF-16 character = one charged token, all input rates = $1/M.'],
  }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
const sampleStats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
};
const recordSchema = z.record(z.string(), z.unknown());
function renderPrompt(body: unknown): string {
  const object = recordSchema.parse(body);
  const messages = z.array(z.object({ role: z.string(), content: z.string() })).parse(object.messages);
  return messages.map(message => `<${message.role}>\n${message.content}\n</${message.role}>`).join('\n')
    + '\n<assistant>\n';
}

try {
  const lineCount = z.coerce.number().int().min(1).max(5000).parse(process.argv[3] ?? 65);
  const original = Array.from({ length: lineCount }, (_, index) =>
    `Step ${index}: the worker inspected the selected module and checked its inputs. The local checks passed and the recorded result was complete.\n`).join('');
  const body = { model: 'synthetic', stream: false,
    tools: [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: 'Read the historical work. Reply with one short word.' },
      { role: 'user', content: 'Inspect the modules and report the final outcome.' },
      { role: 'assistant', content: original },
      { role: 'user', content: 'All work is done. Reply OK.' },
    ],
  };
  const context = { protocol: 'chat', model: 'synthetic', session: 'benchmark',
    options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 32, accounting: { url } } };
  const store = new Store(directory);
  await onRequest(body, context);
  const scope = await store.scopeFor(JSON.stringify(['benchmark', '', '', '']));
  const id = extractSpans(body, 'chat').find(span => span.text === original)?.id;
  assert.ok(id);
  const stages: Record<string, unknown>[] = [];
  const prompts: { label: string; text: string; markOutputText?: string }[] = [{ label: 'original', text: renderPrompt(body) }];
  const summarySeed = 'All selected modules passed the local input and output checks; no unresolved failures remain. ';
  const summaries = [summarySeed.repeat(30).slice(0, 2000), summarySeed.repeat(20).slice(0, 1000), 'All checks passed.'];
  let outgoing: unknown;
  for (let index = 0; index < summaries.length; index++) {
    const summary = summaries[index];
    assert.ok(summary);
    const markArguments = { scope, action: 'mark', marks: [{ id, disposition: 'foldable', summary }] };
    const marked = JSON.parse(await execute(markArguments));
    assert.ok(!marked.error);
    const start = performance.now();
    outgoing = await onRequest(body, context);
    const hookMs = performance.now() - start;
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
    const entry: Entry | undefined = state.entries.find(item => item.id === id);
    assert.equal(entry?.layers.length, index + 1, `recursive level ${index + 1} did not pass gate`);
    prompts.push({ label: `fold_${index + 1}`, text: renderPrompt(outgoing), markOutputText: JSON.stringify(markArguments) });
    stages.push({ label: `fold_${index + 1}`, hookMs, requestBytes: Buffer.byteLength(JSON.stringify(outgoing)), decision: state.decision });
  }
  const beforeRepeatBytes = (await stat(join(directory, 'state.sqlite'))).size;
  const baselineTimes: number[] = [];
  const foldedTimes: number[] = [];
  const foldedCpuTimes: number[] = [];
  // Warmups excluded; alternate direction to avoid always favoring one side.
  for (let index = -3; index < 9; index++) {
    const a = () => {
      const start = performance.now();
      const clone = structuredClone(body);
      assert.equal(clone.messages[2]?.content, original);
      if (index >= 0) baselineTimes.push(performance.now() - start);
    };
    const b = async () => {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const replayed = await onRequest(body, context);
      const elapsed = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      assert.equal(renderPrompt(replayed), prompts.at(-1)?.text);
      if (index >= 0) { foldedTimes.push(elapsed); foldedCpuTimes.push((cpu.user + cpu.system) / 1000); }
    };
    if (index % 2 === 0) { a(); await b(); } else { await b(); a(); }
  }
  const state = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
  const entry = state.entries.find(entry => entry.id === id);
  assert.ok(entry);
  assert.equal(entry.layers.length, 3);
  let next = entry.layers.at(-1)?.id ?? 'original';
  const traversed: string[] = [];
  while (next !== 'original') {
    const layer = JSON.parse(await execute({ scope, action: 'read', id, layer: next }));
    assert.ok(!layer.error);
    traversed.push(next);
    next = layer.previousId;
  }
  assert.equal(traversed.length, 3);
  let restored = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const page = JSON.parse(await execute({ scope, action: 'read', id, offset, limit: 24000 }));
    restored += page.text;
    offset = page.nextOffset;
  }
  assert.equal(restored, original);
  const afterRepeatBytes = (await stat(join(directory, 'state.sqlite'))).size;
  const files = await readdir(directory);
  assert.deepEqual(files, ['state.sqlite']);
  await execute({ scope, action: 'mark', marks: [{ id, disposition: 'keep' }] });
  await execute({ scope, action: 'forget' });
  const afterForgetBytes = (await stat(join(directory, 'state.sqlite'))).size;
  await writeFile(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(), runtime: process.versions.bun,
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, loadAverage: loadavg() },
    billing: 'SYNTHETIC_ACCOUNTING_ONLY', prompts, stages,
    measurements: { baselineCloneMs: sampleStats(baselineTimes), warmFoldedHookMs: sampleStats(foldedTimes),
      warmFoldedHookCpuMs: sampleStats(foldedCpuTimes) },
    storage: { files, beforeRepeatBytes, afterRepeatBytes, afterForgetBytes, recursiveLayers: traversed.length },
    errors: 0,
  }, null, 2));
  console.log(JSON.stringify({ result: 'passed', outputPath, recursiveLayers: traversed.length,
    promptBytes: prompts.map(prompt => ({ label: prompt.label, bytes: Buffer.byteLength(prompt.text) })),
    hook: sampleStats(foldedTimes), storage: { beforeRepeatBytes, afterRepeatBytes, afterForgetBytes }, errors: 0 }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousDirectory === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
}
