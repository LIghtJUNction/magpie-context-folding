# Rust bridge SDK

A synchronous bridge to the shared Python engine used by `ctxf` and MCP. One persistent `python3 -m context_folding rpc --state PATH` process handles folding and queries. Python 3.10+ and the package must be available in the configured interpreter.

Install with `uv sync --project context-folding` and point `Config.python` at that environment's Python. Add the Rust crate as a path dependency:

```toml
[dependencies]
context-folding = { path = "../context-folding/sdks/rust" }
```

```rust,no_run
use context_folding::{serde_json::json, Client, Config};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::with_config(
        Config::new("/absolute/private/archive.sqlite3").python("python3"))?;
    let text = std::fs::read_to_string("notes.txt")?;
    let folded = client.fold("task", &text, json!({}))?;
    if let Some(id) = folded["references"][0]["id"].as_str() {
        println!("{}", client.meta("task", id, json!({}))?);
        println!("{}", client.list("task", json!({"id": id, "depth": 2, "limit": 5}))?);
        println!("{}", client.grep("task", "timeout", json!({"id": id, "limit": 3}))?);
        println!("{}", client.read("task", id, json!({"startLine": 1, "endLine": 4, "limit": 240}))?);
    }
    client.close()?;
    Ok(())
}
```

## Operations

Methods return `serde_json::Value`, preserving the engine's result shape:

- `fold(scope, text, options)` converts explicit markers immediately. Empty text is valid; optional fields include `language` and `commentStyles`.
- `list(scope, options)` discovers nodes, optionally by `id` and `depth`.
- `grep(scope, query, options)` searches literal text with optional `id`, `recursive`, `context`, `offset` and `limit`.
- `meta(scope, id, options)` returns hashes, sizes and bounded child IDs.
- `read(scope, id, options)` returns a bounded node view, preserving child references.
- `call(request)` supports other core integrations, including delayed `read-source` and status.

Pass `json!({})` or `json!(null)` for empty options. Explicit arguments override options. Use the same archive path and scope as the CLI to share references; neither is inferred.

Read/grep/list/meta do not set keep or unfold history. Read defaults to 1200 Unicode code points, maximum 24000; list/grep/meta default to 10 items, maximum 100. Use inclusive `startLine`/`endLine` or character `offset`, not both. Only request more data for a concrete question.

Fold references identify top-level regions with full-SHA `id`, `sha256`, `label`, short `reference` and `archiveId`. Discover children through list/meta or recursive grep. Original `sha256` differs from `viewSha256` when a parent view contains child references. The SDK cannot rewrite host history. Legacy archive/export wrappers remain compatible but are not the default query workflow.

## Transport and lifecycle

`Config` exposes `python`, `python_args` (before `-m`), `state`, `env`, `current_dir` and `shutdown_timeout` (two seconds). Arguments bypass the shell. Source execution can set `PYTHONPATH` in `config.env`; relative state paths resolve in the child's working directory.

Calls block and are serialized by a mutex; share `Arc<Client>` across threads. There is no request timeout. Application errors preserve the process; transport errors close it. `close()` and `Drop` close stdin, then kill/reap a child that exceeds the shutdown timeout.

stderr is inherited to avoid an unread pipe. Error Display/Debug omit remote payloads; inspect `Error::Remote { code, message }` explicitly when needed. A custom runtime controls its own diagnostics.

## Verify

```sh
cargo test --offline
CONTEXT_FOLDING_PYTHON=/path/to/venv/bin/python cargo run --example basic -- /tmp/example.sqlite
```

Process tests require `python3`. Set `CONTEXT_FOLDING_REAL_CORE_PATH` to the source `context-folding/python` directory for actual-core folding, nested-query and delayed-source tests; otherwise those cases report skips. Installing the Python CLI does not install a Rust compiler.
