import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { evaluatePolicy, planCandidates, policyRequestHash, policySchema, type PolicyInput } from '../src/policy.js';
import type { Span } from '../src/protocol.js';

const request = {
  model: 'configured/model', protocol: 'chat' as const,
  before: 'x'.repeat(39_998), after: 'x'.repeat(798),
};
const incremental = { toolCalls: 0, modelRoundTrips: 0, inputTokens: 0, outputTokens: 0,
  inputPricePerMillion: 0, outputPricePerMillion: 0, toolFeesUsd: 0 };
const cost = {
  incremental,
  bytesPerTokenLower: 4, bytesPerTokenUpper: 4,
  input: { lower: 1, upper: 1 }, cacheRead: { lower: 0.1, upper: 0.1 },
  cacheWrite: { lower: 1.25, upper: 1.25 },
};
const now = Date.parse('2026-10-27T00:00:00Z');
const span = (id: string, role: Span['role'] = 'assistant', text = 'eligible text'): Span => ({
  id, role, text, path: ['messages', 1, 'content'], messageIndex: 1,
});
const script = (source: string, overrides = {}) => ({ command: [process.execPath, '-e', source] as [string, ...string[]], ...overrides });
const planner = (policy: PolicyInput, spans = [span('a')], signal?: AbortSignal) => planCandidates({
  policy, spans, model: request.model, protocol: request.protocol, ...(signal ? { signal } : {}),
});
const certificate = (overrides = {}) => ({
  requestHash: policyRequestHash(request), model: request.model, protocol: request.protocol,
  expiresAt: '2026-10-27T00:01:00Z', beforeLowerTokens: 10_000, afterUpperTokens: 200,
  oldMinPricePerMillion: 0.1, newMaxPricePerMillion: 1.25, extraCostUpperUsd: 0, incremental,
  assumptions: ['Trusted local token counter and applicable complete-request price bounds.'], ...overrides,
});

test('default policy opts out of automatic selection and opts into strict cost gating', async () => {
  const policy = policySchema.parse({});
  assert.equal(policy.mode, 'cost');
  assert.deepEqual(policy.autoRoles, []);
  assert.equal(policy.minChars, 4096);
  assert.deepEqual(await planner({}), { marks: [] });
  assert.equal((await evaluatePolicy({ ...request, policy: {} })).reason, 'policy-cost-bounds-missing');
});

test('validates finite nonnegative prices and ordered token/price bounds', () => {
  for (const override of [
    { input: { lower: 2, upper: 1 } }, { cacheRead: { lower: -1, upper: 0 } },
    { cacheWrite: { lower: 0, upper: Infinity } }, { bytesPerTokenLower: 0 },
    { bytesPerTokenLower: 5, bytesPerTokenUpper: 4 }, { overheadUsd: NaN },
    { outputTokens: 0.5 }, { restoreTokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(policySchema.safeParse({ cost: { ...cost, ...override } }).success, false);
  assert.equal(policySchema.safeParse({ autoRoles: ['tool', 'tool'] }).success, false);
  assert.equal(policySchema.safeParse({ minimumSavingUsd: -1 }).success, false);
  assert.equal(policySchema.safeParse({ unknown: true }).success, false);
});

test('proves the 10k-token example using full serialization and cheapest baseline cache price', async () => {
  const proof = await evaluatePolicy({ ...request, policy: { cost }, now });
  assert.equal(proof.approved, true);
  assert.equal(proof.bounds?.beforeLowerTokens, 10_000);
  assert.equal(proof.bounds?.afterUpperTokens, 200);
  assert.equal(proof.bounds?.oldMinPricePerMillion, 0.1);
  assert.equal(proof.bounds?.newMaxPricePerMillion, 1.25);
  assert.ok(Math.abs(proof.savingLowerUsd! - 0.00075) < 1e-12);
  assert.ok(proof.assumptions?.some(value => value.includes('not an actual tokenizer')));
});

test('fewer tokens do not imply savings when the baseline may already be cached', async () => {
  const proof = await evaluatePolicy({ ...request, after: 'x'.repeat(19_998), policy: { cost }, now });
  assert.equal(proof.approved, false);
  assert.ok(proof.savingLowerUsd! < 0);
});

test('requires incremental bounds and includes an extra model round trip', async () => {
  const { incremental: omitted, ...legacy } = cost;
  assert.equal((await evaluatePolicy({ ...request, policy: { cost: legacy }, now })).reason,
    'policy-incremental-cost-bounds-missing');
  const proof = await evaluatePolicy({ ...request, policy: { cost: { ...cost,
    incremental: { ...omitted, toolCalls: 1, modelRoundTrips: 1, inputTokens: 10_000,
      outputTokens: 100, inputPricePerMillion: 1.25, outputPricePerMillion: 5 },
  } }, now });
  assert.equal(proof.approved, false);
  assert.ok(proof.savingLowerUsd! < 0);
});

test('charges output, restore and fixed overhead for this round, with strict minimum savings', async () => {
  const withOverhead = { ...cost, overheadUsd: 0.0001, outputTokens: 100,
    outputPricePerMillion: 2, restoreTokens: 50 };
  const proof = await evaluatePolicy({ ...request, policy: { cost: withOverhead }, now });
  assert.equal(proof.approved, true);
  assert.ok(Math.abs(proof.savingLowerUsd! - 0.0003875) < 1e-12);
  assert.equal((await evaluatePolicy({ ...request, policy: { cost, minimumSavingUsd: 0.00075 }, now })).approved, false);
  assert.equal((await evaluatePolicy({ ...request, policy: { cost: { ...cost, overheadUsd: 0.00075 } }, now })).approved, false);
});

test('charges the entire system/tools/guide, including cache-prefix disruption', async () => {
  const before = { system: 's'.repeat(10_000), messages: [{ role: 'assistant', content: request.before }] };
  const after = { ...before, messages: [{ role: 'assistant', content: request.after }], guide: 'g'.repeat(100) };
  const proof = await evaluatePolicy({ ...request, before, after, policy: { cost }, now });
  assert.equal(proof.bounds?.beforeLowerTokens, Math.floor(Buffer.byteLength(JSON.stringify(before)) / 4));
  assert.equal(proof.bounds?.afterUpperTokens, Math.ceil(Buffer.byteLength(JSON.stringify(after)) / 4));
  assert.equal(proof.approved, false);
});

test('token conversion handles decimal and extreme configured ratios without rounding into approval', async () => {
  const proof = await evaluatePolicy({ ...request, before: 'a', after: 'b',
    policy: { cost: { ...cost, bytesPerTokenLower: 0.1, bytesPerTokenUpper: 0.1 } }, now });
  assert.equal(proof.bounds?.beforeLowerTokens, 30);
  assert.equal(proof.bounds?.afterUpperTokens, 30);
  assert.equal(proof.approved, false);
  assert.equal((await evaluatePolicy({ ...request,
    policy: { cost: { ...cost, bytesPerTokenLower: Number.MIN_VALUE } }, now })).approved, false);
  assert.equal((await evaluatePolicy({ ...request,
    policy: { cost: { ...cost, overheadUsd: Number.MAX_VALUE, outputTokens: 1, outputPricePerMillion: Number.MAX_VALUE } }, now })).approved, false);
});

test('positive incremental cost cannot disappear through numeric underflow', async () => {
  const proof = await evaluatePolicy({ ...request, policy: { cost: {
    ...cost, outputTokens: 1, outputPricePerMillion: Number.MIN_VALUE,
    restoreTokens: 0,
  } }, now });
  assert.ok(proof.bounds!.extraCostUpperUsd > 0);
});

test('invalid and out-of-range proof clocks fail closed', async () => {
  for (const invalidNow of [NaN, Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    assert.deepEqual(await evaluatePolicy({ ...request, policy: { cost }, now: invalidNow }), {
      approved: false, reason: 'invalid-proof-settings',
    });
  }
});

test('zero baseline cache price cannot certify savings and legacy bytes mode makes no cost claim', async () => {
  assert.equal((await evaluatePolicy({ ...request, policy: { cost: { ...cost, cacheRead: { lower: 0, upper: 0 } } }, now })).approved, false);
  assert.deepEqual(await evaluatePolicy({ ...request, policy: { mode: 'bytes' } }), {
    approved: true, reason: 'bytes-smaller-no-cost-proof',
  });
  assert.equal((await evaluatePolicy({ ...request, after: request.before, policy: { mode: 'bytes' } })).approved, false);
});

test('hash matches the existing accounting request format and changes with either complete body', () => {
  assert.equal(policyRequestHash(request), createHash('sha256').update(JSON.stringify(request)).digest('hex'));
  assert.notEqual(policyRequestHash(request), policyRequestHash({ ...request, after: { text: request.after, guide: 'new' } }));
});

test('explicit cache/token evidence requires a current matching request-bound certificate', async () => {
  assert.equal((await evaluatePolicy({ ...request, policy: {}, certificate: certificate(), now })).approved, true);
  for (const change of [{ requestHash: 'different' }, { model: 'other' }, { protocol: 'gemini' },
    { expiresAt: '2026-10-27T00:00:00Z' }, { newMaxPricePerMillion: Infinity }]) {
    assert.equal((await evaluatePolicy({ ...request, policy: {}, certificate: certificate(change), now })).approved, false);
  }
});

test('built-in planner respects roles, minimum size and structural protection', async () => {
  const spans = [span('a'), span('tool', 'tool'), span('user', 'user'), span('short', 'assistant', 'a'),
    { ...span('protected'), protectedReason: 'signed' }];
  const result = await planner({ autoRoles: ['assistant', 'tool'], minChars: 5 }, spans);
  assert.deepEqual(result.marks.map(mark => mark.id), ['a', 'tool']);
  assert.ok(result.marks.every(mark => mark.summary?.includes('read the original')));
  assert.deepEqual((await planner({ autoRoles: ['user'], minChars: 0 }, spans)).marks.map(mark => mark.id), ['user']);
});

test('script sees only supplied eligible spans and returns validated optional summaries', async () => {
  const source = `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
    const context=JSON.parse(data);
    if(context.version!==1||context.kind!=='candidates'||context.spans.length!==1||'path' in context.spans[0])process.exit(2);
    process.stdout.write(JSON.stringify({marks:[{id:context.spans[0].id,disposition:'foldable',summary:'  archived result  '}]}));
  });`;
  const result = await planner({ autoRoles: ['assistant'], minChars: 0, script: script(source) }, [span('a'), span('u', 'user')]);
  assert.deepEqual(result, { marks: [{ id: 'a', disposition: 'foldable', summary: 'archived result' }] });
});

test('scripts cannot mark unknown, duplicate, protected or unprovided IDs, or request mutations', async () => {
  for (const response of [
    { marks: [{ id: 'unknown', disposition: 'foldable' }] },
    { marks: [{ id: 'protected', disposition: 'foldable' }] },
    { marks: [{ id: 'a', disposition: 'foldable' }, { id: 'a', disposition: 'keep' }] },
    { marks: [{ id: 'a', disposition: 'foldable', path: ['system'] }] },
    { marks: [{ id: 'a', disposition: 'keep', summary: 'not valid' }] },
    { marks: [{ id: 'a', disposition: 'foldable', summary: '   ' }] },
    { marks: [], after: { system: 'overwrite' } },
    { marks: [{ id: 'a', disposition: 'unmarked' }] },
  ]) await assert.rejects(planner({ autoRoles: ['assistant'], minChars: 0,
    script: script(`process.stdout.write(${JSON.stringify(JSON.stringify(response))})`) },
  [span('a'), span('b'), { ...span('protected'), protectedReason: 'signed' }]));
});

test('summary size and duplicate caller IDs are bounded', async () => {
  await assert.rejects(planner({ autoRoles: ['assistant'], minChars: 0,
    script: script(`process.stdout.write('{"marks":[{"id":"a","disposition":"foldable","summary":"12345"}]}')`, { maxSummaryChars: 4 }) }));
  await assert.rejects(planner({}, [span('a'), span('a')]));
});

test('script argv is literal and executable paths must be absolute', async () => {
  assert.equal(policySchema.safeParse({ script: { command: ['node', '-e', ''] } }).success, false);
  assert.equal(policySchema.safeParse({ script: { command: ['/bin/true', '\0'] } }).success, false);
  const source = `if(process.argv[1]!=='$(exit 19); *')process.exit(2);process.stdout.write('{"marks":[]}')`;
  assert.deepEqual(await planner({ autoRoles: ['assistant'], minChars: 0,
    script: { command: [process.execPath, '-e', source, '$(exit 19); *'] } }), { marks: [] });
});

test('script timeout, stdout/stderr limits and nonzero exits fail closed', async () => {
  for (const command of [
    script('setInterval(()=>{},1000)', { timeoutMs: 30 }),
    script("process.stdout.write('x'.repeat(200))", { maxOutputBytes: 100 }),
    script("process.stderr.write('x'.repeat(200));process.stdout.write('{\"marks\":[]}')", { maxOutputBytes: 100 }),
    script('process.exit(7)'), script("process.stdout.write('invalid JSON')"),
    { command: ['/nonexistent/policy-script'] as [string] },
  ]) await assert.rejects(planner({ autoRoles: ['assistant'], minChars: 0, script: command }));
});

test('input limit and cancellation stop script execution', async () => {
  await assert.rejects(planner({ autoRoles: ['assistant'], minChars: 0,
    script: script("process.stdout.write('{\"marks\":[]}')", { maxInputBytes: 10 }) }), /input limit/);
  const controller = new AbortController();
  const promise = planner({ autoRoles: ['assistant'], minChars: 0,
    script: script('setInterval(()=>{},1000)') }, [span('a')], controller.signal);
  controller.abort(new Error('caller-cancelled'));
  await assert.rejects(promise, /caller-cancelled/);
  await assert.rejects(planner({}, [span('a')], controller.signal), /caller-cancelled/);
});

test('local certificate command supplies deterministic bounds for the exact body hash', async () => {
  const source = `let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
    const context=JSON.parse(data);
    if(context.kind!=='certificate'||context.before.length!==39998||context.after.length!==798)process.exit(2);
    process.stdout.write(JSON.stringify({...${JSON.stringify(certificate())},requestHash:context.requestHash}));
  });`;
  const result = await evaluatePolicy({ ...request, policy: { certificateScript: script(source) }, now });
  assert.equal(result.approved, true);
  assert.equal((await evaluatePolicy({ ...request, policy: { certificateScript: script('process.exit(2)') }, now })).reason,
    'policy-certificate-script-failed');
});
