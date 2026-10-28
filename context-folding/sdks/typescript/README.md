# TypeScript bridge SDK

An asynchronous Node.js bridge to the shared Python engine used by `ctxf` and MCP. It runs one persistent `python3 -m context_folding rpc --state PATH` process; it is not another folding implementation.

Install the Python package first, for example `uv sync --project context-folding`, and select that environment's Python. Use the same state file and scope as the CLI when querying its references.

```ts
import { readFile } from 'node:fs/promises';
import { ContextFoldingClient } from '@context-folding/python-bridge';

await using client = new ContextFoldingClient({
  statePath: '/absolute/private/archive.sqlite3',
  pythonExecutable: '/path/to/venv/bin/python',
});
const text = await readFile('notes.txt', 'utf8');
const folded = await client.fold<{ references: { id: string }[] }>('task', text);
const id = folded.references[0]?.id;
if (id) {
  console.log(await client.meta('task', id));
  console.log(await client.list('task', { id, depth: 2, limit: 5 }));
  console.log(await client.grep('task', 'timeout', { id, limit: 3 }));
  console.log(await client.read('task', id, { startLine: 1, endLine: 4, limit: 240 }));
}
```

## Operations

- `fold(scope, text, fields?, signal?)` immediately converts explicit markers; empty text is valid. Optional fields include `language` and `commentStyles`.
- `list(scope, fields?, signal?)` discovers nodes, optionally under `id` with `depth`.
- `grep(scope, query, fields?, signal?)` searches literal text internally, with optional `id`, `recursive`, `context`, `offset` and `limit`.
- `meta(scope, id, fields?, signal?)` returns hashes, sizes and a bounded child-ID page.
- `read(scope, id, fields?, signal?)` returns a bounded node view; direct children remain references.
- `call<T>({action, scope, ...fields}, signal?)` supports other core integrations, including delayed `read-source` and status.

Read/grep/list/meta do not set keep or unfold history. Read defaults to 1200 Unicode code points, maximum 24000; list/grep/meta default to 10 items, maximum 100. Read supports inclusive `startLine`/`endLine` or `offset`, not both. View line numbers and Python offsets are not JavaScript UTF-16 indices. Follow a continuation only for a concrete question.

Fold returns `scope`, complete `text`, and top-level `references` with full-SHA `id`, `sha256`, `label`, short `reference` and `archiveId`. Nested children are discoverable through list/meta and recursive grep. Query IDs may be archive IDs or unambiguous hash prefixes. `sha256` covers original bytes; `viewSha256` covers the node view.

The caller consumes returned views; the SDK cannot rewrite host history. `read-source` still requires host `occurrence`/`requestCycle` for default delayed replay. Legacy archive/export wrappers remain compatible, but examples do not resolve entire subtrees into context. Generic result types are caller assertions, not runtime schema validation.

## Transport and lifecycle

Requests are ordered JSON Lines. Application errors throw `ContextFoldingError` with the engine code and leave the process usable; malformed responses or process failures close it. Explicit wrapper arguments override extra fields.

Queued cancellation preserves the stream. Cancelling an active request terminates it because the RPC has no cancellation IDs. Use `AbortSignal.timeout(ms)` for deadlines; none is implicit. `await using` or repeatable `dispose()` closes the child without deleting the archive.

Options include `cwd`, merged `env`, `pythonArguments` (default `['-m','context_folding','rpc']`) and `maxResponseBytes` (64 MiB). `--state PATH` is appended. stderr is drained, retaining at most 16 KiB of diagnostics. The runtime uses Node standard modules only.

## Verify

Run `npm install` then `npm test`. Tests cover transport pairing, process reuse, Unicode, errors, output limits, cancellation, disposal and failed startup. Set `CONTEXT_FOLDING_REAL_CORE_PATH=/absolute/path/context-folding/python` to run the real-core fold/nested-query/delay tests; otherwise those cases are skipped.

After `npm run build`, run `node dist/examples/basic.js` with the Python package installed, or set `PYTHONPATH` to the source directory. Rust/.NET tests are separate; this SDK's results do not validate them.
