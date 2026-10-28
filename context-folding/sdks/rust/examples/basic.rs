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
        "<!-- @context-fold begin investigation -->\n{}<!-- @context-fold end investigation -->\n",
        "Archived evidence from a completed step.\n".repeat(30)
    );
    let folded = client.fold("rust-example", &text, json!({}))?;
    let view = folded["text"].as_str().ok_or("fold response missing text")?;
    print!("{view}");
    let resolved = client.resolve("rust-example", json!({"content": view}))?;
    assert_eq!(resolved["value"]["content"], text);
    if let Some(id) = folded["references"][0]["id"].as_str() {
        let _original = client.read("rust-example", id, json!({"limit": 4000}))?;
    }
    client.close()?;
    println!("Folded explicit markers immediately and recovered exact text.");
    Ok(())
}
