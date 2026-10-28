import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { conversationId, foldConversation } from '../src/fold.js';
import { selectConversationRange } from '../src/ranges.js';
import { digest, type Entry } from '../src/store.js';
import { execute } from '../src/tool.js';
import { fixture } from './helpers.js';

for (const order of ['text-first', 'conversation-first']) {
  test(`${order}: raw text equal to a conversation JSONL has a distinct archive ID and recovery view`, async () => {
    await fixture(async ({ store, scope }) => {
      const body = { messages: [{ role: 'user', content: 'historical question' }, { role: 'assistant', content: 'evidence\nexact answer 😀' }] };
      const range = { start: { message: 0 }, end: { message: 2 } };
      const selection = selectConversationRange(body, 'chat', range);
      const rawId = digest(selection.transcript);
      const groupedId = conversationId(selection);
      assert.equal(rawId, selection.sha256, 'metadata sha256 remains the actual JSONL checksum');
      assert.notEqual(groupedId, rawId, 'different recovery types cannot share a logical ID');
      const raw: Entry = { id: rawId, role: 'tool', text: selection.transcript,
        annotation: { sha256: rawId, label: 'plain-jsonl-data' }, mark: { disposition: 'unmarked' }, layers: [] };
      const saveRaw = () => store.transaction(scope, true, 64 * 1024 * 1024, snapshot => { snapshot.entries.push(raw); });
      if (order === 'text-first') await saveRaw();
      const folded = await foldConversation(body, 'chat', range, scope, store);
      if (order === 'conversation-first') await saveRaw();
      assert.equal(folded.references[0]!.id, groupedId);
      assert.equal(folded.references[0]!.sha256, rawId);
      const rawRead = JSON.parse(await execute({ action: 'read', scope, id: rawId.slice(0, 12), peek: true, limit: 24000 }));
      const conversationRead = JSON.parse(await execute({ action: 'read', scope, id: groupedId.slice(0, 12), peek: true, limit: 24000 }));
      assert.equal(rawRead.text, selection.transcript);
      assert.equal(conversationRead.text, selection.text);
      assert.equal(rawRead.sha256, rawId);
      assert.equal(conversationRead.sha256, digest(selection.text));
      assert.notEqual(rawRead.path, conversationRead.path);
      assert.equal(await readFile(rawRead.path, 'utf8'), selection.transcript);
      assert.equal(await readFile(conversationRead.path, 'utf8'), selection.text);
      assert.equal(await readFile(conversationRead.transcriptPath, 'utf8'), selection.transcript);
      assert.match(rawRead.path, new RegExp(`${rawId}\\.txt$`));
      assert.match(conversationRead.path, new RegExp(`${rawId}\\.messages\\.txt$`));
      const entries = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot.entries, undefined, 'preserve');
      assert.equal(entries.length, 2);
      assert.equal(new Set(entries.map(entry => entry.id)).size, 2);
    });
  });
}
