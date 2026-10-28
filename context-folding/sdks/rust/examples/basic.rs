use context_folding::{serde_json::json, Client, Config};
use std::ffi::OsString;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = std::env::args_os()
        .nth(1)
        .unwrap_or_else(|| OsString::from("context-folding-state.sqlite"));
    let python =
        std::env::var_os("CONTEXT_FOLDING_PYTHON").unwrap_or_else(|| OsString::from("python3"));
    let client = Client::with_config(Config::new(state).python(python))?;
    let text = format!(
        "# @context-fold begin investigation\n{}# @context-fold end investigation\n",
        "# Archived evidence from a completed step.\n".repeat(30)
    );
    let request = |cycle| json!({
        "action": "read-source", "scope": "rust-example", "text": text,
        "language": "python", "occurrence": "read-1", "requestCycle": cycle
    });
    let first = client.call(request(0))?;
    let id = first["id"].as_str().ok_or("source response missing id")?;
    let folded = client.call(request(1))?;
    let view = folded["text"].as_str().ok_or("source response missing text")?;
    let resolved = client.resolve("rust-example", json!({"content": view}))?;
    assert_eq!(resolved["value"]["content"], text);
    let _original = client.read("rust-example", id, json!({"limit": 4000}))?;
    client.close()?;
    println!("Observed, folded on the next request, and recovered exact source.");
    Ok(())
}
