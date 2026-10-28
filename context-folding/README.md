# ctxf — fold once, query small

Write explicit folding comments, keep the resulting references in context, and inspect the archive only as needed. Queries do not unfold history or set `keep`. Nested regions stay navigable through child references.

The CLI, Python API, JSON Lines RPC and Rust/TypeScript/C# bridges use one Python engine and the selected SQLite archive. They make no model calls or network requests. The separate [Magpie plugin](../README.md) uses its own store; references must be queried in the backend that created them. The root plugin source is 0.5.0 and has not been published to npm; this Python package remains 0.1.0 in the matching checkout.

## Install and use

Python 3.10+ is required; 3.10 also needs `tomli`. From the repository root:

```sh
uv tool install ./context-folding
cat notes.txt | ctxf > notes.folded.txt
ctxf list
ctxf meta HASH
ctxf list HASH --depth 2
ctxf grep timeout HASH --limit 3
ctxf read HASH --lines 4:9
```

Replace `HASH` with an actual reference or returned ID. For development, use `uv sync --project context-folding`, then prefix commands with `uv run --project context-folding`.

`ctxf` defaults to `fold`: UTF-8 stdin to complete folded text on stdout, without an added newline. `ctxf fold --json` returns `{scope,text,references}`. Empty and unmarked text pass through. Only a shorter UTF-8 representation is published, after originals have been committed.

Default state is `CTXF_STATE`, otherwise `$XDG_DATA_HOME/context-folding/archive.sqlite3` or `~/.local/share/context-folding/archive.sqlite3`. Override it with `--state`. Scope defaults to `default`; `--scope` separates tasks. Queries use the same state and scope as folding. State is a file, not a directory; new files are private and persist after process exit. API/RPC calls always supply a stable scope of 1–200 characters explicitly. The scope is a local namespace, not authentication; file and process permissions remain the host's responsibility.

## Query the archive

| Command | Default result |
| --- | --- |
| `ctxf list [ID]` | Up to 10 directory entries; `--depth` controls subtree traversal. |
| `ctxf meta ID` | Compact JSON: original hash/size and a bounded list of child IDs. |
| `ctxf grep PATTERN [ID]` | Up to 10 literal matches, recursively searched inside the archive. |
| `ctxf read ID` | Up to 1200 characters from this node's view; child bodies remain references. |
| `ctxf status` | Short archive status. |

Use `read --lines A:B` for inclusive, 1-based view lines, or `--offset` / `--limit` for a character slice. Do not combine line selection with an offset. `grep --context 1` includes neighboring lines; `--no-recursive` stays at the selected node. Search snippets are capped at 160 characters per line. `list --depth` defaults to 1 and allows 0–64; list/grep limits default to 10 and allow up to 100. `list --recursive` traverses descendants in pages; use a small limit or explicit depth.

`--json` returns the bare structured result for these commands. Default read/list/grep output is concise, pipeable text. A truncated query prints only `nextOffset=N` on stderr; stdout remains data. `read --raw` is a compatibility alias for the same bounded text output. It never drains every page automatically.

```sh
ctxf list --json | jq -r '.entries[].id'
ctxf grep timeout HASH --limit 5 | rg parser
ctxf read HASH --lines 4:9 | sed -n '1,3p'
```

`read`, `grep`, `list` and `meta` do not change fold/keep state or rewrite history. Query the next page or a child only when needed. Original `sha256` and `viewSha256` are different: the former covers archived bytes; the latter covers the node view containing child references. Line numbers and offsets refer to the view. Python offsets count Unicode code points, including through C# and TypeScript; Magpie uses UTF-16 units.

## Markers and nesting

Use whole-line matching comments. Text may use HTML comments; source uses the language's comment shell:

```text
<!-- @context-fold begin investigation -->
Current layer's explanation.
<!-- @context-fold begin trace -->
Detailed observations that can be searched without putting them back into history.
<!-- @context-fold end trace -->
<!-- @context-fold end investigation -->
Active decisions and next steps remain outside.
```

Legal nesting forms a parent/child tree. `fold` publishes top-level references; discover descendants with `list` or `meta`, or search them with recursive `grep`. Unclosed, crossed or malformed regions remain visible without invalidating earlier complete regions. No function, old version or similar text is selected automatically.

References use `[[cf:v2:HASH]]`, normally the first 12 SHA-256 hex digits, lengthened on collisions. Hashes cover exact original body UTF-8 bytes, excluding the outer marker lines and one final physical newline retained beside the reference. A parent hash covers its original child text. Content changes create new snapshots; old references still identify old content.

`fold` API fields are `scope`, `text` (empty is valid), and optional `language` / `commentStyles`. It is an explicit immediate conversion, independent of automatic projection's enabled/delay/keep settings. Archive quotas and integrity checks still apply. The result includes top-level `references` with full-SHA `id`, `sha256`, `label`, short `reference` and `archiveId`. Query results use archive IDs; inputs also accept unambiguous content-hash prefixes.

## Source annotations and compact reads

Python uses real `#` comment tokens. JS/JSX/TS/TSX uses optional Tree-sitter grammars:

```sh
uv sync --project context-folding --extra javascript
```

Other languages use literal whole-line parsing and may misidentify marker-shaped text inside multiline strings. `commentStyles` adds literal shells, not language lexers. The Magpie gateway has a separate conservative Python/JS filter and may retain complex f-strings, JSX or ambiguous template expressions that this standalone parser can handle.

A host retaining source history can use `read-source` with both `occurrence` and `requestCycle`. The first closed observation stays complete; default delay 1 permits projection in a later cycle. Retries reuse the cycle; a fresh Read gets a new occurrence. Missing host-cycle information preserves the original. This delayed path is separate from immediate `fold` and bounded archive queries.

```python
from pathlib import Path
from context_folding import Client

with Client("/absolute/private/archive.sqlite") as client:
    result = client.fold("task", Path("notes.txt").read_text(encoding="utf-8"))
    if result["references"]:
        parent = result["references"][0]["id"]
        print(client.meta("task", parent))
        print(client.grep("task", "timeout", id=parent, limit=3))
        print(client.read("task", parent, startLine=1, endLine=4, limit=240))
```

`annotate-functions` remains an explicit source-editing helper under the compatibility CLI: preview before `--apply`, respect edit scope and validate the program. Reading never writes markers to disk. Do not write compact views into source files.

The [Pi adapter](adapters/pi/README.md) and Claude post-tool hook see one completed Read, not later requests. Default delay therefore preserves full input. Delay 0 can produce an immediate source view. Claude's bound helper `python3 scripts/claude-read.py` exposes the same `list/grep/read/meta` queries without revealing its session binding; `expand` is retained only for explicit legacy recovery. Neither adapter implements host history replay or automatically unfolds earlier messages.

## CLI and SDK RPC

`ctxf call --json JSON` accepts a complete request; omitted JSON or `--json -` reads stdin. Explicit `--scope` overrides its scope, otherwise the JSON scope is retained. Normal `ctxf read/list/grep/meta --json` selects structured output and is a boolean flag. The old `context-folding` executable and `python -m context_folding` preserve their compatibility request-input `--json JSON` option.

SDK subprocesses use the same archive:

```sh
ctxf rpc --state /absolute/private/archive.sqlite3
```

RPC exchanges one request and one result/error envelope per line, in order. For example:

```json
{"action":"grep","scope":"task","id":"ACTUAL_HASH","query":"timeout","limit":3}
```

MCP support has been removed. Remove old `ctxf mcp` client configurations and invoke CLI commands through the host shell instead. RPC is a local SDK subprocess transport; it opens no network listener and does not rewrite host history. See [TRANSPORT.md](docs/TRANSPORT.md) and [protocol.json](protocol.json).

Legacy export, explicit recovery and lifecycle actions remain available through CLI/API/RPC for host integrations. `roots`, `pin` and `gc` retain and clean archives; they are not folding modes. Automatic collection is disabled by default. Keep originals while their references remain in use.

`resolve` expands references in a supplied JSON value's strings, not keys. It returns archived text without reading current source, authorizing edits or executing commands. A host resolving references into edit arguments must validate the resolved final arguments and use normal approvals and current-file checks. Missing, ambiguous or stale references must stop dispatch. The ordinary query workflow reads only needed views and leaves historical folds intact.

## Configuration

Settings merge from defaults, the global `context-folding/config.toml`, the nearest `.context-folding.toml`, and explicit `Client(..., config=...)` overrides. Project search stops at a Git root. Invalid settings fail before opening the archive.

```toml
version = 1

[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
# Shared Magpie request options (the standalone fold command does not use them):
min_savings_tokens = 256

[annotations]
enabled = true
default_fold = true
keep = []

[gc]
enabled = false
```

The core also accepts the root plugin's `[magpie]` settings (`shell_tool_name`, `recovery_command`, `gateway_timeout_ms`) so a project can share one file; those settings do not install Magpie hooks. The removed `magpie.recovery_tool_name` setting produces migration guidance. Remove old `folding.mode`, threshold/head/keep-recent controls, `[policy]` and accounting settings. They return migration errors, not a silent policy fallback.

The `min_savings_tokens` setting applies to Magpie request projection; the explicit Python `fold` command keeps its byte-saving check and adds no model prompt. Model context capacity and output-reserve budgeting are not managed by this project. Remove the retired `context_window_tokens`, `reserve_output_tokens` and `budget_hints` keys; loading them returns a migration error. See the [root README](../README.md) for Magpie's estimate and its limits.

## SDKs and verification

[Rust](sdks/rust/README.md), [TypeScript](sdks/typescript/README.md) and [C#](sdks/csharp/README.md) clients are subprocess bridges, not separate folding engines. Examples fold a nested region, inspect metadata, search and read a small slice. Configure an explicit archive path and Python interpreter.

```sh
uv run --project context-folding --extra javascript python -m unittest discover -s context-folding/tests -v
```

The `javascript` extra installs the optional JS/TS parser dependencies so those tests run instead of skipping. Tests cover core behavior and local transports; SDK real-core tests are opt-in. These checks do not prove interactive host compaction or billing savings. Historical benchmark results remain historical evidence.
