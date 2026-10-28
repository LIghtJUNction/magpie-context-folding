# Pi source read adapter

This optional extension projects **explicitly annotated Python source** from successful Pi `read` results. It does not select functions or old tool output automatically.

**The extension sees one `tool_result`, not later model requests. With the default `delay_requests = 1`, it leaves the result complete.** A host request-replay integration would be needed for delayed folding. Explicitly configuring `delay_requests = 0` allows immediate views of complete annotations; there is no background timer.

## Load

Supply a private absolute archive path:

```sh
pi -e /absolute/path/context-folding/adapters/pi/extension.ts \
  --context-folding-state /absolute/private/path/pi-context.sqlite
```

The extension resolves Pi types and TypeBox through Pi's loader. The adapter launches the existing Python core using `python3 -I`; requests travel through stdin, keeping source contents out of process arguments. Python must satisfy the standalone core requirements. No persistent child process is created.

Use the shared configuration if immediate source projection is intended:

```toml
[folding]
delay_requests = 0
```

The core subprocess does not infer the active Pi project from the source path. Make sure the configuration is actually visible to the configured core process; otherwise the default preserves full text. The adapter deliberately passes returned source text, not the file path, to the core.

## What is eligible

Only successful, single-text-block `read` results for `.py` files are candidates. The text must contain real whole-line Python comments such as:

```python
# @context-fold begin parse-options
# Long implementation or investigation detail here.
# @context-fold end parse-options
```

Unsupported formats, images, errors, malformed ranges, small results and truncation/continuation notices remain unchanged. Unmarked Python source stays complete. The adapter does not interpret Pi line offsets as Python character offsets, and never rereads the file to replace the already approved observation.

Before returning a shorter view, the adapter verifies the complete original through paginated archive reads and SHA-256, persists a session record, and pins the recovery snapshot. Failure at any stage produces no override, so Pi retains its original result. No-benefit reads do not publish a replacement.

## Restore and edit

`context_folding_restore` reads the exact snapshot only when the active session branch has its matching record. Session ID plus project cwd determine the scope; callers cannot supply an arbitrary scope, path or core action. The recovered text is checked again and kept visible. Local scopes are namespaces, not OS access controls.

Fold references are display references in this adapter. Restore original text before using literal source in ordinary edit/write tools. The extension does not mutate `tool_call` arguments, override approval extensions, grant permissions or resolve arbitrary edit parameters.

Pinned snapshots remain until explicitly unpinned and cleaned through normal core maintenance. Session shutdown does not delete recovery material.

## Verification

```sh
node --test context-folding/adapters/pi/adapter.test.mjs
```

Optional real-tool checks use:

```sh
PI_PACKAGE_ROOT=/absolute/path/to/@earendil-works/pi-coding-agent \
  node --test context-folding/adapters/pi/adapter.test.mjs
```

The earlier implementation was checked against Pi 0.85.1; that historical API check is not a new-version or interactive-model validation claim. Current tests exercise the Python core, full-text default, explicit annotations, exact recovery, failure passthrough and session/project/branch isolation. Actual tool checks remain conditional on an installed Pi package.
