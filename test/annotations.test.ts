import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseRegions, shortHash, replaceRegions, reference } from '../src/annotations.js';
import { digest } from '../src/store.js';

test('source and conversation markers share content hashes and preserve physical newlines', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const payload = `α😀${newline} exact `;
    for (const [begin, end] of [['<!-- ', ' -->'], ['// ', ''], ['# ', ''], ['/* ', ' */'], ['', '']]) {
      const text = `${begin}@context-fold begin x${end}${newline}${payload}${newline}${begin}@context-fold end x${end}${newline}keep`;
      const parts = [{ id: 'a', text }];
      const regions = parseRegions(parts);
      assert.equal(regions.length, 1);
      assert.equal(regions[0]!.text, payload);
      assert.equal(regions[0]!.sha256, digest(payload));
      const ref = reference(regions[0]!.sha256);
      const output = replaceRegions(parts, [{ region: regions[0]!, reference: ref }]).get('a')!;
      assert.equal(output.replace(ref, payload), text);
    }
  }
});

test('unclosed, unmatched and mismatched blocks remain literal', () => {
  for (const text of [
    '@context-fold begin x\nvalue', '@context-fold end x',
    '@context-fold begin x\nvalue\n@context-fold end y',
    '// @context-fold begin x\nvalue\n# @context-fold end x',
    '@context-fold begin x\n[[cf:v2:123456789abc]]\n@context-fold end x',
    '@context-fold begin x\n\ud800\n@context-fold end x',
  ]) assert.deepEqual(parseRegions([{ id: 'a', text }]), []);
  assert.deepEqual(parseRegions([{ id: 'a', text: 'an inline @context-fold begin x is just prose' }]), []);
});

test('split assistant text keeps each slice and does not invent separator bytes', () => {
  const parts = [{ id: 'a', text: '@context-fold begin x\nfirst' },
    { id: 'b', text: 'second\n' }, { id: 'c', text: 'third\n@context-fold end x' }];
  const [region] = parseRegions(parts);
  assert.ok(region);
  assert.equal(region.text, 'firstsecond\nthird');
  assert.equal(region.slices.length, 3);
  const replaced = replaceRegions(parts, [{ region, reference: 'REF' }]);
  assert.equal(replaced.get('a'), '@context-fold begin x\nREF');
  assert.equal(replaced.get('b'), 'REF');
  assert.equal(replaced.get('c'), 'REF\n@context-fold end x');
});

test('short hashes extend on collision deterministically and remain content-addressed', () => {
  const first = 'a'.repeat(12) + '01' + 'b'.repeat(50);
  const second = 'a'.repeat(12) + '02' + 'c'.repeat(50);
  assert.equal(shortHash(first, [first]), first.slice(0, 12));
  assert.equal(shortHash(first, [second, first]), first.slice(0, 14));
  assert.equal(shortHash(second, [first, second]), second.slice(0, 14));
});

test('shared TypeScript/Python fixtures have identical region payloads and hashes', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/annotation-regions.json', import.meta.url), 'utf8')) as {
    name: string; text: string; payloads: string[];
  }[];
  for (const fixture of fixtures) {
    const regions = parseRegions([{ id: 'a', text: fixture.text }]);
    assert.deepEqual(regions.map(region => region.text), fixture.payloads, fixture.name);
    assert.deepEqual(regions.map(region => region.sha256), fixture.payloads.map(digest), fixture.name);
  }
});
