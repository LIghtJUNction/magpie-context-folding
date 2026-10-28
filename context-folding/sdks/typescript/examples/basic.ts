import { ContextFoldingClient } from '../src/index.js';

// Install the independent Python package first; this bridge does not require Magpie.
await using client = new ContextFoldingClient({ statePath: './context-state.sqlite' });
const text = '<!-- @context-fold begin investigation -->\n'
  + 'Archived evidence from a completed step.\n'.repeat(30)
  + '<!-- @context-fold end investigation -->\n';
const folded = await client.fold<{ text: string; references: { id: string; label: string }[] }>('example', text);
process.stdout.write(folded.text); // The explicit fold action returns an immediate view.
console.log(await client.resolve('example', { content: folded.text }));
const reference = folded.references[0];
if (reference) console.log(await client.read('example', reference.id)); // Original marked body.
