# ctxf — fold once, query small

Write explicit folding comments, keep the resulting references in context, and inspect the archive only as needed. Queries do not unfold history or set `keep`. Nested regions stay navigable through child references.

The CLI, Python API, MCP server and Rust/TypeScript/C# bridges use one Python engine and the selected SQLite archive. The separate [Magpie plugin](../README.md) uses its own store; references must be queried in the backend that created them. Root source version: 0.4.0, unpublished to npm. This Python package remains 0.1.0 in the matching checkout.

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

Default state is `CTXF_STATE`, otherwise `$XDG_DATA_HOME/context-folding/archive.sqlite3` or `~/.local/share/context-folding/archive.sqlite3`. Override it with `--state`. Scope defaults to `default`; `--scope` separates tasks. Queries use the same state and scope as folding. State is a file, not a directory; new files are private and persist after process exit. API/RPC/MCP calls always supply scope explicitly.

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

## MCP and RPC

```json
{"mcpServers":{"ctxf":{"command":"ctxf","args":["mcp"]}}}
```

`ctxf mcp` exposes one `context_folding` tool with six actions: `fold`, `list`, `grep`, `read`, `meta`, `status`. For example:

```json
{"action":"grep","scope":"task","id":"ACTUAL_HASH","query":"timeout","limit":3}
```

The host consumes the result. MCP cannot edit earlier messages or replace compaction. `ctxf rpc` exposes ordered JSON Lines over the same engine. Neither starts a network listener.

`ctxf call --json JSON` remains a complete request-input interface. The old `context-folding` executable and `python -m context_folding` preserve compatibility arguments, including input `--json JSON`. Legacy archive, export and recovery actions may remain in core/RPC for maintenance, but are absent from the new MCP tool and ordinary Agent workflow. See [TRANSPORT.md](docs/TRANSPORT.md) and [protocol.json](protocol.json).

## Configuration

Settings merge from defaults, global `context-folding/config.toml`, nearest `.context-folding.toml`, and explicit client options. Project discovery stops at a Git root.

```toml
version = 1
[folding]
enabled = true
delay_requests = 1
max_session_bytes = 67108864
```

These fields govern automatic projection and capacity. Querying a node does not opt it out of folding. Remove old mode, threshold, policy and accounting settings; they return migration errors. Budget capacity fields describe the host, not an unseen request counted by this archive.

## SDKs and verification

[Rust](sdks/rust/README.md), [TypeScript](sdks/typescript/README.md) and [C#](sdks/csharp/README.md) clients are subprocess bridges, not separate folding engines. Examples fold a nested region, inspect metadata, search and read a small slice. Configure an explicit archive path and Python interpreter.

```sh
uv run --project context-folding python -m unittest discover -s context-folding/tests -v
```

Tests cover core behavior and local transports; SDK real-core tests are opt-in. These checks do not prove interactive host compaction or billing savings. Historical benchmark results remain historical evidence.
