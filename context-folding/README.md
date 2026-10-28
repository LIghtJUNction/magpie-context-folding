# ctxf — Context Folding

A local text-folding command and persistent archive for **explicit folding comments**. The agent writes a matching `@context-fold begin LABEL` / `@context-fold end LABEL` pair. An explicit `fold` call saves the marked body by hash, records its occurrence in a containment tree, and immediately returns a node reference. The separate `read-source` integration retains delayed projection at host request boundaries.

The `ctxf` CLI, Python API, JSON Lines RPC and Rust/TypeScript/C# bridges all use this same Python engine and SQLite archive. They make no model calls or network requests. This package is separate from the [Magpie request plugin](../README.md): installing it does not intercept another tool or rewrite a host's history.

The root plugin source is 0.5.0, not published to npm. This standalone package remains version 0.1.0; use the matching repository checkout for the contract described here.

## Install and run

Python 3.10+ is required. Python 3.11+ uses the standard library; Python 3.10 additionally requires `tomli`. Install the command from the repository root:

```sh
uv tool install ./context-folding
cat notes.txt | ctxf
ctxf fold < notes.txt > notes.folded.txt
ctxf fold --json < notes.txt
```

For development without a tool installation, run `uv sync --project context-folding` and prefix commands with `uv run --project context-folding`, for example `uv run --project context-folding ctxf fold < notes.txt`. The old `context-folding` executable and `python -m context_folding` retain their explicit command/state arguments and JSON management output. They call the same engine; `ctxf` adds the pipe-friendly defaults. Only this Python package installs `ctxf`.

`ctxf` defaults to scope `default` and a persistent state file selected in this order: `--state`, `CTXF_STATE`, then `$XDG_DATA_HOME/context-folding/archive.sqlite3` or `~/.local/share/context-folding/archive.sqlite3` when XDG is unset. `--state` and `--scope` may appear before or after single-operation commands such as `fold` and `read`. RPC calls supply their own scopes. Use the same state and scope when recovering a reference from another process or interface.

`--state` is a SQLite **file path**, not a directory. New files use mode 0600 and newly created parent directories use mode 0700. Keep the archive in a persistent private directory; closing a client does not delete it. SDK clients select their state file explicitly.

Every API/RPC request supplies a stable `scope` of 1–200 characters; the CLI default does not remove that API requirement. The scope is a local namespace, not authentication. File/process permissions remain the host's responsibility. Do not reuse another application's scope to recover its data.

## Immediate text folding

For notes or assistant-authored text, use whole-line HTML comments:

```text
<!-- @context-fold begin investigation -->
Completed observations, comparisons and intermediate details that can be recovered later.
<!-- @context-fold end investigation -->
The decision and next step stay outside the marked region.
```

`cat notes.txt | ctxf` and `ctxf fold < notes.txt` read UTF-8 text from stdin and write the complete folded text to stdout. They do not paginate or append a newline. Unmarked text and empty input pass through; damaged or crossing regions stay visible. Complete nested regions form a containment tree. A body stays visible when its reference would not reduce its UTF-8 byte length. Original bodies and their node relationships are committed together before references are returned.

`ctxf fold --json` instead returns the core result object with `scope`, `text` and `references`. Each reference includes its occurrence `id` / `nodeId`, separate body `sha256` / `contentHash`, `label`, the `[[cf:v3:…]]` `reference`, and backing `archiveId`. A node ID is a complete 64-digit hexadecimal identifier, not the body's hash. This list describes bodies replaced by this call; nested children can be discovered with `list` and `meta` without returning all their text.

```sh
ctxf fold --scope investigation --json < notes.txt
ctxf read --scope investigation --id ACTUAL_RETURNED_NODE_ID --raw > original-body.txt
```

`read --raw` follows all pages and writes the original body without an added newline. Ordinary `read` retains its JSON envelope and pagination. Both leave folding state unchanged. To reconstruct the complete marked input, `resolve` replaces references in the folded text; reading one reference returns just that marked body. Keep the returned node ID and scope rather than calculating them manually.

The shared API operation is `{"action":"fold","scope":"example","text":"..."}`. Python exposes `client.fold(scope, text, **options)`; SDKs expose corresponding thin wrappers. `text` is required and may be empty. Optional `sourceId` distinguishes independent inputs with identical content; without it, the complete input hash identifies the source so retries are stable. Optional `language` and `commentStyles` use the parser rules below. Explicit `fold` performs the requested conversion immediately, even when automatic projection is disabled, delayed or protected by `keep`; quota and archive safety limits still apply. It does not alter those automatic-projection settings.

## Browse, enumerate and search

The same SQLite file stores original text in `blobs(hash, text)` and node metadata in scoped snapshots. Duplicate text shares a blob; different occurrences retain distinct node IDs, direct parents and original source ranges. The nearest containing region is the parent. Parent originals already include their children, so reading a parent never appends child bodies again.

```sh
ctxf list --scope investigation --recursive
ctxf list --scope investigation --parent ACTUAL_NODE_ID
ctxf search --scope investigation --query 'connection refused'
ctxf search --scope investigation --id ACTUAL_NODE_ID --query 'connection refused'
ctxf meta --scope investigation --id ACTUAL_NODE_ID
ctxf read --scope investigation --id ACTUAL_NODE_ID --offset 0 --limit 800
```

`list` defaults to root nodes; `--parent` lists direct children and `--recursive` enumerates descendants. `search` (`grep` is an alias) scans the archived originals, returns at most 20 matching records by default, and uses literal, case-sensitive matching; `--ignore-case` opts into case-insensitive matching. Match offsets refer to the matched node's original text and can be passed directly to `read`. `meta` returns a node's parent, source range, content hash and paginated child IDs; use `list(parentId)` for their metadata. Follow `nextOffset` to continue any query.

These queries do not expand history, refresh retention counters, migrate stored data, or trigger garbage collection. Old inline-text snapshots remain readable and migrate into blobs on the next successful write, in the same transaction as the node changes. See the [archive design](../docs/hash-archive.md) and [transport contract](docs/TRANSPORT.md).

## Source annotations and compact reads

Use whole-line comments in the source language:

```python
# @context-fold begin parse-options
options = parse_options(input_text)
validate_options(options)
# @context-fold end parse-options
```

Both labels must match. No hash is written by the agent. The core discovers **only explicit comments**; it no longer selects Python functions, classes, older file versions or similar text for folding. Unmarked source remains complete. Complete nested markers form parent/child nodes. Malformed, mismatched, unclosed or crossing markers preserve the affected range. Earlier independently closed regions remain eligible: starting a new unfinished region does not unfold a completed one. An orphan end marker remains literal text.

Folded views retain the marker lines and replace the body with `[[cf:v3:<node-id>]]`. The separate content hash is SHA-256 of the body's exact UTF-8 bytes, excluding marker lines and the final physical newline retained beside the reference. The node reference identifies this occurrence and version; source changes produce a new snapshot, and old references continue to recover old content.

### Delay requires a host request cycle

The default `folding.delay_requests = 1` means that the first complete observation remains visible. The host must supply both:

- `occurrence`: a stable identifier for this appearance in retained history. A new file read needs a new value, even for identical text.
- `requestCycle`: a nonnegative, monotonically advancing request-cycle number. Retries reuse the same number.

Reproject the same occurrence when constructing a later request. The core does not advance time merely because an RPC call was repeated.

```python
from context_folding import Client

text = (
    "# @context-fold begin investigation\n"
    + "# Completed investigation detail.\n" * 40
    + "# @context-fold end investigation\n"
)
with Client("/absolute/private/archive.sqlite") as client:
    source = dict(text=text, language="python", occurrence="read-1")
    first = client.read_source("example", **source, requestCycle=0)
    assert first["text"] == text
    retry = client.read_source("example", **source, requestCycle=0)
    assert retry["text"] == text
    later = client.read_source("example", **source, requestCycle=1)
    restored = client.resolve("example", {"content": later["text"]})
    assert restored["value"]["content"] == text
    original = client.read("example", first["id"])
    assert original["text"] == text  # Inspection leaves folding state unchanged.
    client.call({"action": "restore", "scope": "example", "id": first["id"]})
```

Without both cycle fields, the default returns original text and reports `host-request-cycle-required`. Explicitly setting `delay_requests = 0` permits immediate folding of complete annotations. A one-shot post-tool hook cannot implement delayed history replacement; see the adapter limits below.

### Input, recovery and selection

`annotate` and `read-source` accept exactly one of UTF-8 `text`, an absolute regular-file `path`, or an archived `id`. A `files` array batches 1–100 source objects atomically, with outer defaults and per-file overrides. An invalid item rolls back the batch. No source read changes the file on disk.

`read` defaults to original text and never implicitly restores it; use the explicit `restore` action to keep it visible. Legacy `peek` inputs are accepted for compatibility. `read-source` accepts explicit `expand` and `keep` selectors by region name, region ID or `"*"`; these preserve the selected region. For a folded view, use the returned node reference rather than inventing a hash. Old content hashes must not silently select an arbitrary occurrence for tree navigation.

Read responses contain `text`, `sha256`, `totalChars` and `nextOffset`. Follow `nextOffset` to retrieve the complete view; the default page is 4,000 Unicode code points, with a 24,000 maximum. All Python/bridge offsets are **Unicode code points**, including when called from TypeScript or C#. The root Magpie plugin uses UTF-16 offsets; do not transfer offsets between them.

A folded response also identifies its original, selected parser, limitations and folded regions. The exact original remains available independently of source-file changes. Existing v1/v2 references and old group manifests remain recoverable, but no new `mark` or `group` operation is accepted.

### Language boundaries

Python uses its tokenizer to accept real `#` comments and exclude marker-shaped strings. JavaScript/JSX/TypeScript/TSX uses optional Tree-sitter grammars to identify real `//` and complete `/* … */` comments:

```sh
uv sync --project context-folding --extra javascript
```

Other languages use the literal whole-line protocol. That fallback has no language lexer, so marker-shaped text inside a multiline string can be mistaken for a comment. Supply only actual source regions intended for this protocol, or retain the original view when language-aware validation is needed.

The separate Magpie gateway has a conservative Python/JS lexical filter, not these language parsers. It keeps the source complete when it encounters unsupported or ambiguous constructs such as Python f-strings, JSX, or regex/division inside a template interpolation. Its verified source-read integration does not require this Python package; the parser coverage of the two paths is different. Both retain the literal-parser limitation for other languages.

Built-in comment shells include `//`, `#`, `--`, `;`, `%`, `!`, `'`, `"`, `REM`, `/* … */`, `<!-- … -->`, `(* … *)`, `{- … -}`, `#| … |#` and `<# … #>`. Additional literal shells can be supplied as `commentStyles: [{"start":";;"}]`; they do not override Python/JS comment validation or add a lexer.

The reserved reference prefix `[[cf:` must not be treated as ordinary replaceable text. Source containing literal reference syntax is kept complete or rejected for compact projection, preserving its original meaning. Resolution expands saved payloads once, without recursively interpreting reference-looking text inside the recovered original.

### Adding comments is a separate edit

`annotate-functions /absolute/path` previews function-comment insertion; `--apply` explicitly writes it. This is a source maintenance command, not a prerequisite for reading or a background fold policy. It uses AST or Tree-sitter only to place requested comments safely, skips unsuitable bodies, and validates the resulting source.

```sh
uv run --project context-folding python -m context_folding annotate-functions /project/module.py
```

Adding comments changes line numbers and source-text introspection. Review the preview and use normal project checks before applying. Existing comments are not silently nested to create another layer of folding. Valid existing nesting is accepted; these editing commands reject malformed, unclosed, mismatched or crossing markers before writing any changes.

## CLI and SDK RPC

Use `call` for complete JSON requests. `--json -` reads stdin:

```sh
ctxf call \
  --state /absolute/private/archive.sqlite --json -
```

Here, and on existing action commands such as `read`, `--json JSON` remains a request-input option. Only the new `fold --json` is a boolean selecting JSON output.

SDK subprocesses use the same state selection:

```sh
ctxf rpc --state /absolute/private/archive.sqlite
```

RPC exchanges one request and one result/error envelope per line, in order. It is the local subprocess transport used by SDKs and opens no network listener. MCP support has been removed; remove old `ctxf mcp` client configurations and invoke CLI commands through the host shell instead. See [the transport contract](docs/TRANSPORT.md) and [protocol.json](protocol.json).

Use `fold` for an immediate explicit text conversion, or `annotate` / `read-source` for retained source observations. Browse with `list` and `meta`, find original text with `search` / `grep`, and recover it with `read`, `resolve` or `paste`. `put` remains an explicit archive operation; it does not select or summarize historical content. `render` only projects explicit annotations. `restore` explicitly keeps selected content visible and also supports old recovery data. `mark` and `group` are rejected with migration guidance.

Lifecycle operations (`roots`, `pin`, `gc`) remain available for the host to retain and clean its own archive. They are not compression modes. Automatic collection is disabled by default. Do not remove recovery data still referenced by a request; pins and roots are retention controls, distinct from folding permission.

## Host adapters

The [Pi extension](adapters/pi/README.md) and Claude `PostToolUse` hook receive a single completed read, not the host's subsequent model requests. **With the default delay they preserve full text.** An explicitly configured zero delay can expose immediate views of annotated source. No claim of delayed request replay is made for these one-shot hooks.

The Pi adapter handles successful single-text Python reads; the Claude adapter accepts only its verified complete Python Read response schema. Failed, truncated, multipart or unsupported results remain unchanged. Both preserve restore paths and existing tool approval behavior. Installing either does not authorize edits or arbitrary tool-argument mutation.

A host that wants delayed folding must retain exact source observations and call the core again with the same `occurrence` and a later `requestCycle` when constructing the model request. Installing the CLI alone does not add that hook.

## References used in edits

`resolve` accepts a complete JSON value and expands stored references in string values, not keys. It returns original text; it does not read the current source, authorize an action, or execute commands.

A host may resolve a folded source reference before sending a literal edit argument to another tool. Approval and validation must cover the **resolved final arguments**. The edit tool must still compare against the current file and reject a stale or nonunique match. Missing or ambiguous references stop dispatch rather than falling through as literal edit text.

Without an explicit host integration, restore original source before editing.

## Configuration

Settings merge from defaults, the global `context-folding/config.toml`, the nearest `.context-folding.toml`, and explicit `Client(..., config=...)` overrides. Project search stops at a Git root. Invalid settings fail before opening the archive.

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
reserve_output_tokens = 0
# Shared Magpie request options (the standalone fold command does not use them):
min_savings_tokens = 256
budget_hints = false
# context_window_tokens = 128000

[annotations]
enabled = true
default_fold = true
keep = []

[gc]
enabled = false
```

The core also accepts the root plugin's `[magpie]` settings (`shell_tool_name`, `recovery_command`, `gateway_timeout_ms`) so a project can share one file; those settings do not install Magpie hooks. The removed `magpie.recovery_tool_name` setting produces migration guidance. Remove old `folding.mode`, threshold/head/keep-recent controls, `[policy]` and accounting settings. They return migration errors, not a silent policy fallback.

The `min_savings_tokens` and `budget_hints` settings apply to Magpie request projection; the explicit Python `fold` command keeps its byte-saving check and adds no model prompt. The budget-related fields describe host capacity; the standalone archive does not count an unseen full model request. See the [root README](../README.md) for Magpie's estimate and its limits.

## SDKs and verification

The [Rust](sdks/rust/README.md), [TypeScript](sdks/typescript/README.md) and [C#](sdks/csharp/README.md) SDKs each keep one Python subprocess alive. They transport the same core protocol; they are not independent implementations of folding. Python must remain installed at runtime. Their examples call `fold` and recover the result. Generic calls also expose `read-source` and its host-supplied request cycles.

Run the Python suite from the repository root:

```sh
uv run --project context-folding python -m unittest discover -s context-folding/tests -v
```

Bridge tests exercise ordered transport, errors, Unicode, process lifecycle and actual core integration when enabled. They do not use paid model inference or prove that a real host's default compaction has been replaced. Historical counts and benchmark results from previous versions remain historical evidence.
