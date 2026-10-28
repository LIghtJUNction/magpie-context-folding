import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyMetrics } from '../src/metrics.js';
import { digest, type Snapshot } from '../src/store.js';
import type * as Tree from '../src/tree.js';

const root = dirname(import.meta.dir);
const sourcePath = join(root, 'src/tree.ts');
const before = execFileSync('git', ['show', 'HEAD:src/tree.ts'], { cwd: root, encoding: 'utf8' });
const after = await readFile(sourcePath, 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const directory = await mkdtemp(join(tmpdir(), 'magpie-tree-benchmark-'));
try {
  const load = async (name: string, source: string): Promise<typeof Tree> => {
    const rewritten = source.replace(/from '\.\/(annotations|store)\.js'/g,
      (_, module: string) => `from '${pathToFileURL(join(root, 'src', module + '.ts')).href}'`);
    const path = join(directory, `${name}.ts`);
    await writeFile(path, rewritten);
    return import(pathToFileURL(path).href);
  };
  const versions = { before: await load('before', before), after: await load('after', after) };
  const count = 3000;
  const state: Snapshot = { version: 1, entries: Array.from({ length: count }, (_, index) => ({
    id: String(index), role: 'assistant', text: 'archived evidence ' + index,
    mark: { disposition: 'unmarked' }, layers: [], annotation: { sha256: digest(String(index)), label: 'leaf' },
  })), decision: {}, metrics: emptyMetrics() };
  const scenarios = {
    browse: (tree: typeof Tree) => tree.browse(state, { query: 'absent', recursive: true }),
    grep: (tree: typeof Tree) => tree.grep(state, { query: 'absent' }),
  };
  const results: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(scenarios)) {
    const expected = run(versions.before);
    assert.deepEqual(run(versions.after), expected);
    const samples = { before: [] as number[], after: [] as number[] };
    for (let round = 0; round < 5; round++) {
      const order = round % 2 === 0 ? ['before', 'after'] as const : ['after', 'before'] as const;
      for (const version of order) {
        const start = performance.now();
        const result = run(versions[version]);
        samples[version].push(performance.now() - start);
        assert.deepEqual(result, expected);
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[2];
    results[name] = { beforeMs: samples.before, afterMs: samples.after,
      beforeMedianMs: median(samples.before), afterMedianMs: median(samples.after) };
  }
  console.log(JSON.stringify({ fixture: { entries: count, query: 'absent', description: 'annotated leaf nodes, no matches' },
    limitations: 'In-process Bun microbenchmark; excludes store I/O, model calls, nested nodes and matching result pages.',
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    sources: { headCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      beforeSha256: sha256(before), afterSha256: sha256(after) }, rounds: 5, results }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
