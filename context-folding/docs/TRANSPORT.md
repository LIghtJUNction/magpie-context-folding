# ctxf CLI and SDK RPC contract

One Python engine owns folding, bounded queries and the selected SQLite archive. CLI, RPC and SDKs do not implement separate stores or request-history rewriting. Queries leave fold/keep state unchanged.

## Launch and state

```sh
uv tool install ./context-folding
ctxf rpc --state /absolute/private/archive.sqlite3
```

For development, use `uv sync --project context-folding` and `uv run --project context-folding ctxf ...`. Python 3.10+ is required; 3.10 also needs `tomli`.

`ctxf` uses `--state`, then `CTXF_STATE`, then `$XDG_DATA_HOME/context-folding/archive.sqlite3` or `~/.local/share/context-folding/archive.sqlite3`. State is a persistent SQLite file selected outside the request. SDK clients select that file explicitly. Share both state and scope when querying a reference through another interface.

CLI operations default to scope `default`; `--scope` overrides it. API/RPC requests require a nonempty scope of at most 200 characters. RPC does not accept a process-wide default scope. Scopes are local namespaces, not OS authentication.

## CLI

### Fold raw text

```sh
cat notes.txt | ctxf > notes.folded.txt
ctxf fold --language python < module.py > module.folded.txt
ctxf fold --json < notes.txt
```

No subcommand means `fold`. Input is UTF-8 text; empty input is valid. Default stdout is the complete folded view, with no added newline, pagination or JSON envelope. `fold --json` emits the bare core result object. Original bodies and child relationships are committed before a reference is returned.

Folding uses explicit paired markers, including legal nesting. Unmarked text, unsafe regions and existing reference literals remain unchanged. Only representations that reduce UTF-8 byte length are published. Explicit `fold` is immediate and independent of automatic projection's enabled/default_fold/keep/delay settings; archive limits still apply.

### Query small views

```sh
ctxf list [ID] --depth 1 --limit 10
ctxf meta ID
ctxf grep PATTERN [ID] --context 0 --limit 10
ctxf read ID --lines A:B --limit 1200
```

Square brackets denote optional arguments, not literal shell syntax. ID accepts an archive ID or an unambiguous hash prefix. `--id ID` and `--query PATTERN` remain equivalent flag forms. `--state` / `--scope` may appear before or after single-operation commands.

| Command | Default stdout | Bounds and traversal |
| --- | --- | --- |
| `fold` | Complete folded text | Explicit transformation; not a query page. |
| `list` | One short directory entry per line | 10 entries; `--depth` defaults to 1, maximum 64. |
| `grep` | `id:line` followed by a tab and snippet | 10 literal matches; recursive by default; `--no-recursive` stays at the selected node. |
| `read` | Bounded node text, with child references | 1200 characters; `--lines A:B` selects inclusive 1-based view lines. |
| `meta` | Compact JSON metadata | No body; child ID pages default to 10. |
| `status` | Compact status | No body. |

`list --recursive` traverses the complete descendant tree in bounded pages; explicit `--depth` narrows traversal. List/grep/meta limits are 1–100; read limits are 1–24000. `--offset` selects a later result page or character slice. Read line selectors cannot be combined with offset. `grep --context N` accepts 0–3 neighboring lines; each line snippet is at most 160 characters, centered near a match when needed.

Query `--json` emits the bare core result, including `nextOffset`. Default text output puts only `nextOffset=N` continuation hints on stderr; stdout remains data. `read --raw` is a bounded text alias, not a request to fetch every page. Select another range only when the task needs it.

```sh
ctxf list --json | jq -r '.entries[].id'
ctxf grep timeout HASH --limit 5 | rg parser
ctxf read HASH --lines 4:9 | sed -n '1,3p'
```

Operation errors use a nonzero exit status and stderr in the new text workflow. Errors do not become folded text. Usage errors exit 2; interruption exits 130; broken pipes terminate quietly.

### Compatibility input

`ctxf` exposes `fold/list/grep/read/meta/status/rpc/call` alongside explicit compatibility management commands. `ctxf call --json JSON` is still a complete request-input interface; omitted JSON or `--json -` reads stdin. Explicit `--scope` overrides the request scope; otherwise the JSON scope is retained, with `default` used if missing.

The old `context-folding` executable and `python -m context_folding` retain their explicit command/state arguments and input `--json JSON`. Their compatibility actions normally emit `{"result":...}` or `{"error":...}` envelopes. Do not confuse that input option with the new query commands' boolean output `--json`.

Legacy core/RPC export, recovery and lifecycle actions remain available to existing integrations where supported. They are separate from the normal bounded query workflow.

## Shared query API

All requests contain `action` and `scope`. Limits apply to returned views, not to how much original material a model should routinely receive.

| Action | Request fields | Result |
| --- | --- | --- |
| `fold` | `text`; optional `language`, `commentStyles` | `scope`, complete `text`, top-level `references`. |
| `list` | Optional `id`, `depth`, `recursive`, `offset`, `limit` | `entries`, `nextOffset`; entries identify nodes and hierarchy without opening bodies. |
| `meta` | `id`; optional `offset`, `limit` | Original `sha256`, `chars`, `bytes`, `label`, `childCount`, bounded `children` IDs, `nextOffset`. |
| `grep` | `query`; optional `id`, `recursive`, `context`, `offset`, `limit` | `matches`, `nextOffset`; each match has node `id`, `label`, view `line`, bounded `text`, its zero-based `textOffset` within the line, and optional neighboring lines. |
| `read` | `id`; optional `offset`, `limit` **or** `startLine`, `endLine`, `limit` | `text` plus view pagination, line metadata, original hash, view hash and child count. |
| `status` | No additional fields | Archive counts and offset units. |

`fold.references[]` contains full-SHA `id`, `sha256`, `label`, short `reference` and `archiveId`. Only top-level references in the returned text are listed. Descendants are discovered through list/meta. Query results use actual archive IDs; input IDs may also be unambiguous short hashes. Existing v1 archive references remain compatible data.

`read.text` is a node view: direct child bodies remain `[[cf:v2:HASH]]` references. `sha256` covers the exact original body; `viewSha256` covers the complete view. `offset`, `nextOffset`, `totalChars`, `totalLines`, `startLine` and `endLine` refer to that view. Python offsets count Unicode code points, not UTF-8 bytes or JavaScript/.NET UTF-16 units. Magpie's separate implementation uses UTF-16 offsets.

Read/grep/list/meta do not set keep, unfold ancestors or change future history projection. Recursive grep searches node views internally and deduplicates visited nodes; it does not return a recursively expanded body. `peek` is unnecessary for this behavior.

## Markers, nesting and source integrations

Markers are whole-line `@context-fold begin LABEL` / `@context-fold end LABEL` comments with matching labels and shells. Legal nesting forms a tree. Crossed, malformed or unclosed regions are preserved locally; earlier complete regions remain eligible. Strict source-editing helpers still reject damaged input before writing.

Original SHA-256 uses exact UTF-8 body bytes, excluding marker lines and one final physical newline retained beside a reference. Parent originals include original child text. Visible hash prefixes start at 12 hex digits and lengthen on collisions; ambiguous prefixes fail instead of selecting a node arbitrarily.

Python uses actual comment tokens; JS/TS requires optional Tree-sitter grammars. Generic literal parsing has no language lexer. The separate Magpie gateway uses a conservative Python/JS filter and may preserve complex or ambiguous syntax that the standalone parser supports.

The host-only `read-source` API remains separate from queries. It accepts one of source `text`, absolute regular-file `path`, or archived `id`, plus paired `occurrence` and `requestCycle` fields for delayed replay. First complete observation stays visible; default delay 1 permits a later cycle to fold. A retry keeps its cycle, a fresh Read gets a fresh occurrence, decreased cycles fail, and changed content restarts observation. Without both fields the default preserves original input. Explicit delay 0 permits immediate source projection.

`files` batches 1–100 source observations atomically. Outer defaults may be overridden per file; batch occurrences are derived by stable file position unless each file supplies one. No source projection writes the file. A one-shot tool-result adapter cannot add history replay itself.

## JSON Lines RPC

`ctxf rpc` reads one UTF-8 JSON object and returns one envelope per line in order:

```json
{"action":"grep","scope":"task","id":"ACTUAL_HASH","query":"timeout","limit":3}
```

Successful envelopes contain `result`; failures contain `error` with `code` and `message`, never both. The protocol has no request IDs, so clients serialize writes and preserve pairing. Application errors leave the process usable; EOF ends it normally.

Frames and single-call JSON input are limited to 8 MiB. Oversized lines are drained in bounded chunks before accepting the next frame. LF, CRLF and an unterminated final frame are accepted. Newlines inside strings must be escaped. Empty lines, arrays, invalid UTF-8/JSON and `NaN`/`Infinity` are rejected. Errors do not echo raw input or tracebacks. Output is compact JSON plus LF.

## Removed MCP transport

MCP registration, schema and stdio serving have been removed. `ctxf mcp` and `python -m context_folding mcp` exit with migration guidance before opening the archive. Use CLI commands through the host shell, or ordered JSON Lines RPC for an SDK. A literal option value such as `--scope mcp` remains valid data.

## SDK and validation

Rust, TypeScript and C# clients keep one Python subprocess alive. Their fold/list/grep/read/meta wrappers forward the same fields and results; generic calls remain available for host integrations. They do not infer model-request cycles or implement another archive.

Application errors preserve transport. Malformed responses or process failure close it. TypeScript/C# cancellation while queued preserves the stream; cancellation after dispatch closes it because RPC has no cancellation IDs. See each SDK README for lifecycle details.

```sh
uv run --project context-folding --extra javascript python -m unittest discover -s context-folding/tests -v
```

These tests use local subprocesses and SQLite. SDK actual-core tests are separate; neither proves interactive host compaction or billing savings.
