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
        "<!-- @context-fold begin investigation -->\nNext step: check the parser timeout.\n<!-- @context-fold begin trace -->\n{}<!-- @context-fold end trace -->\n<!-- @context-fold end investigation -->\n",
        "Observed timeout while reading the parser response.\n".repeat(30)
    );
    let folded = client.fold("rust-example", &text, json!({}))?;
    let view = folded["text"].as_str().ok_or("fold response missing text")?;
    print!("{view}");
    if let Some(id) = folded["references"][0]["id"].as_str() {
        println!("{}", client.meta("rust-example", id, json!({}))?);
        println!("{}", client.list("rust-example", json!({"id": id, "depth": 2, "limit": 5}))?);
        println!("{}", client.grep("rust-example", "timeout", json!({"id": id, "limit": 3}))?);
        println!("{}", client.read("rust-example", id, json!({"limit": 160}))?);
    }
    client.close()?;
    println!("Queried the archive without unfolding its history.");
    Ok(())
}
