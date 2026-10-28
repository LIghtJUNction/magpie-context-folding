# CLI, RPC and MCP transport contract

All three interfaces call the same local Python `Client` and SQLite archive. They do not run a model, select historical text, or create a network listener. **Only paired source comments select new folding regions.** `mark` and `group` have been removed.

Python 3.10+ is required; Python 3.10 also needs `tomli`. Runtime setup and source-language dependencies are described in the [subproject README](../README.md).

## Launch and state

From the repository root:

```sh
uv sync --project context-folding
uv run --project context-folding python -m context_folding status \
  --state /absolute/private/archive.sqlite --scope example
uv run --project context-folding python -m context_folding rpc --state /absolute/private/archive.sqlite
uv run --project context-folding python -m context_folding mcp --state /absolute/private/archive.sqlite
```

The installed `context-folding` command is equivalent to `python -m context_folding`. `--state` selects a SQLite file and may appear before or after the command. It is not a request field. Keep that file and its parent directory private and persistent.

Each core request requires a nonempty `scope` of at most 200 characters. Scopes separate local archive namespaces; they are not authentication. A reference is resolved only against the selected state file and scope. Configure process and file access at the host boundary.

## Single-call CLI

`call --json JSON` accepts a complete request. Omitting `--json`, or passing `--json -`, reads one JSON document from stdin; this single-call document may span multiple lines.

```sh
uv run --project context-folding python -m context_folding call \
  --state /absolute/private/archive.sqlite --json '{"action":"status","scope":"example"}'
```

Supported actions also have subcommands with `--scope`. Explicit flags override corresponding `--json` fields, and the subcommand determines the action:

```sh
uv run --project context-folding python -m context_folding read-source \
  --state /absolute/private/archive.sqlite --scope example \
  --path /project/module.py --occurrence read-1 --request-cycle 0

uv run --project context-folding python -m context_folding read \
  --state /absolute/private/archive.sqlite --scope example \
  --id ACTUAL_RETURNED_ID --offset 0 --limit 4000
```

`--request-cycle` maps to `requestCycle`; `--expand-mode` maps to `expandMode`; `--comment-styles` maps to `commentStyles`. `--text -` and `--body -` read raw UTF-8 stdin. JSON options such as `--value`, `--source`, `--config` and `--files` also accept `-`. Only one input can consume stdin per invocation. `put` reads raw stdin when no text is supplied. Use `--json` for core options without dedicated flags, for example `{"peek":true}`.

The CLI emits one JSON envelope, with no successful-operation banner:

```json
{"result":{"entries":0,"groups":0,"roots":0,"folded":0,"trashed":0,"offsetUnit":"unicode-code-points"}}
```

Application or input failures return `error` and exit 1; success exits 0. Argument usage errors exit 2, interruption exits 130, and broken output pipes terminate quietly.

## Explicit source projection

A source request selects exactly one of `text`, absolute UTF-8 regular-file `path`, or archived `id`. To change retained history later, use the archived ID or the exact previously read text: rereading a changed disk file is a new observation.

Only whole-line `@context-fold begin LABEL` / `@context-fold end LABEL` comments create regions. The same label and comment style must close the region. The core preserves unmarked text and malformed, mismatched, unclosed or nested regions, including their children. An earlier independently closed region remains eligible when a later region is damaged or still open; an orphan end marker remains literal. Source-editing commands use strict validation and reject any damaged existing marker before writing.

Python uses actual comment tokens; JS/TS requires optional Tree-sitter grammars; the generic literal fallback reports its lack of language parsing. The separate Magpie gateway uses a conservative Python/JS lexical filter and preserves a source read when complex constructs make comment boundaries ambiguous. Installing this Python transport does not extend the gateway's parser or intercept another host's tools.

### A request cycle is supplied by the host

`read-source` accepts:

| Field | Contract |
| --- | --- |
| `occurrence` | Nonempty string, at most 200 characters, identifying this appearance in retained history. A fresh read gets a new value. |
| `requestCycle` | Integer from 0 to 9,007,199,254,740,991. The host advances it for a new model-request cycle; a retry reuses the value. |
| `language` | Source language; inferred from supported path suffixes when available. |
| `keep` / `expand` | Exact region names, region IDs or `"*"`; selected content remains visible. |
| `mode` | `folded` or `original`. A folded view still obeys delay and keep protection. |
| `offset` / `limit` | Pagination of the returned view, in Unicode code points. |

Supply `occurrence` and `requestCycle` together. The first observation records its cycle. With the default `delay_requests = 1`, only a later cycle for the same occurrence can fold it. Repeating the same cycle does not consume delay; decreasing the cycle is an error. Changed source content resets the observation.

For example, send the following JSON object, replacing its illustrative source with the exact source being retained:

```json
{"action":"read-source","scope":"example","text":"# @context-fold begin investigation\n# Completed detail, repeated enough to make a reference shorter.\n# @context-fold end investigation\n","language":"python","occurrence":"read-1","requestCycle":0}
```

Its first response remains complete. Reproject the same immutable source and occurrence with `requestCycle: 1` when constructing the next model request. The core can then return:

```text
# @context-fold begin investigation
[[cf:v2:<actual-content-hash>]]
# @context-fold end investigation
```

The placeholder above is not a valid callable reference; use the returned text. A region is replaced only when its reference is shorter. No code or source file is edited.

Without a host cycle, the default returns original text with `delayReason: "host-request-cycle-required"`. While waiting for a later cycle, the reason is `waiting-for-request-cycle`. Explicit `delay_requests = 0` permits immediate projection. A one-shot tool-result adapter cannot implement later history replacement on its own.

`files` batches 1–100 source objects atomically. Outer fields supply defaults and per-file fields override them. A batch-level occurrence is expanded by file position; keep that order stable when reprojecting the batch. Explicit per-file occurrences take priority. Use a new batch occurrence for a new read, or provide a distinct stable occurrence for each retained file appearance, including identical contents read twice. A batch cannot also supply outer `text`, `path` or `id`; nested batches are rejected. Failure rolls back the complete batch.

## Recovery and references

A newly folded body uses `[[cf:v2:<hash>]]`. It identifies exact UTF-8 body bytes, without marker lines or the final physical newline left next to the reference. The stored SHA-256 is complete; the displayed prefix begins at 12 hexadecimal digits and lengthens when needed. Ambiguous prefixes fail with `ambiguous_hash`, never a guessed result.

Legacy `[[cf:v1:<entry-id>]]` references still resolve against their original entries. New source payload hashes and old entry IDs are different identifiers. Do not construct a v2 reference from an arbitrary old ID.

`read` returns original text by default and protects recovered annotated content from subsequent folding. `peek: true` inspects without adding that protection. For large content, follow `nextOffset` until null and join the pages. `sha256` and `totalChars` identify the selected complete view, while `text` is the current page. Source projections additionally return original metadata, folded-region references, parser information and limitations.

Offsets and limits always count **Python Unicode code points**, including through TypeScript and C# bridges. They are not UTF-8 byte offsets or JavaScript/.NET UTF-16 lengths. The separate Magpie plugin uses UTF-16 units; offsets cannot be transferred between implementations.

`resolve` expands references in string values inside a complete JSON value, without changing keys. It returns `value` and the substitution count `resolved`. Expansion is one pass: reference-looking strings inside archived originals remain data. Missing, malformed and ambiguous references produce an error. A legacy group manifest cannot substitute for source text.

`paste` writes exact original text, or a legacy group manifest, to an absolute new-file path using exclusive creation. Existing files and symlinks are not overwritten. It defaults to the complete remaining original; explicit offsets select a range.

## Remaining actions

| Action | Purpose |
| --- | --- |
| `annotate` | Save original source and discover explicit comment regions; no source-file edits. |
| `read-source` | Project an annotated source observation with host cycle information. |
| `read`, `resolve`, `paste` | Recover or export exact stored content. |
| `put` | Explicitly archive text, optional role and source provenance. It does not summarize or authorize folding. |
| `render` | Project selected archived entries using explicit annotations; `protected` IDs remain original. |
| `list` | Search/browse archived originals and legacy manifests, with pagination. |
| `status` | Return scoped counts and offset units. |
| `restore` | Recover visibility of an existing entry or legacy group. |
| `roots`, `pin`, `gc` | Host-controlled retention and cleanup. Defaults do not enable automatic collection. |
| `skills` | Inspect reuse evidence or export explicitly authored instructions with provenance. It does not install them. |

`mark`, `group`, and source `marks` are rejected. Old summary layers and groups remain recovery data only. Lifecycle strength settings are retention policies, not alternative compression modes. Do not remove data still needed by references in retained history.

## JSON Lines RPC

`rpc` reads one UTF-8 JSON request and returns one envelope per line, in order. It has no request IDs; a client must keep request/response pairing and serialize concurrent writes. A successful response contains `result`; a failed response contains `error`, never both.

```json
{"error":{"code":"invalid_request","message":"Source projection requires occurrence and requestCycle together"}}
```

Transport codes include `invalid_json`, `invalid_request`, `input_too_large` and `internal_error`. Core failures preserve their safe `code` and `message`. Malformed UTF-8/JSON and unexpected internal errors do not echo input or tracebacks. A single failed call does not close the service; EOF ends it normally.

## MCP stdio

MCP uses newline-delimited JSON-RPC 2.0, without `Content-Length` headers. Stdout contains protocol messages only. Initialize before tool discovery or calls:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example-host","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context_folding","arguments":{"action":"status","scope":"example"}}}
```

Supported protocol versions are `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. A supported requested version is echoed; otherwise the server proposes `2025-11-25`. Capabilities advertise tools only. `ping` returns an empty object. Valid notifications are silent and cannot perform archive operations.

`tools/list` returns one `context_folding` tool. Its schema requires action/scope and advertises the source occurrence/cycle fields. Core validation remains authoritative. A successful `tools/call` contains the raw core result serialized into `content[0].text`, with `isError: false`. An application failure uses `isError: true` and an ordinary `{"error":...}` envelope in that text.

Malformed JSON/UTF-8 produces `-32700`; invalid envelopes or oversized frames produce `-32600`; invalid parameters or unknown tool names produce `-32602`; unknown methods produce `-32601`; missing initialization produces `-32000`; unexpected server failures produce `-32603`. Errors use `id: null` where no usable request ID exists. Individual errors leave the stream open.

## Framing and resource limits

Requests are limited to 8 MiB per frame or single-call input. Oversized lines are drained through their newline in bounded chunks, yielding one error before accepting the next frame. LF, CRLF and a final frame without newline are accepted. Embedded newlines inside strings must be JSON escaped.

Empty lines, batch arrays, malformed UTF-8 and `NaN`/`Infinity` literals are rejected. Core text, archive and operation limits may be smaller than the transport frame limit. Output is compact JSON plus LF, flushed immediately; non-ASCII escaping preserves decoded Unicode values.

## SDK and host responsibilities

Rust, TypeScript and C# clients each keep one Python subprocess alive and transport this protocol. Generic `call` / `CallAsync` forwards `read-source`, including occurrence/cycle fields; wrappers for archive reads do not infer request progress. A bridge knows its RPC calls, not the host's model requests.

A host must retain the original source observation, choose its occurrence identity, update request cycles, and apply returned views to the correct editable history slots. Installing MCP or a skill provides none of those hooks. The server does not replace the host's default compaction.

When a tool argument intentionally contains a fold reference, an integrating host may resolve the **final argument value** and submit the resolved value through normal approval and current-file checks. Do this only when reference expansion is needed. Do not add an extra resolve call before unrelated tool calls, and do not forward unresolved references after an error.

The SDKs serialize calls to preserve ordered RPC pairing. Application errors leave the process usable; malformed responses or process failure close it. TypeScript/C# queued cancellation preserves the stream, while cancellation after dispatch closes it because the protocol has no remote cancellation IDs. See each SDK README for its runtime and disposal details.

## Validation

```sh
uv run --project context-folding python -m unittest discover \
  -s context-folding/tests -p test_transport.py -v
```

The transport tests use real local subprocesses and SQLite. SDK tests separately cover their process bridges and optional actual-core calls. These checks do not run a paid model or establish real-host compaction or billing results.
