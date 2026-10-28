import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextFoldingClient, ContextFoldingError } from '../dist/src/index.js';

const fake = `import json, os, sys, time
for line in sys.stdin:
    request = json.loads(line)
    action = request['action']
    if action == 'slow': time.sleep(0.3)
    if action == 'hang': time.sleep(30)
    if action == 'exit': sys.exit(7)
    if action == 'bad':
        print('not json', flush=True)
        continue
    if action == 'large':
        print('x' * 5000, flush=True)
        continue
    if action == 'stderr':
        sys.stderr.write('diagnostic' * 100000)
        sys.stderr.flush()
    if action == 'error':
        print(json.dumps({'error': {'code': 'missing', 'message': 'No such item'}}), flush=True)
        continue
    print(json.dumps({'result': {'request': request, 'pid': os.getpid(), 'argv': sys.argv[1:]}}), flush=True)
`;

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cf-ts-bridge-'));
  const script = join(directory, 'fake.py');
  await writeFile(script, fake);
  const client = new ContextFoldingClient({ statePath: join(directory, 'state with spaces.sqlite'), pythonArguments: ['-u', script], ...options });
  try { await run(client); }
  finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test('persistent process serializes concurrent calls and forwards wrappers and Unicode', async () => {
  await fixture(async client => {
    const requests = [
      client.put('scope', '原文🙂', { role: 'tool', action: 'wrong', scope: 'wrong' }),
      client.list('scope', { depth: 2 }),
      client.read('scope', 'entry', { offset: 3 }),
      client.call({ action: 'read-source', scope: 'scope', text: '# source', occurrence: 'read-1', requestCycle: 0 }),
      client.render('scope', ['entry'], { protected: [] }),
      client.resolve('scope', { content: '[[cf:v1:entry]]' }),
      client.fold('scope', '', { action: 'wrong', scope: 'wrong', text: 'wrong', language: 'explicit', commentStyles: [{ start: ';;' }] }),
      client.grep('scope', 'needle', { query: 'wrong', id: 'entry', limit: 2 }),
      client.meta('scope', 'entry', { id: 'wrong', limit: 2 }),
    ];
    const values = await Promise.all(requests);
    assert.equal(new Set(values.map(value => value.pid)).size, 1);
    assert.deepEqual(values.map(value => value.request.action), ['put', 'list', 'read', 'read-source', 'render', 'resolve', 'fold', 'grep', 'meta']);
    assert.equal(values[0].request.text, '原文🙂');
    assert.equal(values[0].request.scope, 'scope');
    assert.equal(values[0].argv[0], '--state');
    assert.ok(values[0].argv[1].endsWith('state with spaces.sqlite'));
    assert.deepEqual(values[5].request.value, { content: '[[cf:v1:entry]]' });
    assert.deepEqual(values[6].request, { action: 'fold', scope: 'scope', text: '', language: 'explicit', commentStyles: [{ start: ';;' }] });
    assert.deepEqual(values[7].request, { action: 'grep', scope: 'scope', query: 'needle', id: 'entry', limit: 2 });
    assert.deepEqual(values[8].request, { action: 'meta', scope: 'scope', id: 'entry', limit: 2 });
  });
});

test('application errors preserve the connection and stderr cannot block responses', async () => {
  await fixture(async client => {
    await assert.rejects(client.call({ action: 'error', scope: 's' }), error => error instanceof ContextFoldingError && error.code === 'missing');
    assert.equal((await client.call({ action: 'stderr', scope: 's' })).request.action, 'stderr');
    assert.equal((await client.list('s')).request.action, 'list');
  });
});

test('queued cancellation leaves stream usable, active cancellation terminates it', async () => {
  await fixture(async client => {
    const first = client.call({ action: 'slow', scope: 's' });
    const queued = new AbortController();
    const second = client.list('s', {}, queued.signal);
    queued.abort();
    await assert.rejects(second, error => error.code === 'cancelled');
    await first;
    assert.equal((await client.list('s')).request.action, 'list');
    const active = new AbortController();
    const hanging = client.call({ action: 'hang', scope: 's' }, active.signal);
    const timer = setTimeout(() => active.abort(), 30);
    try { await assert.rejects(hanging, error => error.code === 'cancelled'); }
    finally { clearTimeout(timer); }
    await assert.rejects(client.list('s'), error => error.code === 'cancelled');
  });
});

test('invalid JSON, oversize output, process exit and missing executables reject promptly', async () => {
  for (const action of ['bad', 'large', 'exit']) {
    await fixture(async client => {
      await assert.rejects(client.call({ action, scope: 's' }), error => ['protocol', 'transport'].includes(error.code));
      await assert.rejects(client.list('s'));
    }, { maxResponseBytes: 1024 });
  }
  const client = new ContextFoldingClient({ statePath: ':memory:', pythonExecutable: '/no-such-context-folding-python' });
  try { await assert.rejects(client.list('s'), error => error.code === 'transport'); }
  finally { await client.dispose(); }
});

test('installed Python core delays source annotations and queries leave folding unchanged', { skip: !process.env.CONTEXT_FOLDING_REAL_CORE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-ts-real-'));
  const client = new ContextFoldingClient({ statePath: join(directory, 'archive.sqlite'),
    env: { PYTHONPATH: process.env.CONTEXT_FOLDING_REAL_CORE_PATH } });
  try {
    const text = '# @context-fold begin evidence\n' + '# 原文🙂 evidence\n'.repeat(80) + '# @context-fold end evidence\n';
    const request = { action: 'read-source', scope: 'real', text, language: 'python', occurrence: 'read-1' };
    const first = await client.call({ ...request, requestCycle: 0 });
    assert.equal(first.text, text);
    assert.equal((await client.call({ ...request, requestCycle: 0 })).text, text, 'retry must not consume delay');
    const folded = await client.call({ ...request, requestCycle: 1 });
    assert.match(folded.text, /\[\[cf:v2:[a-f0-9]{12,64}\]\]/);
    assert.equal((await client.call({ ...request, occurrence: 'read-2', requestCycle: 2 })).text, text, 'new read gets its own delay');
    const resolved = await client.resolve('real', { content: folded.text });
    assert.equal(resolved.value.content, text);
    assert.ok(Array.from((await client.read('real', first.id, { limit: 120 })).text).length <= 120);
    await client.grep('real', 'evidence', { id: first.id, limit: 2 });
    await client.meta('real', first.id);
    assert.equal((await client.call({ ...request, requestCycle: 3 })).text, folded.text, 'queries must not set keep or unfold history');
    const item = await client.put('real', 'A🙂B', { role: 'tool' });
    const read = await client.read('real', item.id, { offset: 1, limit: 1 });
    assert.equal(read.text, '🙂');
    assert.equal(read.nextOffset, 2);
    const legacy = await client.resolve('real', { content: item.reference });
    assert.equal(legacy.value.content, 'A🙂B');
    await assert.rejects(client.call({ action: 'mark', scope: 'real', id: first.id,
      disposition: 'foldable', summary: 'obsolete' }), error => error instanceof ContextFoldingError);
    assert.ok(await client.list('real'));
  } finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('installed Python core folds submitted text immediately and returns recoverable references', { skip: !process.env.CONTEXT_FOLDING_REAL_CORE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-ts-fold-'));
  const client = new ContextFoldingClient({ statePath: join(directory, 'archive.sqlite'),
    env: { PYTHONPATH: process.env.CONTEXT_FOLDING_REAL_CORE_PATH } });
  try {
    const empty = await client.fold('fold-test', '');
    assert.equal(empty.scope, 'fold-test');
    assert.equal(empty.text, '');
    assert.deepEqual(empty.references, []);
    const body = 'completed 中文🙂\n'.repeat(80).slice(0, -1);
    const prefix = 'visible\n'.repeat(800) + '<!-- @context-fold begin evidence -->\r\n';
    const suffix = '\r\n<!-- @context-fold end evidence -->\r\nlast line without newline';
    const text = prefix + body + suffix;
    const folded = await client.fold('fold-test', text);
    assert.equal(folded.scope, 'fold-test');
    assert.equal(folded.references.length, 1);
    const reference = folded.references[0];
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    assert.equal(reference.id, sha256);
    assert.equal(reference.sha256, sha256);
    assert.equal(reference.label, 'evidence');
    assert.match(reference.reference, /^\[\[cf:v2:[a-f0-9]{12,64}\]\]$/);
    assert.equal(folded.text, prefix + reference.reference + suffix, 'full text must not be paginated or gain a newline');
    assert.equal((await client.resolve('fold-test', { content: folded.text })).value.content, text);
    assert.equal((await client.read('fold-test', reference.id)).text, body);
    await assert.rejects(client.read('another-scope', reference.id), error => error instanceof ContextFoldingError);
    const custom = ';; @context-fold begin custom\n' + 'archived detail '.repeat(20) + '\n;; @context-fold end custom';
    const customFold = await client.fold('custom', custom, { commentStyles: [{ start: ';;' }] });
    assert.equal(customFold.references.length, 1);
    assert.equal((await client.resolve('custom', customFold.text)).value, custom);
  } finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('installed Python core exposes nested metadata and bounded recursive queries', { skip: !process.env.CONTEXT_FOLDING_REAL_CORE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-ts-query-'));
  const client = new ContextFoldingClient({ statePath: join(directory, 'archive.sqlite'),
    env: { PYTHONPATH: process.env.CONTEXT_FOLDING_REAL_CORE_PATH } });
  try {
    const detail = ('x'.repeat(350) + ' needle=42 中文🙂\n').repeat(20);
    const text = '<!-- @context-fold begin parent -->\nparent summary\n'
      + '<!-- @context-fold begin child -->\n' + detail
      + '<!-- @context-fold end child -->\n<!-- @context-fold end parent -->';
    const folded = await client.fold('nested', text);
    assert.equal(folded.references.length, 1, 'only top-level references are returned');
    const id = folded.references[0].id;
    const metadata = await client.meta('nested', id);
    assert.equal(metadata.sha256, id);
    assert.equal(metadata.childCount, 1);
    assert.equal(metadata.children.length, 1);
    assert.ok(!Object.hasOwn(metadata, 'text'), 'metadata must not open the body');
    const children = await client.list('nested', { id, depth: 1, limit: 10 });
    assert.ok(children.entries.some(entry => entry.id === metadata.children[0]));
    const parent = await client.read('nested', id, { limit: 1000 });
    assert.match(parent.text, /\[\[cf:v2:[a-f0-9]{12,64}\]\]/);
    assert.ok(!parent.text.includes('needle=42'), 'parent view keeps child body folded');
    assert.equal(parent.sha256, id);
    assert.notEqual(parent.viewSha256, parent.sha256);
    const line = await client.read('nested', id, { startLine: 1, endLine: 1, limit: 60 });
    assert.match(line.text, /^parent summary/);
    assert.ok(Array.from(line.text).length <= 60);
    const matches = await client.grep('nested', 'needle=42', { id, limit: 2, context: 1 });
    assert.equal(matches.matches.length, 2);
    assert.equal(matches.matches[0].id, metadata.children[0]);
    assert.ok(matches.matches.every(match => match.line >= 1 && match.text.includes('needle=42') && Array.from(match.text).length <= 160));
    assert.ok(matches.nextOffset !== null);
    assert.deepEqual((await client.grep('nested', 'needle=42', { id, recursive: false })).matches, []);
    const child = await client.read('nested', metadata.children[0]);
    assert.ok(Array.from(child.text).length <= 1200, 'default read stays bounded');
    assert.equal((await client.fold('nested', text)).text, folded.text);
  } finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('disposal rejects outstanding and future calls and is repeatable', async () => {
  await fixture(async client => {
    const pending = client.call({ action: 'hang', scope: 's' });
    const rejection = assert.rejects(pending, error => error.code === 'disposed');
    await new Promise(resolve => setTimeout(resolve, 30));
    await client.dispose();
    await rejection;
    await assert.rejects(client.list('s'), error => error.code === 'disposed');
    await client.dispose();
  });
});
