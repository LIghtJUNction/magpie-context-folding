# Context Folding

A local archive and source-view engine for **explicit folding comments**. The agent writes a matching `@context-fold begin LABEL` / `@context-fold end LABEL` pair. The core saves exact content, waits for host-reported request progress, and replaces only the marked body with a short hash reference.

This subproject provides Python, CLI, JSON Lines RPC and MCP stdio interfaces, plus Rust, TypeScript and C# subprocess bridges. It makes no model calls or network requests. It is separate from the [Magpie request plugin](../README.md): installing this package does not intercept another tool or rewrite a host's history.

The root plugin source is 0.4.0, not published to npm. This standalone package remains version 0.1.0; use the matching repository checkout for the contract described here.

## Install and run

Python 3.10+ is required. Python 3.11+ uses the standard library; Python 3.10 additionally requires `tomli`. From the repository root:

```sh
uv sync --project context-folding
uv run --project context-folding python -m context_folding status \
  --state /absolute/private/archive.sqlite --scope example
```

`--state` is a SQLite **file path**, not a directory. New files use mode 0600 and newly created parent directories use mode 0700. Keep the archive in a persistent private directory; closing a client does not delete it.

Each request supplies a stable `scope` of 1–200 characters. The scope is a local namespace, not authentication. File/process permissions remain the host's responsibility. Do not reuse another application's scope to recover its data.

## Source annotations and compact reads

Use whole-line comments in the source language:

```python
# @context-fold begin parse-options
options = parse_options(input_text)
validate_options(options)
# @context-fold end parse-options
```

Both labels must match. No hash is written by the agent. The core discovers **only explicit comments**; it no longer selects Python functions, classes, older file versions or similar text for folding. Unmarked source remains complete. Malformed, mismatched, unclosed or nested markers preserve the affected range, including nested children. Earlier independently closed regions remain eligible: starting a new unfinished region does not unfold a completed one. An orphan end marker remains literal text.

Folded views retain the marker lines and replace the body with `[[cf:v2:<hash>]]`. The hash is SHA-256 of the body's exact UTF-8 bytes, excluding marker lines and the final physical newline retained beside the reference. The visible prefix starts at 12 hex digits and lengthens on collisions. Source changes produce a new snapshot; old references continue to recover old content.

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
    assert original["text"] == text  # Also keeps this source visible.
```

Without both cycle fields, the default returns original text and reports `host-request-cycle-required`. Explicitly setting `delay_requests = 0` permits immediate folding of complete annotations. A one-shot post-tool hook cannot implement delayed history replacement; see the adapter limits below.

### Input, recovery and selection

`annotate` and `read-source` accept exactly one of UTF-8 `text`, an absolute regular-file `path`, or an archived `id`. A `files` array batches 1–100 source objects atomically, with outer defaults and per-file overrides. An invalid item rolls back the batch. No source read changes the file on disk.

`read` defaults to original text and keeps recovered annotated content visible. `peek: true` inspects without adding that protection. `read-source` accepts explicit `expand` and `keep` selectors by region name, region ID or `"*"`; these preserve the selected region. For a folded view, use the returned reference rather than inventing a hash. Short prefixes must identify one stored payload unambiguously.

Read responses contain `text`, `sha256`, `totalChars` and `nextOffset`. Follow `nextOffset` to retrieve the complete view; the default page is 4,000 Unicode code points, with a 24,000 maximum. All Python/bridge offsets are **Unicode code points**, including when called from TypeScript or C#. The root Magpie plugin uses UTF-16 offsets; do not transfer offsets between them.

A folded response also identifies its original, selected parser, limitations and folded regions. The exact original remains available independently of source-file changes. Existing v1 references and old group manifests remain recoverable, but no new `mark` or `group` operation is accepted.

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

Adding comments changes line numbers and source-text introspection. Review the preview and use normal project checks before applying. Existing comments are not silently nested to create another layer of folding. Although read projection can preserve a damaged region locally, these editing commands reject malformed, unclosed, mismatched or nested existing markers before writing any changes.

## CLI, RPC and MCP

Use `call` for complete JSON requests. `--json -` reads stdin:

```sh
uv run --project context-folding python -m context_folding call \
  --state /absolute/private/archive.sqlite --json -
```

Persistent services:

```sh
uv run --project context-folding python -m context_folding rpc --state /absolute/private/archive.sqlite
uv run --project context-folding python -m context_folding mcp --state /absolute/private/archive.sqlite
```

RPC exchanges one request and one result/error envelope per line, in order. MCP exposes `context_folding` over stdio. Neither opens a network listener. See [the transport contract](docs/TRANSPORT.md) and [protocol.json](protocol.json).

The current workflow uses `annotate` / `read-source`, `read`, `resolve`, `paste`, `list` and `status`. `put` remains an explicit archive operation; it does not select or summarize historical content. `render` only projects explicit annotations. `restore` supports old recovery data. `mark` and `group` are rejected with migration guidance.

Lifecycle operations (`roots`, `pin`, `gc`) remain available for the host to retain and clean its own archive. They are not compression modes. Automatic collection is disabled by default. Do not remove recovery data still referenced by a request; pins and roots are retention controls, distinct from folding permission.

## Host adapters

The [Pi extension](adapters/pi/README.md) and Claude `PostToolUse` hook receive a single completed read, not the host's subsequent model requests. **With the default delay they preserve full text.** An explicitly configured zero delay can expose immediate views of annotated source. No claim of delayed request replay is made for these one-shot hooks.

The Pi adapter handles successful single-text Python reads; the Claude adapter accepts only its verified complete Python Read response schema. Failed, truncated, multipart or unsupported results remain unchanged. Both preserve restore paths and existing tool approval behavior. Installing either does not authorize edits or arbitrary tool-argument mutation.

A host that wants delayed folding must retain exact source observations and call the core again with the same `occurrence` and a later `requestCycle` when constructing the model request. The independent MCP server cannot add that hook itself.

## References used in edits

`resolve` accepts a complete JSON value and expands stored references in string values, not keys. It returns original text; it does not read the current source, authorize an action, or execute commands.

A host may resolve a folded source reference before sending a literal edit argument to another tool. Approval and validation must cover the **resolved final arguments**. The edit tool must still compare against the current file and reject a stale or nonunique match. Missing or ambiguous references stop dispatch rather than falling through as literal edit text.

MCP cannot intercept another tool. Without an explicit host integration, restore original source before editing.

## Configuration

Settings merge from defaults, the global `context-folding/config.toml`, the nearest `.context-folding.toml`, and explicit `Client(..., config=...)` overrides. Project search stops at a Git root. Invalid settings fail before opening the archive.

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
reserve_output_tokens = 0
# context_window_tokens = 128000

[annotations]
enabled = true
default_fold = true
keep = []

[gc]
enabled = false
```

The core also accepts the root plugin's `[magpie]` settings so a project can share one file; those settings do not install Magpie hooks. Remove old `folding.mode`, threshold/head/keep-recent controls, `[policy]` and accounting settings. They return migration errors, not a silent policy fallback.

The budget-related fields describe host capacity; the standalone archive does not count an unseen full model request. See the [root README](../README.md) for Magpie's estimate and its limits.

## SDKs and verification

The [Rust](sdks/rust/README.md), [TypeScript](sdks/typescript/README.md) and [C#](sdks/csharp/README.md) SDKs each keep one Python subprocess alive. They transport the same core protocol; they are not independent implementations of folding. Python must remain installed at runtime. Their examples use explicit annotations and request cycles.

Run the Python suite from the repository root:

```sh
uv run --project context-folding python -m unittest discover -s context-folding/tests -v
```

Bridge tests exercise ordered transport, errors, Unicode, process lifecycle and actual core integration when enabled. They do not use paid model inference or prove that a real host's default compaction has been replaced. Historical counts and benchmark results from previous versions remain historical evidence.
