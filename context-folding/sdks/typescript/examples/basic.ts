import { ContextFoldingClient } from '../src/index.js';

// Install the independent Python package first; this SDK does not depend on Magpie.
await using client = new ContextFoldingClient({ statePath: './context-state.sqlite' });
const item = await client.put<{ id: string }>('example', 'Historical tool output', { role: 'tool' });
await client.mark('example', item.id, 'foldable', { summary: 'Tool completed; original evidence is archived.' });
console.log(await client.render('example', [item.id]));
console.log(await client.read('example', item.id));
console.log(await client.resolve('example', { content: `[[cf:v1:${item.id}]]` }));
