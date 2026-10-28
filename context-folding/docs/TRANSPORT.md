# CLI, file and local RPC contract

CLI, Python API and local JSON Lines RPC call the same Python `Client`, ordinary snapshot files and SQLite index. They do not run a model, select historical text, or create a network listener. **Explicit ranges or paired folding comments select new regions** in submitted text or history. `mark` and `group` have been removed.

Python 3.10+ is required; Python 3.10 also needs `tomli`. Runtime setup and source-language dependencies are described in the [subproject README](../README.md).

## Launch and state

From the repository root:

```sh
uv sync --project context-folding
uv run --project context-folding ctxf status \
  --state /absolute/private/archive.sqlite --scope example
uv run --project context-folding ctxf rpc --state /absolute/private/archive.sqlite
```

Install `ctxf` on PATH with `uv tool install ./context-folding`. The old `context-folding` command and `python -m context_folding` retain their explicit command/state arguments and JSON management behavior. All three use the Python implementation; only `ctxf` adds the pipe-friendly defaults, and the root Bun plugin does not install another `ctxf`.

`--state` selects a SQLite file and may appear before or after the command. It is not a request field. `ctxf` uses `CTXF_STATE` when no flag is given; otherwise it defaults to `$XDG_DATA_HOME/context-folding/archive.sqlite3`, or `~/.local/share/context-folding/archive.sqlite3` when XDG is unset. Keep that file and its parent directory private and persistent. RPC processes and SDK clients must point to the same state file to share references.

Each core/API/RPC request requires a nonempty `scope` of at most 200 characters. CLI action commands default to `default`; `--scope` overrides that value before or after the command. Scopes separate local archive namespaces; they are not authentication. A reference is resolved only against the selected state file and scope. Configure process and file access at the host boundary.

## Raw text folding

With no subcommand, `ctxf` performs `fold`. Both forms read raw UTF-8 text from stdin:

```sh
cat notes.txt | ctxf
ctxf fold < notes.txt > notes.folded.txt
ctxf fold --scope investigation --json < notes.txt
```

Raw output is the **complete** folded text, without JSON framing, pagination or an added newline. Empty input is valid. `fold --json` is a boolean output switch and emits the bare core result object, not a `{"result":...}` envelope.

`fold` and `read --raw` report operation errors on stderr with a nonzero exit status. They collect a successful result before writing it, so failed recovery or folding does not write a JSON error into the text pipeline.

The API/RPC operation is:

```json
{"action":"fold","scope":"investigation","text":"<!-- @context-fold begin evidence -->\nCompleted observations and comparisons that remain recoverable after folding.\n<!-- @context-fold end evidence -->"}
```

`text` is required, including for an empty string. Optional `language` and `commentStyles` use the same parser contract as source annotations. The returned object contains:

| Field | Meaning |
| --- | --- |
| `scope` | The archive namespace used for this call. |
| `text` | The complete projected input. Unmarked text and unsafe marker regions stay visible. |
| `references` | Bodies actually folded by this call. Existing reference literals are not new entries in this list. |
| `references[].id` / `sha256` | The complete SHA-256 of the marked body. |
| `references[].label` | The marker label, when selection uses annotations. |
| `references[].reference` | The `[[cf:v3:HASH path="/absolute/file.txt"]]` string inserted into the returned text. |
| `references[].path` | Absolute UTF-8 file containing the exact selected text. |
| `references[].archiveId` | The backing archive entry identifier. |

`fold` is an explicit immediate conversion. It does not require or manufacture an `occurrence` or `requestCycle`, and does not change `read-source`'s default delay. Automatic-projection `enabled`, `default_fold`, `keep` and delay settings do not suppress this explicitly requested conversion; archive quotas and safety checks still apply. Marker-driven selection replaces only bodies whose references reduce UTF-8 byte length; an explicit range honors the requested selection even if the locator is longer. Both save originals before returning references. Existing references remain literal rather than being recursively folded.

Recover one marked body using the same state and scope:

```sh
ctxf read --scope investigation --id ACTUAL_RETURNED_HASH --raw > original-body.txt
```

Without `--raw`, `read` retains the existing JSON envelope and page metadata. With `--raw` and no range options, the CLI follows pagination and writes the complete original without adding a newline. An explicit `--offset` starts later; `--limit` intentionally returns only the selected page. `resolve` can reconstruct the complete submitted text by replacing references in a folded view; a single `read` returns only its referenced body.

## Single-call CLI

`call --json JSON` accepts a complete request. Omitting `--json`, or passing `--json -`, reads one JSON document from stdin; this single-call document may span multiple lines.

```sh
ctxf call \
  --state /absolute/private/archive.sqlite --json '{"action":"status","scope":"example"}'
```

Existing actions also have subcommands with `--scope`. Explicit flags override corresponding `--json` fields, and the subcommand determines the action:

```sh
ctxf read-source \
  --state /absolute/private/archive.sqlite --scope example \
  --path /project/module.py --occurrence read-1 --request-cycle 0

ctxf read \
  --state /absolute/private/archive.sqlite --scope example \
  --id ACTUAL_RETURNED_ID --offset 0 --limit 4000
```

`--request-cycle` maps to `requestCycle`; `--expand-mode` maps to `expandMode`; `--comment-styles` maps to `commentStyles`. `--text -` and `--body -` read raw UTF-8 stdin. JSON options such as `--value`, `--source`, `--config` and `--files` also accept `-`. Only one input can consume stdin per invocation. `put` reads raw stdin when no text is supplied. Existing commands retain `--json JSON` as request input, for example `{"peek":true}`; this is distinct from the new `fold --json` output switch.

These existing commands emit one JSON envelope unless an explicit raw output option is used, with no successful-operation banner:

```json
{"result":{"entries":0,"groups":0,"roots":0,"folded":0,"trashed":0,"offsetUnit":"unicode-code-points"}}
```

Application or input failures return `error` and exit 1; success exits 0. Argument usage errors exit 2, interruption exits 130, and broken output pipes terminate quietly.

## Explicit substring and message ranges

`fold` accepts `range: {"start": N, "end": M}` or the paired top-level `start` and `end` fields. Both boundaries are zero-based Unicode code points, with an exclusive end; reversed, empty, out-of-bounds or incompatible selections fail. This explicit range operation does not require markers and honors short selections even when the locator is longer than the original text.

```sh
ctxf fold --range '{"start":100,"end":800}' < notes.txt
ctxf fold --start 100 --end 800 --json < notes.txt
ctxf fold-messages --messages - \
  --range '{"start":{"message":0},"end":{"message":3}}' < messages.json
```

`fold-messages` consumes a JSON message array via `--messages`, including `-` for stdin. The API/RPC request uses `action`, `scope`, `messages` and `range`. A position is `{ "message": index, "offset": codePoints }`; omitted offset means the boundary before that message, and an end message index equal to array length means end of history. Partial selection requires a string `content` and no tool calls. Structured content is atomic. The core rejects a selection that leaves unmatched tool calls/results or tries to fold protected or unsupported structures, and does not silently widen the selection.

The result has `scope`, `messages` and `references`. One user archive notice replaces the selected range, with any unselected prefix and suffix preserved. Each conversation reference includes `id`, `sha256`, `archiveId`, `reference`, `path`, `messagesPath`, `range` and `offsetUnit`. `path` locates the readable transcript and `messagesPath` locates the lossless JSONL. The reference token points to the JSONL, whose complete SHA-256 identifies the snapshot. JSONL preserves original message objects and range bounds; text is a readable rendering with role provenance.

The placeholder is archival data, not a new instruction carrying the authority of prior assistant or tool text. The caller must preserve the original transcript and explicitly use the returned message array; a subprocess cannot rewrite a host UI or hidden provider history.

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
[[cf:v3:<actual-content-hash> path="/absolute/archive.txt"]]
# @context-fold end investigation
```

The placeholder above is not a valid callable reference; use the returned text. A region is replaced only when its reference is shorter. No code or source file is edited.

Without a host cycle, the default returns original text with `delayReason: "host-request-cycle-required"`. While waiting for a later cycle, the reason is `waiting-for-request-cycle`. Explicit `delay_requests = 0` permits immediate projection. A one-shot tool-result adapter cannot implement later history replacement on its own.

`files` batches 1–100 source objects atomically. Outer fields supply defaults and per-file fields override them. A batch-level occurrence is expanded by file position; keep that order stable when reprojecting the batch. Explicit per-file occurrences take priority. Use a new batch occurrence for a new read, or provide a distinct stable occurrence for each retained file appearance, including identical contents read twice. A batch cannot also supply outer `text`, `path` or `id`; nested batches are rejected. Failure rolls back the complete batch.

## Recovery and references

A newly folded body uses `[[cf:v3:<hash> path="/absolute/file.txt"]]`; the path is JSON-quoted. It identifies exact UTF-8 body bytes, without marker lines or the final physical newline left next to the reference. The stored SHA-256 is complete; the displayed prefix begins at 12 hexadecimal digits and lengthens when needed. Ambiguous prefixes fail with `ambiguous_hash`, never a guessed result.

Legacy v1 entry references and v2 hash references still resolve against their original entries. New source payload hashes and old entry IDs are different identifiers. Use actual returned references rather than constructing them from old IDs.

`read` returns original text by default and protects recovered annotated content from subsequent folding. `peek: true` inspects without adding that protection. For large content, follow `nextOffset` until null and join the pages. `sha256` and `totalChars` identify the selected complete view, while `text` is the current page. Source projections additionally return original metadata, folded-region references, parser information and limitations.

Offsets and limits always count **Python Unicode code points**, including through TypeScript and C# bridges. They are not UTF-8 byte offsets or JavaScript/.NET UTF-16 lengths. The Magpie plugin’s new conversation ranges also use code points; its legacy archive pagination uses UTF-16 units. Do not transfer pagination offsets between those operations.

`resolve` expands references in string values inside a complete JSON value, without changing keys. It returns `value` and the substitution count `resolved`. Expansion is one pass: reference-looking strings inside archived originals remain data. Missing, malformed and ambiguous references produce an error. A legacy group manifest cannot substitute for source text.

`paste` writes exact original text, or a legacy group manifest, to an absolute new-file path using exclusive creation. Existing files and symlinks are not overwritten. It defaults to the complete remaining original; explicit offsets select a range.

## Remaining actions

| Action | Purpose |
| --- | --- |
| `fold` | Immediately transform an explicit text range or comment region and return a complete view with file references. |
| `fold-messages` | Save an explicit message range and return one user archive notice between retained boundary fragments. |
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

## File retrieval instead of MCP

The `mcp` command and MCP server have been removed. There is no initialize, tool discovery or recovery-server configuration. Read or search the returned archive path through the host's existing file and terminal tools. JSON Lines RPC remains a private subprocess transport for SDK callers; it is not MCP.

Files live below `<state>.files/<sha256(scope UTF-8)>/`. An annotated or explicit text range writes `<text-sha256>.txt`; a conversation writes `<jsonl-sha256>.jsonl` plus a readable `<jsonl-sha256>.messages.txt`. New files are private and published atomically only after complete writes. Existing snapshots are checked rather than overwritten. The original is saved before a folded response can be returned; failed storage or validation does not justify removing input.

Legacy SQLite reads attempt file publication; on file I/O failure they still return original text, omit the unavailable path and set `fileStatus: "unavailable"`. This fallback applies only to recovery, never to new folds. A direct file read has no keep/restore side effect. The ordinary CLI/API `read` command still changes keep state by default. Hosts must make the path reachable in the agent's actual filesystem; a path on a gateway host does not automatically exist inside a remote sandbox. When a large archive needs interpretation, delegate a precise question to a lightweight subagent and request relevant facts with file/line evidence. Avoid loading all archived history for a small lookup.

## Framing and resource limits

JSON requests are limited to 8 MiB per frame or single-call input. Oversized lines are drained through their newline in bounded chunks, yielding one error before accepting the next frame. LF, CRLF and a final frame without newline are accepted. Embedded newlines inside strings must be JSON escaped.

Empty lines, batch arrays, malformed UTF-8 and `NaN`/`Infinity` literals are rejected. Core text, archive and operation limits may be smaller than the transport frame limit. Output is compact JSON plus LF, flushed immediately; non-ASCII escaping preserves decoded Unicode values.

## SDK and host responsibilities

Rust, TypeScript and C# clients each keep one Python subprocess alive and transport this protocol. Their `fold(scope, text, fields)` / `FoldAsync` wrappers forward the immediate action without implementing another folding engine. Generic `call` / `CallAsync` forwards `read-source`, including occurrence/cycle fields; wrappers for archive reads do not infer request progress. A bridge knows its RPC calls, not the host's model requests.

A host must retain the original source observation, choose its occurrence identity, update request cycles, and apply returned views to the correct editable history slots. Starting a subprocess or installing a skill provides none of those hooks. This transport does not replace the host's default compaction.

When a tool argument intentionally contains a fold reference, an integrating host may resolve the **final argument value** and submit the resolved value through normal approval and current-file checks. Do this only when reference expansion is needed. Do not add an extra resolve call before unrelated tool calls, and do not forward unresolved references after an error.

The SDKs serialize calls to preserve ordered RPC pairing. Application errors leave the process usable; malformed responses or process failure close it. TypeScript/C# queued cancellation preserves the stream, while cancellation after dispatch closes it because the protocol has no remote cancellation IDs. See each SDK README for its runtime and disposal details.

## Validation

```sh
uv run --project context-folding python -m unittest discover \
  -s context-folding/tests -p test_transport.py -v
```

The transport tests use real local subprocesses and SQLite. SDK tests separately cover their process bridges and optional actual-core calls. These checks do not run a paid model or establish real-host compaction or billing results.
