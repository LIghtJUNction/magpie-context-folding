import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onRequest } from '../src/context.hooks.js';

type Strategy = 'no-fold' | 'milestone-only' | 'one-shot-total' | 'hierarchical';
const MILESTONES = 4;
const CONCLUSION = 'Task conclusion: all four milestones are verified; begin the next task.';
const DETAIL = (milestone: number) =>
  (`里程碑 ${milestone} 已完成的证据和推导，可供之后精确回查。编号 ${milestone}；` + 'recorded-result-1234567890.\n').repeat(360);

function commonPrefixBytes(left: Buffer, right: Buffer): number {
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left[i] === right[i]) i++;
  return i;
}

async function runStrategy(strategy: Strategy) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-fold-strategy-'));
  const previousState = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = join(directory, 'state');
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  await mkdir(join(directory, '.git'));

  const context = {
    protocol: 'chat', model: 'fold-strategy-benchmark', session: 'same-task',
    origin: 'local-benchmark', agent: 'scripted', cwd: directory, state: {},
    options: { delayRequests: 1, minSavingsTokens: 256 },
  };
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: 'Preserve the task conclusion and current status.' },
    { role: 'user', content: 'Complete four independent milestones, retain the result, then begin the next round.' },
    { role: 'assistant', content: 'Task status: four milestones are planned; no result is verified yet.' },
  ];
  if (strategy === 'one-shot-total' || strategy === 'hierarchical') {
    messages[2]!.content += '\n<!-- @context-fold begin total-task -->';
  }

  const tools = [{ type: 'function', function: { name: 'exec_command', description: 'Run a local command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
  const turns: Record<string, unknown>[] = [];
  let previous: Buffer | undefined;
  let previousMessages: Buffer | undefined;
  try {
    const project = async (label: string) => {
      const body = { model: 'fold-strategy-benchmark', tools, messages: structuredClone(messages) };
      const projected = await onRequest(body, context) as Record<string, unknown>;
      const wire = Buffer.from(JSON.stringify(projected), 'utf8');
      const projectedMessages = Array.isArray(projected.messages) ? projected.messages as Record<string, unknown>[] : [];
      const messageBytes = Buffer.from(JSON.stringify(projectedMessages), 'utf8');
      const priorWirePrefix = previous ? commonPrefixBytes(previous, wire) : null;
      const priorMessagePrefix = previousMessages ? commonPrefixBytes(previousMessages, messageBytes) : null;
      const assistantText = projectedMessages.filter(message => message.role === 'assistant')
        .map(message => typeof message.content === 'string' ? message.content : '').join('\n');
      const folds = assistantText.match(/\[\[cf:v2:[a-f0-9]+\]\]/g)?.length ?? 0;
      turns.push({
        label,
        requestBytes: wire.length,
        promptMessageBytes: messageBytes.length,
        foldedReferences: folds,
        commonWirePrefixBytes: priorWirePrefix,
        invalidatedPreviousWireBytes: previous && priorWirePrefix !== null ? previous.length - priorWirePrefix : null,
        wirePrefixReuseRatio: previous && priorWirePrefix !== null ? Number((priorWirePrefix / previous.length).toFixed(4)) : null,
        commonPromptMessagePrefixBytes: priorMessagePrefix,
        invalidatedPreviousPromptMessageBytes: previousMessages && priorMessagePrefix !== null
          ? previousMessages.length - priorMessagePrefix : null,
        promptMessagePrefixReuseRatio: previousMessages && priorMessagePrefix !== null
          ? Number((priorMessagePrefix / previousMessages.length).toFixed(4)) : null,
        conclusionVisible: assistantText.includes(CONCLUSION),
      });
      previous = wire;
      previousMessages = messageBytes;
    };

    await project('task-open');
    for (let milestone = 1; milestone <= MILESTONES; milestone++) {
      const summary = `Milestone ${milestone}: verified checkpoint; next step is milestone ${milestone + 1}.`;
      const detail = DETAIL(milestone);
      const text = strategy === 'milestone-only' || strategy === 'hierarchical'
        ? `${summary}\n<!-- @context-fold begin milestone-${milestone}-details -->\n${detail}\n<!-- @context-fold end milestone-${milestone}-details -->`
        : `${summary}\n${detail}`;
      messages.push({ role: 'assistant', content: text });
      await project(`milestone-${milestone}`);
    }

    if (strategy === 'one-shot-total' || strategy === 'hierarchical') {
      messages.push({ role: 'assistant', content: '<!-- @context-fold end total-task -->' });
    }
    messages.push({ role: 'assistant', content: CONCLUSION });
    await project('task-conclusion');
    messages.push({ role: 'user', content: 'Start the next round.' });
    await project('next-round');

    const turn = (label: string) => turns.find(item => item.label === label)!;
    assert.ok(turn('task-conclusion').conclusionVisible && turn('next-round').conclusionVisible,
      `${strategy} must retain the task conclusion outside every folded region`);
    if (strategy === 'no-fold') {
      assert.ok(turns.every(item => item.foldedReferences === 0), 'no-fold control unexpectedly folded text');
    } else if (strategy === 'milestone-only') {
      assert.equal(turn('milestone-2').foldedReferences, 1, 'milestones should fold after the delay');
      assert.equal(turn('task-conclusion').foldedReferences, MILESTONES);
    } else if (strategy === 'one-shot-total') {
      assert.equal(turn('task-conclusion').foldedReferences, 0, 'total block must wait one request cycle');
      assert.ok(Number(turn('next-round').foldedReferences) > 0, 'closed total block did not fold');
    } else {
      assert.equal(turn('milestone-2').foldedReferences, 1, 'first child region did not fold while parent remained open');
      assert.equal(turn('milestone-4').foldedReferences, MILESTONES - 1);
      assert.ok(Number(turn('next-round').foldedReferences) > 0, 'closed parent region did not fold');
    }

    const transitions = turns.slice(1);
    const wireBytesInvalidated = transitions.reduce((sum, turn) =>
      sum + Number(turn.invalidatedPreviousWireBytes ?? 0), 0);
    const promptBytesInvalidated = transitions.reduce((sum, turn) =>
      sum + Number(turn.invalidatedPreviousPromptMessageBytes ?? 0), 0);
    const sentBytes = turns.reduce((sum, turn) => sum + Number(turn.requestBytes), 0);
    const meanWirePrefixReuse = transitions.length
      ? transitions.reduce((sum, turn) => sum + Number(turn.wirePrefixReuseRatio ?? 0), 0) / transitions.length : 0;
    const meanPromptMessagePrefixReuse = transitions.length
      ? transitions.reduce((sum, turn) => sum + Number(turn.promptMessagePrefixReuseRatio ?? 0), 0) / transitions.length : 0;
    return {
      strategy,
      milestones: MILESTONES,
      requestCount: turns.length,
      sentBytes,
      cumulativeInvalidatedPreviousWireBytes: wireBytesInvalidated,
      meanWirePrefixReuseRatio: Number(meanWirePrefixReuse.toFixed(4)),
      cumulativeInvalidatedPreviousPromptMessageBytes: promptBytesInvalidated,
      meanPromptMessagePrefixReuseRatio: Number(meanPromptMessagePrefixReuse.toFixed(4)),
      turns,
    };
  } finally {
    if (previousState === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
}

const results = [];
for (const strategy of ['no-fold', 'milestone-only', 'one-shot-total', 'hierarchical'] as const) {
  results.push(await runStrategy(strategy));
}
const report = {
  benchmark: 'synthetic-multi-milestone-request-prefix-replay',
  completedAt: new Date().toISOString(),
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
  sourceRevision: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFilesSha256: Object.fromEntries(await Promise.all([
    ...(await readdir('src')).filter(path => path.endsWith('.ts')).map(path => `src/${path}`),
    'scripts/fold-strategy-benchmark.ts',
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  delayRequests: 1,
  minSavingsTokens: 256,
  requestPrefixMetric: 'common UTF-8 byte prefix between consecutive projected message arrays; a cache proxy, not provider cached tokens',
  note: 'Uses the production onRequest hook and synthetic history; no model or provider cache is called.',
  results,
};
const outputPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
