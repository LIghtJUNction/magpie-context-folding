# Pi read adapter

Optional Pi extension, verified against the locally installed `@earendil-works/pi-coding-agent` 0.85.1. No model calls, dependency installation, or live configuration changes are required for the tests.

Load manually with Pi's extension flag, supplying a private absolute archive path:

```sh
pi -e /absolute/path/context-folding/adapters/pi/extension.ts \
  --context-folding-state /absolute/private/path/pi-context.sqlite
```

The extension imports Pi types and TypeBox using Pi's extension loader dependency resolution. The adapter itself uses Node built-ins and the existing Python core, launched with `python3 -I` to avoid importing modules from the working project. JSON request bodies travel through stdin (`--json -`), keeping source contents out of process arguments and avoiding their size limit. Python must already satisfy the standalone core requirements. No persistent child process is created.

Only successful, single-text-block `read` results for `.py` paths are candidates. The adapter passes the exact returned text to the shared core's `annotate` and `read` actions. It never reads a file itself, never submits `path` to the core, and never interprets Pi line offsets as core character offsets. Valid Python source is folded using the core AST parser. Unsupported formats, images, malformed ranges, small results, invalid Python fragments, and results carrying Pi continuation/truncation notices remain unchanged. Other tools are untouched.

Before returning a shorter view, the adapter verifies the full original by paginating core reads and checking SHA-256, confirms a shorter view, persists a session custom entry, then pins the original against core garbage collection. No-benefit results and persistence failures never change existing pin state. A pin failure can leave a harmless session record but publishes no folded view. Any core, integrity, or persistence failure returns no override, so Pi keeps the original tool result. Folded text includes the snapshot ID and instructions for `context_folding_restore`. That read-only tool returns the exact original result, with a second integrity check, only if the active session branch contains its matching record. Session ID plus project cwd determine a hashed scope; callers cannot supply a scope, path, or arbitrary core action. Local scopes are namespaces, not authentication: protect the SQLite archive using normal OS file permissions.

The extension does not intercept `tool_call`, resolve references in edit/write arguments, override built-in tools, alter trust, or change permissions. Restore original text before using literal source in normal edit/write calls. Pi's usual approval extensions remain responsible for those calls. Arbitrary tool-argument reference expansion is intentionally unsupported because mutating arguments could invalidate an earlier approval.

Pinned snapshots remain on disk until the owner explicitly unpins/removes them through normal core maintenance. No background cleanup or session shutdown cleanup deletes recovery material.

Run local verification:

```sh
PI_PACKAGE_ROOT=/absolute/path/to/@earendil-works/pi-coding-agent \
  node --test context-folding/adapters/pi/adapter.test.mjs
```

Tests exercise the real Python core and, when `PI_PACKAGE_ROOT` is set, Pi's installed `createReadToolDefinition().execute` with offset/limit, source changes after reading, and continuation notices. They test exact restoration, session/project/branch isolation, Unicode pagination, failure passthrough, and persistence failure. They do not start a model or claim an interactive model conversation was tested.

Verified API sources: Pi `dist/core/extensions/types.d.ts` (`tool_result`, `registerTool`, `appendEntry`, `getFlag`), `dist/core/session-manager.d.ts` (`getSessionId`, `getBranch`), and `dist/core/tools/read.js` (line slicing and truncation semantics). The real Pi `loadExtensions` loader also loaded `extension.ts` successfully with its `tool_result` handler and restore tool.

The subprocess request function and paginated integrity reader are provider-neutral and use the standalone core contract. They could move to a common adapter helper if another harness needs the same path; only event mapping, session records, and scope derivation are Pi-specific. No other adapter is imported or modified.
