import { ContextFoldingClient } from '../src/index.js';

// Install the independent Python package first; this bridge does not require Magpie.
await using client = new ContextFoldingClient({ statePath: './context-state.sqlite' });
const text = '<!-- @context-fold begin investigation -->\n'
  + 'Next step: check the parser timeout.\n'
  + '<!-- @context-fold begin trace -->\n'
  + 'Observed timeout while reading the parser response.\n'.repeat(30)
  + '<!-- @context-fold end trace -->\n'
  + '<!-- @context-fold end investigation -->\n';
const folded = await client.fold<{ text: string; references: { id: string; label: string }[] }>('example', text);
process.stdout.write(folded.text); // The explicit fold action returns an immediate view.
const reference = folded.references[0];
if (reference) {
  console.log(await client.meta('example', reference.id));
  console.log(await client.list('example', { id: reference.id, depth: 2, limit: 5 }));
  console.log(await client.grep('example', 'timeout', { id: reference.id, limit: 3 }));
  console.log(await client.read('example', reference.id, { limit: 160 })); // Child bodies remain references.
}
