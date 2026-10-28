# Context Folding Rust SDK

This crate is a synchronous Rust **bridge to the shared Python engine**, not a native Rust implementation. It starts one persistent `python3 -m context_folding rpc --state PATH` subprocess and exchanges UTF-8 JSON Lines over stdin/stdout. Python 3.10+ and the `context-folding` Python package are required in that interpreter. There are no model calls or network services in this transport.

Install the Python engine with uv from the `context-folding/` project directory:

```sh
uv sync
```

Configure `Config.python` with the absolute path to `context-folding/.venv/bin/python` created by uv, or use another Python interpreter where the package is installed. The default `python3` must itself be able to import `context_folding`.

Add the Rust crate as a path dependency, adjusting the path for your application:

```toml
[dependencies]
context-folding = { path = "../context-folding/sdks/rust" }
```

```rust,no_run
use context_folding::{serde_json::json, Client, Config};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::new("context-folding-state.sqlite")
        .python("python3"); // Or an absolute virtualenv interpreter path.
    let client = Client::with_config(config)?;
    let text = format!("# @context-fold begin investigation\n{}# @context-fold end investigation\n",
        "# Completed investigation detail.\n".repeat(40));
    let request = |cycle| json!({
        "action": "read-source", "scope": "my-session", "text": text,
        "language": "python", "occurrence": "read-1", "requestCycle": cycle
    });
    let first = client.call(request(0))?; // Complete first observation.
    let later = client.call(request(1))?;
    let _resolved = client.resolve("my-session", json!({"content": later["text"]}))?;
    let _original = client.read("my-session", first["id"].as_str().ok_or("missing id")?, json!({}))?;
    client.close()?;
    Ok(())
}
```

Convenience methods return `serde_json::Value`, preserving the engine's result shape:

- `put(scope, text, options)` stores text with optional fields such as role/source.
- `read(scope, id, options)` reads an entry, forwarding `offset`/`limit` and other optional fields. Offsets count Unicode codepoints, as in Python strings.
- `list(scope, options)` lists entries, forwarding optional fields.
- `render(scope, ids, protected)` renders selected entries with protected IDs.
- `resolve(scope, value)` resolves references in arbitrary JSON values.
- `call(request)` sends any JSON object, including read-source, restore, paste, and status actions. `mark` and `group` have been removed.

Use `read-source` with both `occurrence` and `requestCycle` for delayed source projection. A fresh read needs a fresh occurrence; retries keep the same cycle. The bridge does not observe model requests or advance cycles itself.

Pass `json!(null)` or `json!({})` for empty options. Explicit method arguments override options with the same name. The shared Python engine validates action fields and scope boundaries.

`Config` also exposes `python_args` (arguments before `-m`), `state`, `env`, `current_dir`, and `shutdown_timeout` (default two seconds). Arguments are passed directly without a shell. To use the Python source tree without installation, set `PYTHONPATH` in `config.env` to the absolute `context-folding/python` directory. Relative state paths are resolved in the child's working directory. Startup errors report a missing Python executable; if the module is missing, the first call reports the exited engine and inherited stderr contains the Python diagnostic.

Calls are blocking and serialized by a mutex. Share an `Arc<Client>` between threads if needed. A call waits for one response and has no request timeout; `close()` also waits for any active call to finish. Remote application errors preserve the process for subsequent calls; transport errors or malformed responses close it to prevent response misalignment. `close()` and `Drop` close stdin to request graceful shutdown, then kill and reap a child that exceeds `shutdown_timeout`.

Python stderr is inherited, so diagnostics cannot fill an unread pipe. The SDK never adds payloads or raw responses to errors. `Display` and `Debug` hide remote error code/message because an engine error could echo sensitive input; inspect `Error::Remote { code, message }` explicitly when appropriate. Inherited stderr is controlled by the configured runtime; custom Python wrappers should likewise avoid logging sensitive requests.

Run the example after installing the engine:

```sh
CONTEXT_FOLDING_PYTHON=/absolute/path/to/context-folding/.venv/bin/python cargo run --example basic -- /tmp/context-folding-example.sqlite
```

Local process integration tests use a deterministic fake Python engine and require `python3` on PATH:

```sh
cargo test --offline
```

Set `CONTEXT_FOLDING_REAL_CORE_PATH` to the absolute `context-folding/python` directory to additionally exercise explicit annotation delay, retry/fresh-occurrence handling and exact recovery against the actual core. Without it, that case reports an explicit skip.
