# CLI and stdio transports

The Python package provides a local CLI, plain JSON Lines RPC, and an MCP stdio server. Python 3.11+ uses only the standard library; Python 3.10 uses `tomli` for TOML settings. No service opens a network listener or calls a model. The same `Client` core validates business requests and persists the scoped archive for every transport.

## Run with uv

From the repository root:

```sh
uv sync --project context-folding
uv run --project context-folding python -m context_folding status --state /absolute/private/archive.sqlite --scope example
uv run --project context-folding python -m context_folding rpc --state /absolute/private/archive.sqlite
uv run --project context-folding python -m context_folding mcp --state /absolute/private/archive.sqlite
uv run --project context-folding python -m context_folding call --state /absolute/private/archive.sqlite --json '{"action":"status","scope":"example"}'
```

The installed `context-folding` console command accepts the same arguments. `--state` is required and may appear before or after the command. State is a SQLite file path, not a directory or JSON request field. Use a private persistent parent directory and a stable scope for related operations. Scopes are nonempty strings with at most 200 characters; they are namespaces, not authentication. References resolve only against the selected state file and scope. Packaging uses `uv_build`; see the [subproject README](../README.md) for Python SDK and persistent Python bridge setup.

`call` accepts one complete request using `--json JSON`; omitting `--json`, or supplying `--json -`, reads a JSON document from stdin. This is a single call, so the document may span multiple lines. Each action also has an ergonomic subcommand requiring `--scope` and accepting `--json`. Explicit flags override corresponding JSON fields, and the chosen subcommand determines `action`.

```sh
uv run --project context-folding python -m context_folding put --state /absolute/private/archive.sqlite --scope example < /project/output.txt
uv run --project context-folding python -m context_folding mark --state /absolute/private/archive.sqlite --scope example --id ENTRY_ID --disposition foldable --summary 'Historical output; key failure was a missing configuration file.'
uv run --project context-folding python -m context_folding read --state /absolute/private/archive.sqlite --scope example --id ENTRY_ID --offset 0 --limit 4000
uv run --project context-folding python -m context_folding list --state /absolute/private/archive.sqlite --scope example --query configuration --depth 2 --sort size --order desc
uv run --project context-folding python -m context_folding resolve --state /absolute/private/archive.sqlite --scope example --value '{"content":"[[cf:v1:ENTRY_ID]]"}'
```

Replace `ENTRY_ID` with an actual returned ID. `put` reads raw UTF-8 text from stdin if no text is supplied. `--text -`, `--summary -`, and `--body -` read raw UTF-8 text. `--source`, `--value`, `--config`, `--marks`, and `--files` take JSON values; `-` reads JSON from stdin. Only one input may consume stdin per invocation. Redirect large text rather than putting it in process arguments.

Other flags include `--ids` and `--protected` (zero or more IDs), `--role`, `--disposition`, `--path`, `--mode`, `--name`, `--description`, `--pinned`/`--no-pinned`, and pagination fields. Use `--json` for additional core options. Parser usage and help go to the normal argparse streams; successful archive operations do not print banners or diagnostics.

A single call emits exactly one JSON envelope and exits 0 on success or 1 on application/input failure. Argument usage errors exit 2, and keyboard interruption exits 130. Both services remain running after individual malformed requests or application errors and exit 0 at EOF. Broken output pipes terminate quietly.

## Actions and core fields

Every request is an object containing `action` and `scope`. Core validation is authoritative; the transport does not duplicate action-specific validation.

| Action | Principal fields and behavior |
| --- | --- |
| `put` | `text`, optional `role` (`user`, `assistant`, `tool`; default `tool`) and `source: {path, range}`. Returns `id`, `reference`, and version metadata where applicable. |
| `list` | Optional `query`, subtree `id`, `depth` (0–8), `sort` (`chronological`, `size`, `id`, `version`), `order` (`asc`, `desc`), `offset`, and `limit` (1–100). Returns entries, total, and `nextOffset`. |
| `mark` | `id`, `disposition` (`foldable`, `keep`, `unmarked`), and `summary` when foldable; alternatively a `marks` array of these objects. |
| `read` | `id`, optional `mode` (`folded` or `original`), region `expand`, `offset` and `limit`. Annotated source defaults to folded text; other entries return originals. Defaults to 4000 code points; maximum limit 24000. |
| `annotate` | Exactly one of source `text`, absolute file `path`, or archived `id`; optional `language`, region `keep`, and region `marks`. Archives source and annotations without editing input files. |
| `read-source` | Same source selectors as `annotate`, plus `mode`, `expand`, `offset`, `limit`; returns the selected source view. Both source actions accept atomic `files` batches. |
| `render` | `ids`, optional `protected`. Returns `entries` containing `id`, `text`, `folded`, plus `beforeChars` and `afterChars`. An unfolded group's `text` is a JSON-encoded array of original leaf entries with `id`, `role` and `text`. |
| `group` | 2–100 child `ids` and an explicitly authored `summary`. Creates a reversible manifest of eligible historical nodes. |
| `restore` | `id`. Reverses folding; use `gc` restore for trashed material. |
| `resolve` | `value`, an arbitrary JSON value. Returns the substituted `value` and substitution count `resolved`. |
| `paste` | `id`, absolute new-file `path`, optional `offset` and `limit`. Writes original text without overwriting an existing file. |
| `status` | Returns scoped counts and `offsetUnit: "unicode-code-points"`. |
| `roots` | `ids` replaces the active lifecycle root set. Use an empty array to clear it. |
| `pin` | `id`, boolean `pinned`; pinning protects lifecycle reachability. |
| `gc` | `mode`: `configure`, `status`, `collect`, `trash`, `restore`, or `purge`. `configure` accepts `config`; `trash`/`restore` require `ids`; `purge` optionally selects `ids`. |
| `skills` | `mode: "candidates"` lists reuse evidence. `mode: "export"` requires `id`, `name`, `description`, explicitly authored `body`, and absolute new-directory `path`. |

Read and paste offsets count Unicode code points, not UTF-8 bytes or JavaScript UTF-16 units. This applies to every generic bridge, including TypeScript and C#. The separate root Magpie plugin uses UTF-16 offsets; do not reuse its offsets here. Follow returned `nextOffset` instead of calculating a byte offset. `paste` defaults to the complete remaining original. Group read/paste returns a child manifest rather than concatenated original text.

Agents can fold completed investigations, repeated output and older observations proactively, according to the next task and context pressure. There is no fixed operation order or every-turn folding requirement. Preserve recovery references, current user requirements, latest file observations, essential reasoning and explicit `keep`/`unmarked` decisions. A successful archive or mark does not itself shorten host context: the host must use the rendered representation, and `folded: true` requires an eligible, strictly shorter result. Replacing default context compaction with reversible folding is the design goal. The current MCP server and root plugin request hook do not take over client compaction or control its threshold; local character reduction does not prove actual compaction was replaced or delayed.

`roots` replaces the entire lifecycle root set, while every `put`, including a duplicate put, initially roots its ID. Hosts must synchronize this set with retained context; `ids: []` clears it. Tree roots are separate from lifecycle roots. Reachability follows group children, `version.previousId`, and annotation region payloads. Configured roots, pinned records, `keep` marks and folded representations protect their dependency closure. `pin` protects retention independently of folding; `keep` protects both.

Lifecycle configuration fields are `strength` (`off`, `conservative`, `balanced`, `aggressive`), `idleSeconds`, `maxUses`, `retentionSeconds`, and boolean `autoPurge`. Automatic collection requires an explicit persisted `gc` configure policy or TOML `[gc] enabled = true`; defaults alone do not activate it. TOML supplies a temporary policy only when no saved policy exists, so a persisted `strength: "off"` also takes priority. Non-`off` configuration runs collection during subsequent ordinary core operations, with no background timer. Explicit `gc`, `skills` and folding `restore` skip the extra automatic pass. Collection first moves eligible unreachable cold records to recoverable trash. `autoPurge` defaults to false; when enabled, automatic purge waits for retention. Explicit purge permanently removes eligible trash without waiting for retention. `gc` restore recovers trash and dependencies; ordinary `restore` reverses folding and disables enclosing groups.

## Source views and configuration

`annotate` and `read-source` accept exactly one of `text`, an absolute UTF-8 file `path`, or an archived entry `id`. They never edit the input file. Python (`python` or `py`, inferred for `.py`/`.pyi` paths) uses the AST to identify functions, classes and compound blocks; all discovered regions default to foldable. Other languages recognize only explicit whole-line `@context-fold begin NAME` / `@context-fold end NAME` comment regions. This fallback is not a structural parser and may mistake marker-looking multiline string content for comments; inspect returned `parser` and `limitations`.

Source `keep` and `expand` are arrays of exact region names, region IDs, or `"*"`. `keep` and region `marks: [{name, disposition}]` persist on that exact archived source. `keep`/`unmarked` preserve descendants. Expanding a child exposes its ancestors, while unrelated siblings can remain folded. Expansion is a view option. Only strictly shorter reference replacements fold. `read` defaults to folded views after annotation; `mode: "original"`, `expand: ["*"]`, `paste`, and original recovery references retain exact source recovery. For compact reads, `offset`, `nextOffset`, `totalChars` and `sha256` describe the selected full view; `originalChars` and `originalSha256` describe the original. Paginate with unchanged view options.

Batch example, available through CLI `--files`, RPC and MCP:

```json
{"action":"read-source","scope":"example","files":[{"path":"/project/main.py","expand":["main"]},{"text":"def helper():\n    return 42\n","language":"python"}]}
```

A `files` batch contains 1–100 source objects. Outer options supply defaults and per-file options override them; action and scope remain those of the outer request. Do not combine `files` with outer `text`, `path` or `id`, or nest batches. All archive writes roll back if any item fails.

CLI flags include `--language`, `--keep` and `--expand` (zero or more selectors), and JSON `--files`. `--project-dir` may appear before or after any command, including `call`, `rpc` and `mcp`. Configuration loads once when the client/process starts: defaults < `$XDG_CONFIG_HOME/context-folding/config.toml` (or `~/.config/context-folding/config.toml`) < nearest ancestor `.context-folding.toml` < explicit Python `Client(..., config=...)`. Project discovery starts from `project_dir` or the working directory, checks the Git root and stops there. Invalid configuration fails before storage creation.

TOML uses optional `version = 1` and validated `[annotations]`, `[gc]`, `[folding]`, `[magpie]` sections. Annotation defaults are `enabled = true`, `default_fold = true`, `keep = []`. Configured keep patterns use case-sensitive glob matching over region names; unmatched patterns are ignored, while explicit request selectors must match. Explicit region marks override configured patterns. Disabling annotations skips automatic discovery in `read-source`; explicit `annotate` remains available. Disabling either annotation setting changes annotated reads to original by default; explicit mode still wins. GC is disabled by default; its TOML fields use snake_case (`idle_seconds`, `max_uses`, `retention_seconds`, `auto_purge`). TOML deep merging preserves inherited numeric limits when changing strength; explicit `gc configure` retains its preset-selection behavior.

## Plain JSON Lines RPC

Run `python -m context_folding rpc --state PATH`. Send one compact UTF-8 JSON request per line. The server flushes one response line per input frame, in order. The service has no request IDs, batching, notifications, or initialization handshake; callers associate responses with the input order.

Request:

```json
{"action":"put","scope":"example","text":"original text","role":"tool"}
```

Success response:

```json
{"result":{"id":"ENTRY_ID","reference":"[[cf:v1:ENTRY_ID]]","version":{}}}
```

The ID and version object above are illustrative; use the actual result. Every response has either `result` or `error`, never both:

```json
{"error":{"code":"invalid_json","message":"Input must be valid UTF-8 JSON"}}
```

Transport error codes include `invalid_json`, `invalid_request`, `input_too_large`, and `internal_error`; core errors retain their string `code` and safe `message`. Invalid UTF-8 and JSON receive generic messages without echoing input. Unexpected internal failures do not expose exception details or tracebacks. No request or archive payloads are logged.

## MCP stdio

Run `python -m context_folding mcp --state PATH`. MCP uses JSON-RPC 2.0 messages in UTF-8 newline-delimited JSON. There are no `Content-Length` headers. Stdout contains protocol messages only; host launchers must not merge their diagnostic stderr into it.

Initialize before tool discovery or tool calls:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"example-host","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context_folding","arguments":{"action":"status","scope":"example"}}}
```

Supported protocol versions are `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`. A supported requested version is echoed. For an unsupported requested version, the server proposes `2025-11-25`; the client decides whether it can continue with that version. Server capabilities advertise tools only. `ping` returns an empty object. Valid notifications, including unknown extensions, are silent and do not execute archive operations.

`tools/list` exposes exactly one tool named `context_folding`. Its `inputSchema` is an object requiring `action` and `scope`, enumerates all supported actions, and advertises known request fields. Additional properties are permitted for core-owned options and protocol evolution. Business validation remains in core.

A successful `tools/call` returns JSON text for the raw core result:

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"entries\":0,\"groups\":0,\"roots\":0,\"folded\":0,\"trashed\":0,\"offsetUnit\":\"unicode-code-points\"}"}],"isError":false}}
```

Application failures return a successful JSON-RPC envelope containing a tool error. Parse the text as the ordinary error envelope:

```json
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"error\":{\"code\":\"invalid_request\",\"message\":\"Unknown action\"}}"}],"isError":true}}
```

Malformed JSON/UTF-8 produces JSON-RPC `-32700`; invalid envelopes or oversized frames produce `-32600`. Invalid method parameters and unknown tool names produce `-32602`; unknown methods produce `-32601`; calls requiring initialization before initialization produce `-32000`. Unexpected server failures produce `-32603`. Envelope errors have `id: null` when no usable request ID is available. One error does not close the stream.

## Framing and limits

Both services read lines with a bounded read, limiting a request payload to 8 MiB (8 × 1024 × 1024 bytes). An oversized frame is discarded through its newline in bounded chunks and produces one error; the next frame remains readable. LF and CRLF are accepted, and a final frame without a newline is accepted at EOF. Empty lines are invalid JSON. JSON strings must escape embedded newlines. Batch arrays, nonstandard `NaN`/`Infinity` literals, and malformed UTF-8 are rejected. Core text and operation limits can be lower than the transport limit.

Outputs are compact JSON followed by LF and flushed immediately. Non-ASCII characters may be escaped, preserving their decoded Unicode value. Single-call stdin and raw text inputs use the same 8 MiB bound.

## Host integration and skill installation

The host must call `resolve` against the final complete argument value immediately before dispatching each other tool, then pass the returned `value` through its normal execution/approval path. Abort that dispatch on resolution failure. Do not silently forward unresolved references. Expansion is one pass: archived text remains data, and references found inside it are not recursively expanded. Group manifests cannot substitute for original entry text in tool arguments.

An MCP server cannot intercept calls to other tools. Launching this server or copying the skill does not provide an automatic dispatch hook. The host must implement the hook, or the agent must explicitly resolve the final arguments before using another tool.

To install the included skill, the user copies `skills/context-folding/` into a skill directory their host already discovers, retaining its `SKILL.md`. Copying the folder does not install the Python runtime, modify settings, register MCP, install hooks, or grant permissions. Reuse candidates are evidence for review, not authorization to install instructions. Export requires a caller-authored body and creates only `SKILL.md` in a new directory. Its frontmatter contains `source_manifest` with source ID/kind/hash, timestamps, reuse counts and available source/version/child metadata; there is no separate provenance sidecar. Review and install explicitly rather than converting archived tool output into executable instructions.

## Local validation

```sh
uv run --project context-folding python -m unittest discover -s context-folding/tests -p test_transport.py -v
```

The transport suite launches real module subprocesses against the actual SQLite core and checks persistence, CLI stdin, lifecycle flags, Unicode offsets, RPC recovery, MCP negotiation/tool results/notifications, and malformed or oversized frames. It uses no inference services.
