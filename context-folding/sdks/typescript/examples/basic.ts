import { ContextFoldingClient } from '../src/index.js';

// Install the independent Python package first; this bridge does not require Magpie.
await using client = new ContextFoldingClient({ statePath: './context-state.sqlite' });
const text = '# @context-fold begin investigation\n'
  + '# Archived evidence from a completed step.\n'.repeat(30)
  + '# @context-fold end investigation\n';
const source = { action: 'read-source', scope: 'example', text, language: 'python', occurrence: 'read-1' };
const first = await client.call<{ id: string; text: string }>({ ...source, requestCycle: 0 });
console.log(first.text); // First observation remains complete.
const folded = await client.call<{ text: string }>({ ...source, requestCycle: 1 });
console.log(folded.text); // The same occurrence can fold in the next request.
console.log(await client.resolve('example', { content: folded.text }));
console.log(await client.read('example', first.id)); // Restores and keeps the original.
