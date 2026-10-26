use context_folding::{serde_json::json, Client, Config};
use std::ffi::OsString;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = std::env::args_os()
        .nth(1)
        .unwrap_or_else(|| OsString::from("context-folding-state.json"));
    let python =
        std::env::var_os("CONTEXT_FOLDING_PYTHON").unwrap_or_else(|| OsString::from("python3"));
    let client = Client::with_config(Config::new(state).python(python))?;
    let entry = client.put(
        "rust-example",
        "Original tool output kept for later inspection.",
        json!({
            "role": "tool", "source": {"path": "example.txt"}
        }),
    )?;
    let id = entry
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("put response missing entry id")?;
    client.mark(
        "rust-example",
        id,
        "foldable",
        "Tool output archived; reopen if needed.",
    )?;
    let _rendered = client.render("rust-example", &[id], &[])?;
    let _original = client.read("rust-example", id, json!({"offset": 0, "limit": 100}))?;
    let _resolved = client.resolve(
        "rust-example",
        json!({"content": format!("[[cf:v1:{id}]]")}),
    )?;
    client.close()?;
    println!("Stored, marked, rendered, read, and resolved an archived entry.");
    Ok(())
}
