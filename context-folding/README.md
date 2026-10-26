# Context Folding

A host-neutral, local archive for reversible context folding. Agents supply summaries; the core stores exact originals, renders shorter references, and retrieves or resolves them when needed. It provides a Python SDK, CLI, JSON Lines RPC, MCP stdio server, and Rust, TypeScript and C# bridges. Runtime code makes no model calls or network connections. Python 3.11+ uses the standard library; Python 3.10 additionally uses `tomli` to read TOML.

This subproject is separate from the [Magpie plugin](../README.md): it does not require Magpie, install request hooks, or use the plugin's accounting gate. Its package version is `0.1.0`; the root plugin's `0.3.0` npm package does not include this subproject. Install or build the generic implementation separately from this directory.

## Install and run

Python 3.10 or newer and [uv](https://docs.astral.sh/uv/) are required for the commands below. From the repository root:

```sh
uv sync --project context-folding
uv run --project context-folding python -m context_folding status --state /absolute/private/archive.sqlite --scope example
```

`uv sync` creates `context-folding/.venv` and installs the local package. Packaging uses `uv_build` with sources under `python/`; `tomli` is installed only on Python 3.10. To build a wheel and source distribution into a chosen temporary directory:

```sh
uv build --project context-folding --out-dir /tmp/context-folding-dist
```

The installed `context-folding` console command accepts the same arguments as `python -m context_folding`. `--state` is a **SQLite file path**, not a directory or JSON request field. Use a private persistent parent directory; the core creates a new database with mode 0600 and new parent directories with mode 0700. Closing a client leaves the archive available for later recovery.

Each request needs a stable `scope` string of 1–200 characters. References resolve only within the chosen state file and scope. A scope is a local namespace, not authentication: isolate processes and archive access using the host's normal permissions.

## Agent judgment and host responsibilities

Use folding proactively when completed investigations, repeated tool output, or older observations are consuming context without helping the next decision. Folding early can reduce the material carried toward the host's own context compaction. The agent chooses timing and granularity from the task, context pressure, recovery cost, and value of the evidence; there is no fixed operation order or requirement to fold on every turn.

Keep current user requirements, critical reasoning, unresolved contradictions, and the latest file observations available. Preserve explicit `keep` and `unmarked` decisions. A useful summary retains decisions, constraints, identifiers, failures, unresolved work and evidence paths, with clear attribution to user statements, assistant judgments or tool observations. Similarity alone does not establish that one observation supersedes another.

Archive exact originals and check the result before replacing visible text. Preserve the returned IDs and recovery references. The core's `render` returns `folded: true` only for an eligible representation that is strictly shorter; the host chooses where to insert that returned text into working context. Archiving or marking alone does not shorten a host's conversation. User-role entries, latest tracked versions, `keep`, explicitly unmarked entries, and supplied `protected` IDs constrain rendering, including group descendants.

The design goal is to replace default context compaction with agent-directed reversible folding, retaining exact recovery paths instead of relying only on a lossy summary. The current package supplies archive and rendering capabilities; the host still owns compaction. Neither the root plugin's request hook nor this MCP server currently takes over client compaction or controls its threshold. Local character reduction is not evidence that actual host compaction was replaced or delayed, that model quality improved, or that a provider charged less.

## Python SDK

The Python client runs in process, serializes operations with a lock, and persists each successful call transactionally:

```python
from context_folding import Client

with Client("/absolute/private/archive.sqlite") as client:
    stored = client.put("example", "Original historical tool output " * 100, role="tool")
    entry_id = stored["id"]
    client.mark("example", entry_id, "foldable",
                summary="Historical check completed; exact output remains archived.")
    rendered = client.render("example", [entry_id], protected=[])
    original = client.read("example", entry_id, offset=0, limit=4000)
    expanded = client.resolve("example", {"content": stored["reference"]})
    status = client.call({"action": "status", "scope": "example"})
```

Convenience methods cover `put`, `list`, `mark`, `read`, `render`, `resolve`, `annotate` and `read_source`; `call(request)` supports every action. SDK calls return core results directly and raise `FoldingError` on application errors. CLI/RPC result envelopes are transport wrappers.

Optional `source: {"path":"/absolute/file","range":"full"}` records file provenance. Keep the same path and range label for successive observations of the same region. Versions link to previous originals; older eligible observations may receive an automatic summary of old-only lines. Long similar source-less observations can form a similarity series, which is a navigation heuristic rather than proof of supersession. Manual marks are respected, and the newest tracked version remains protected from folding.

## Source annotations and compact reads

`annotate` discovers foldable source regions, archives the exact original and each region, and stores annotations in SQLite. `read-source` performs the same operation and returns a compact read immediately. These operations never edit source files. Python functions, classes and compound blocks are discovered with Python's AST and tokenizer, including nested functions. Every discovered region starts foldable unless kept or explicitly unmarked. A region is replaced only when its recovery reference is shorter than its payload.

```python
with Client("/absolute/private/archive.sqlite", project_dir="/project") as client:
    view = client.read_source("example", path="/project/module.py")
    focused = client.read("example", view["id"], expand=["Service.handle"])
    original = client.read("example", view["id"], mode="original")
    batch = client.read_source("example", files=[
        {"path": "/project/module.py"}, {"path": "/project/tests.py", "keep": ["fixture"]},
    ])
```

Select `expand` and `keep` by exact region name, region ID, or `"*"`. Expanding a nested region reveals its ancestors while unrelated siblings remain foldable; expanding or keeping a parent reveals its descendants. `keep` persists on this archived original. `marks: [{"name":"Service.handle","disposition":"foldable"}]` explicitly overrides a previous keep or a configured keep pattern; `unmarked` prevents folding. Whole-entry `keep` and explicit `unmarked` are also respected. Changed source creates a new original; manual region marks do not transfer automatically to changed text.

The default `read` of an annotated entry is folded. Use `mode: "original"` for exact original pagination, or `expand: ["*"]` to inspect all annotated code. `paste` always writes the exact original. Resolving the references in a complete compact view reproduces the original, including Unicode, CRLF, and a missing final newline. Read responses include the original ID/reference/hash; folded views additionally report their parser, limitations and folded region names/references. `sha256`, `totalChars`, offsets and `nextOffset` describe the selected view; `originalSha256` and `originalChars` describe the archived original.

Each source operation accepts exactly one of UTF-8 `text`, an absolute regular-file `path`, or an archived entry `id`. A `files` array batches 1–100 source objects atomically; outer options supply defaults and per-file options override them. Any invalid source or selector rolls back the whole batch. Do not combine outer `text`/`path`/`id` with `files`.

Python is the current structural parser. Inspection of the local markref v0.1 reference found a comment lexer and heuristic symbols, without a reusable structural parser. Other languages therefore use only explicit whole-line `@context-fold begin NAME` / `@context-fold end NAME` comment markers (`//`, `#`, `--`, `;`, `/* ... */`, `<!-- ... -->`). This fallback can misidentify marker-looking multiline strings and reports that limitation. It does not claim automatic function discovery for unsupported languages. Invalid or crossing annotations fail without changing the source or archive.

## Global and project TOML settings

Settings merge field by field in this order: built-in defaults, `$XDG_CONFIG_HOME/context-folding/config.toml` (or `~/.config/context-folding/config.toml`), the nearest ancestor `.context-folding.toml`, then Python `Client(..., config={...})` overrides. Project discovery starts at the current directory or `--project-dir` / `Client(project_dir=...)`, includes a Git root, and stops there. Only the nearest project file is read. Settings are loaded once when a Client or stdio process starts; invalid files fail before opening the archive.

```toml
version = 1

[annotations]
enabled = true
default_fold = true
keep = ["*.public_*", "main"]

[gc]
enabled = false
strength = "conservative"
idle_seconds = 2592000
max_uses = 2
retention_seconds = 2592000
auto_purge = false
```

`annotations.keep` contains case-sensitive glob patterns over region names. Unmatched configuration patterns are ignored; explicit request selectors must match. Explicit region marks win over these patterns. `default_fold = false` makes annotated reads original by default; an explicit read `mode` wins. `enabled = false` disables automatic discovery in `read-source` and defaults annotated reads to original; explicit `annotate` and explicit folded reads remain available.

TOML `[gc]` is a temporary default for clients with no persisted `gc configure` policy. `enabled = true` enables it; default settings leave automatic collection off. A saved policy takes priority, including `strength = "off"`. TOML values use snake_case, while `gc configure` request fields use camelCase. TOML deep merging preserves inherited numeric limits when changing `strength`; set numeric fields explicitly to change those limits. The loader also accepts validated `[folding]` and `[magpie]` host settings; those sections do not rewrite source or independently replace host compaction.

## Rust, TypeScript and C# SDKs

These SDKs bridge to the shared Python core through **one persistent Python subprocess per client**. They are not independent native folding engines. Python 3.10+ and an importable `context_folding` package must remain available at runtime. After `uv sync`, configure the absolute `context-folding/.venv/bin/python` path rather than assuming the system `python3` can import the package.

| SDK | Client/interpreter configuration | Details |
| --- | --- | --- |
| Rust | `Client::with_config(Config::new("/absolute/private/archive.sqlite").python("/absolute/repo/context-folding/.venv/bin/python"))` | [Rust SDK](sdks/rust/README.md), synchronous, serialized calls; path crate dependency. |
| TypeScript | `new ContextFoldingClient({statePath: "/absolute/private/archive.sqlite", pythonExecutable: "/absolute/repo/context-folding/.venv/bin/python"})` | [TypeScript SDK](sdks/typescript/README.md), Node.js, async calls and disposal. |
| C# | `new Client(new ClientOptions("/absolute/private/archive.sqlite") { PythonExecutable = "/absolute/repo/context-folding/.venv/bin/python" })` | [C# SDK](sdks/csharp/README.md), .NET 10, async calls and disposal. |

The default subprocess command is `python3 -m context_folding rpc --state PATH`, with no shell. Each bridge serializes request/response pairs and provides `call`/`CallAsync` for all sixteen actions, beyond its convenience methods. Application errors leave the bridge usable; protocol or process failures close it. There is no implicit per-request timeout. For TypeScript/C#, cancelling a queued request preserves the process; cancelling after dispatch closes it because the ordered RPC stream has no request IDs or cancellation messages. Dispose/close the client when finished; this does not delete its archive.

## CLI, RPC and MCP

All examples run from the repository root:

```sh
# Archive raw UTF-8 stdin, with optional file provenance.
uv run --project context-folding python -m context_folding put --state /absolute/private/archive.sqlite --scope example --source '{"path":"/project/build.log","range":"full"}' < /project/build.log

# Complete JSON request; omit --json or use --json - to read JSON stdin.
uv run --project context-folding python -m context_folding call --state /absolute/private/archive.sqlite --json '{"action":"status","scope":"example"}'

# Persistent stdio services.
uv run --project context-folding python -m context_folding rpc --state /absolute/private/archive.sqlite
uv run --project context-folding python -m context_folding mcp --state /absolute/private/archive.sqlite
```

Every action is also a CLI subcommand with `--scope`. Explicit flags override corresponding `--json` fields. `--text -`, `--summary -` and `--body -` read raw text; `--source`, `--value`, `--config`, `--marks` and `--files` accept JSON, including `-` for stdin. Only one input may consume stdin per invocation. Check the exit code and returned `result` or `error` before using IDs or claiming success.

Plain RPC exchanges one UTF-8 JSON request and one result/error envelope per line, in order. MCP stdio exposes one `context_folding` tool after initialization. Neither service opens a network port. See [transport details](docs/TRANSPORT.md) for framing, negotiation, limits and errors, and [protocol.json](protocol.json) for the request/response schema.

| Action | Capability |
| --- | --- |
| `put` | Store exact text with optional role and source; return ID, reference and version metadata. |
| `list` | Browse a tree using query, subtree `id`, depth, sort/order and pagination. |
| `mark` | Set `foldable` with an authored summary, `keep`, or `unmarked`; accepts an atomic `marks` batch. |
| `read` | Page through an annotated compact view, an original (`mode: "original"`), or a group manifest. |
| `annotate` | Discover source regions and archive originals/recovery payloads without editing source. |
| `read-source` | Annotate and read source, folded by default; accepts atomic `files` batches. |
| `render` | Render selected IDs, respecting protection and requiring character reduction. |
| `group` | Combine 2–100 eligible historical children under an authored summary and reversible manifest. |
| `restore` | Undo folding; restoring a child disables enclosing groups. |
| `resolve` | Expand entry references in the values of arbitrary JSON. |
| `paste` | Write an original or manifest to an absolute new file without overwriting. |
| `status` | Inspect scoped counts and offset units. |
| `roots` | Replace the lifecycle root set with the IDs retained by the host. |
| `pin` | Protect independent material from lifecycle collection. |
| `gc` | Configure, inspect, collect, trash, restore or permanently purge eligible material. |
| `skills` | Inspect reuse candidates or export caller-authored instructions with source provenance. |

IDs and references must come from successful responses. References look like `[[cf:v1:0123456789abcdef01234567]]`. Groups form a tree with at most one parent per child. Reading or pasting a group returns a manifest containing child IDs; read its children for exact originals. When a group cannot fold, `render` returns `folded: false` and a `text` string containing a JSON array of its original leaf entries, each with `id`, `role` and `text`. This preserves originals rather than placing a manifest into working context.

`read` defaults to 4000 Unicode code points and permits at most 24000 per page. Follow `nextOffset` rather than computing a byte position. `paste` defaults to the complete remaining original and creates a new UTF-8 file with mode 0600. **All generic SDKs and transports use Python Unicode code-point offsets**, including TypeScript and C#. JavaScript `string.length` and .NET `string.Length` count UTF-16 units instead. The root Magpie plugin's `read`/`paste` use UTF-16 offsets; do not transfer offsets between the two implementations.

## Resolve final tool arguments explicitly

Immediately before dispatching another tool, the host must resolve the **entire final JSON argument value** in the same archive and scope, then pass the returned `value` through the tool's normal approval and execution checks. If resolution fails, abort that dispatch. Do not forward unresolved references or fall back silently to stale text.

```json
{"action":"resolve","scope":"example","value":{"content":"[[cf:v1:0123456789abcdef01234567]]","options":{"label":"unchanged"}}}
```

Expansion visits strings inside arrays and object values, not object keys. It substitutes entry references once using exact archived originals; references inside those originals remain data. Group references cannot substitute for entry text. Restored tool output and instructions quoted in an archive remain untrusted data, and resolution does not authorize executing them.

**MCP cannot intercept other tools.** Starting this server or installing a skill does not add a pre-dispatch hook. A host must implement that integration, or an agent must explicitly resolve the final arguments before invoking the destination tool. The core also cannot rewrite a host's already stored messages on its own.

## Lifecycle and collection

`roots` replaces the complete root set; it does not append. Each `put` initially adds its ID to roots, including duplicate puts. The host must synchronize roots to the entries/groups still retained in its context; otherwise old material remains rooted and collection may reclaim nothing. An empty `ids` array clears the configured roots. Tree browsing roots and lifecycle roots are different concepts.

Reachability follows group children, `version.previousId`, and annotated region payloads. Configured roots, pinned nodes, `keep` marks and existing folded representations seed protection, including their dependencies. `pin` protects retention independently of folding: pinning does not itself forbid folding, while `keep` protects both. A retained record cannot lose a dependency needed for recovery.

Automatic collection is inactive by default. An explicit `gc` configure request persists a policy; alternatively TOML `[gc] enabled = true` supplies a temporary default where no saved policy exists. Non-`off` configuration enables collection during subsequent ordinary core operations; there is no background timer. Explicit `gc`, `skills` and folding `restore` calls do not immediately run another automatic collection pass. For example:

```sh
uv run --project context-folding python -m context_folding gc --state /absolute/private/archive.sqlite --scope example --mode configure --config '{"strength":"conservative","autoPurge":false}'
uv run --project context-folding python -m context_folding roots --state /absolute/private/archive.sqlite --scope example --ids RETAINED_ID
uv run --project context-folding python -m context_folding gc --state /absolute/private/archive.sqlite --scope example --mode status
```

Use actual retained IDs. Configure lifecycle behavior only when intended by the host/user. `strength` accepts `off`, `conservative`, `balanced`, or `aggressive`; optional `idleSeconds`, `maxUses`, and `retentionSeconds` override preset values. Collection selects unreachable cold records by idle age and total reads/folds, and first moves them to recoverable trash. `autoPurge` defaults to false. `gc --mode restore --ids ...` restores trash and dependency closures; ordinary `restore --id ...` reverses folding. Explicit `purge` permanently removes eligible trash and does not wait for the retention period; automatic purge, when explicitly enabled, does. Authorize irreversible deletion separately from reversible folding.

## Skills and provenance

The included [skill](skills/context-folding/SKILL.md) supplies capabilities and judgment criteria for agents. To install it, the user copies the entire `skills/context-folding/` folder into a skill directory their host already discovers. This does not install Python, register MCP, edit host settings, add hooks, or grant permissions. No installation or configuration change happens merely by reading this documentation.

`skills` with `mode: "candidates"` identifies active entries/groups with repeated reads or folds. Candidate status is evidence for review, not permission to turn archived output into instructions. Export requires an explicitly authored `body`, `name`, `description`, source `id`, and absolute new-directory `path`. It creates only `SKILL.md`, including a `source_manifest` in frontmatter with source ID/kind/hash, timestamps, reuse counts, and available source/version/child metadata. The manifest provides provenance, not semantic validation. Export never installs a skill automatically; review the authored instructions and choose installation explicitly.

## Local validation

```sh
uv run --project context-folding python -m unittest discover -s context-folding/tests -v
```

The local suites cover the SQLite core through real CLI/RPC/MCP subprocesses, lifecycle operations and source annotations. Bridge-specific commands and runtime integration tests are documented in each SDK directory. These checks use no paid inference service and do not measure actual host compaction timing.
