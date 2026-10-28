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
      client.search('scope', 'needle🙂', { action: 'wrong', scope: 'wrong', query: 'wrong', id: 'parent', limit: 1 }),
      client.meta('scope', 'entry', { action: 'wrong', id: 'wrong', offset: 1 }),
    ];
    const values = await Promise.all(requests);
    assert.equal(new Set(values.map(value => value.pid)).size, 1);
    assert.deepEqual(values.map(value => value.request.action), ['put', 'list', 'read', 'read-source', 'render', 'resolve', 'fold', 'search', 'meta']);
    assert.equal(values[0].request.text, '原文🙂');
    assert.equal(values[0].request.scope, 'scope');
    assert.equal(values[0].argv[0], '--state');
    assert.ok(values[0].argv[1].endsWith('state with spaces.sqlite'));
    assert.deepEqual(values[5].request.value, { content: '[[cf:v1:entry]]' });
    assert.deepEqual(values[6].request, { action: 'fold', scope: 'scope', text: '', language: 'explicit', commentStyles: [{ start: ';;' }] });
    assert.deepEqual(values[7].request, { action: 'search', scope: 'scope', query: 'needle🙂', id: 'parent', limit: 1 });
    assert.deepEqual(values[8].request, { action: 'meta', scope: 'scope', id: 'entry', offset: 1 });
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

test('installed Python core delays explicit annotations and recovers exact originals', { skip: !process.env.CONTEXT_FOLDING_REAL_CORE_PATH }, async () => {
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
    assert.match(folded.text, /\[\[cf:v3:[a-f0-9]{64}\]\]/);
    assert.equal((await client.call({ ...request, occurrence: 'read-2', requestCycle: 2 })).text, text, 'new read gets its own delay');
    const resolved = await client.resolve('real', { content: folded.text });
    assert.equal(resolved.value.content, text);
    assert.equal((await client.read('real', first.id)).text, text);
    assert.match((await client.call({ ...request, requestCycle: 3 })).text, /\[\[cf:v3:/, 'reading must preserve folding');
    await client.call({ action: 'restore', scope: 'real', id: first.id });
    assert.equal((await client.call({ ...request, requestCycle: 4 })).text, text, 'explicitly restored source stays visible');
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
    assert.match(reference.id, /^[a-f0-9]{64}$/);
    assert.notEqual(reference.id, sha256, 'occurrence identity is separate from content identity');
    assert.equal(reference.nodeId, reference.id);
    assert.equal(reference.archiveId, reference.id);
    assert.equal(reference.sha256, sha256);
    assert.equal(reference.contentHash, sha256);
    assert.equal(reference.label, 'evidence');
    assert.equal(reference.reference, `[[cf:v3:${reference.id}]]`);
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

test('live archive preserves duplicate occurrences and supports read-only tree queries', { skip: !process.env.CONTEXT_FOLDING_REAL_CORE_PATH }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cf-ts-tree-'));
  const client = new ContextFoldingClient({ statePath: join(directory, 'archive.sqlite'),
    env: { PYTHONPATH: process.env.CONTEXT_FOLDING_REAL_CORE_PATH } });
  try {
    const body = 'intro🙂 Needle 中文 end\n' + 'saved detail\n'.repeat(20).trimEnd();
    const region = label => `<!-- @context-fold begin ${label} -->\n${body}\n<!-- @context-fold end ${label} -->`;
    const text = `<!-- @context-fold begin parent -->\n${region('first')}\n${region('second')}\n<!-- @context-fold end parent -->`;
    const folded = await client.fold('tree', text, { sourceId: 'conversation:42' });
    assert.equal(folded.references.length, 1, 'only the outermost body is replaced');
    const parentId = folded.references[0].id;
    const children = await client.list('tree', { parentId });
    assert.equal(children.entries.length, 2, 'identical siblings are two occurrences');
    const [first, second] = children.entries;
    assert.notEqual(first.id, second.id);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.parentId, parentId);
    assert.equal(second.parentId, parentId);
    assert.ok(first.sourceRange.start < second.sourceRange.start, 'source order is preserved');
    const before = await client.meta('tree', parentId, { limit: 1 });
    assert.equal(before.children.length, 1);
    assert.equal(before.nextOffset, 1);
    const tail = await client.meta('tree', parentId, { offset: before.nextOffset, limit: 1 });
    assert.equal(tail.children.length, 1);
    assert.equal(tail.nextOffset, null);
    const matches = await client.search('tree', 'Needle 中文', { id: parentId, caseSensitive: true });
    const leafHits = matches.matches.filter(hit => hit.id === first.id || hit.id === second.id);
    assert.equal(leafHits.length, 2, 'search must keep both occurrence IDs');
    for (const hit of leafHits) {
      assert.equal(hit.offsetUnit, 'unicode-code-points');
      const page = await client.read('tree', hit.id, { offset: hit.offset, limit: [...'Needle 中文'].length });
      assert.equal(page.text, 'Needle 中文', 'search offsets address the same original as read');
    }
    assert.deepEqual(await client.meta('tree', parentId, { limit: 1 }), before, 'queries leave node state unchanged');
    const unicode = await client.put('tree', 'A🙂İX end');
    const insensitive = await client.search('tree', 'İx', { id: unicode.id, recursive: false, caseSensitive: false });
    assert.equal(insensitive.matches.length, 1);
    assert.equal(insensitive.matches[0].offset, 2, 'case-insensitive matching keeps original code-point offsets');
    assert.equal((await client.read('tree', unicode.id, { offset: insensitive.matches[0].offset, limit: 2 })).text, 'İX');
    const repeated = await client.fold('tree', text, { sourceId: 'conversation:42' });
    assert.equal(repeated.references[0].id, parentId, 'retry reuses the occurrence');
    const other = await client.fold('tree', text, { sourceId: 'conversation:43' });
    assert.notEqual(other.references[0].id, parentId, 'new source has a distinct occurrence');
    assert.equal(other.references[0].sha256, folded.references[0].sha256);
    await assert.rejects(client.meta('other-scope', first.id), error => error instanceof ContextFoldingError);
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
