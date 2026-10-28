# TypeScript bridge SDK

This is an asynchronous Node.js **bridge SDK**, not a native TypeScript folding core. Install the standalone Python package first with uv (from `context-folding`: `uv venv` then `uv pip install --python .venv/bin/python .`). Set `pythonExecutable` to that environment's Python. Python must remain available at runtime. No Magpie dependency or network service is required.

The client keeps one `python3 -m context_folding rpc --state PATH` subprocess alive, sends JSON Lines requests serially, drains stderr, and returns the `result` value. Application errors throw `ContextFoldingError` with the engine's `code`; malformed output and process failures close the bridge. Caller-owned archive state persists after disposal.

This is the same engine used by `ctxf fold` and `ctxf rpc`. Set `statePath` to the CLI's archive file and use the same scope to recover their references. The SDK requires an explicit state path and scope; it does not assume the CLI's `default` scope.

```ts
import { ContextFoldingClient } from '@context-folding/python-bridge';

await using client = new ContextFoldingClient({
  statePath: '/absolute/path/archive.sqlite',
  pythonExecutable: '/path/to/venv/bin/python', // optional, default python3
});
const text = '<!-- @context-fold begin investigation -->\n'
  + 'Completed investigation detail.\n'.repeat(40)
  + '<!-- @context-fold end investigation -->\n';
const folded = await client.fold<{ text: string; references: { id: string }[] }>('session', text);
process.stdout.write(folded.text); // Explicit fold returns an immediate, complete view.
console.log(await client.resolve('session', { content: folded.text }));
if (folded.references[0]) console.log(await client.read('session', folded.references[0].id));
```

`fold(scope,text,fields?,signal?)` forwards the explicit immediate operation, accepts empty text, and supports `language` / `commentStyles` fields. Its result contains `scope`, complete `text`, and `references`, each with the full SHA-256 `id`, `sha256`, `label`, short `reference` and `archiveId`. Only newly folded bodies are listed. The caller decides where to display or save the returned view; the bridge does not rewrite model history.

`call<T>({action, scope, ...fields}, signal?)` exposes all operations. Other wrappers are `put(scope,text,fields?,signal?)`, `list(scope,fields?,signal?)`, `read(scope,id,fields?,signal?)`, `render(scope,ids,fields?,signal?)`, and `resolve(scope,value,fields?,signal?)`. Use `call` for `read-source`, including `occurrence` and `requestCycle`; its default delay remains unchanged by `fold`. A fresh source read needs a fresh occurrence; retries keep the same cycle. The bridge does not observe model requests or advance cycles itself. `mark` and `group` have been removed.

Additional fields follow the Python engine protocol. `read` offsets, limits and character counts use Python Unicode code points, not JavaScript UTF-16 code units; do not derive offsets from JS `string.length` when text contains supplementary characters. The generic result type is a caller assertion, not runtime schema validation.

Use `AbortSignal.timeout(ms)` or an `AbortController` for cancellation. Cancelling a queued request leaves the stream usable. Cancelling a dispatched request terminates the process because this ordered protocol has no request IDs or cancellation messages; create a new client afterward. `await client.dispose()` rejects outstanding requests and terminates the process; `await using` calls it automatically. Disposal is repeatable. There is no implicit request deadline.

Options also include `cwd`, `env` (merged with the parent environment), `pythonArguments` (defaults to `['-m','context_folding','rpc']`), and `maxResponseBytes` (64 MiB default). Overriding arguments is useful for virtual environments and process integration tests. `--state PATH` is always appended. The client retains at most 16 KiB of stderr diagnostics.

Build and test with `npm install` then `npm test`; runtime code uses only Node standard modules. Tests run a temporary Python RPC process and cover persistence, concurrent requests, wrapper forwarding, Unicode, stderr pressure, application/protocol errors, response limits, process exit, cancellation, disposal, and failed startup. Set `CONTEXT_FOLDING_REAL_CORE_PATH=/absolute/path/context-folding/python` when running `npm test` to additionally test immediate `fold`, empty text, complete views, exact UTF-8 hashes and scoped recovery, plus `read-source` delay and retry/fresh-occurrence behavior against the actual Python core; otherwise those cases are explicitly skipped. Run the installed-engine example with `node dist/examples/basic.js` after `npm run build`; source checkout execution can instead set `PYTHONPATH=/absolute/path/context-folding/python`.
