use context_folding::{serde_json::json, Client, Config, Error};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// A real Python child exercises framing, persistent state, errors, and EOF.
const FAKE_RPC: &str = r#"
import json, os, sys, time
assert sys.argv[1:5] == ['-m', 'context_folding', 'rpc', '--state']
state = sys.argv[5]
count = 0
hang = False
for line in sys.stdin:
    req = json.loads(line)
    count += 1
    action = req['action']
    if action == 'error':
        print(json.dumps({'error': {'code': 'secret-code', 'message': 'private-payload'}}), flush=True)
    elif action == 'invalid':
        print('private-payload', flush=True)
    elif action == 'ambiguous':
        print(json.dumps({'result': 1, 'error': {'code': 'x', 'message': 'private-payload'}}), flush=True)
    elif action == 'exit':
        sys.exit(3)
    elif action == 'hang-close':
        hang = True
        print(json.dumps({'result': True}), flush=True)
    else:
        print(json.dumps({'result': {'request': req, 'count': count, 'pid': os.getpid()}}), flush=True)
if hang:
    time.sleep(30)
elif state != '-':
    with open(state, 'w', encoding='utf-8') as handle:
        handle.write('closed')
"#;

fn config() -> Config {
    let mut config = Config::new("-");
    config.python_args = vec![
        OsString::from("-u"),
        OsString::from("-c"),
        OsString::from(FAKE_RPC),
    ];
    config.shutdown_timeout = Duration::from_secs(1);
    config
}

#[test]
fn convenience_methods_preserve_fields_and_reuse_process() {
    let client = Client::with_config(config()).unwrap();
    let put = client
        .put(
            "scope α",
            "original\ntext ☃",
            json!({
                "role": "tool", "source": {"path": "a.py"}, "action": "wrong", "scope": "wrong"
            }),
        )
        .unwrap();
    assert_eq!(
        put["request"],
        json!({
            "action": "put", "scope": "scope α", "text": "original\ntext ☃",
            "role": "tool", "source": {"path": "a.py"}
        })
    );
    let read = client
        .read("scope α", "id-1", json!({"offset": 1, "limit": 10}))
        .unwrap();
    assert_eq!(
        read["request"],
        json!({"action":"read", "scope":"scope α", "id":"id-1", "offset":1, "limit":10})
    );
    assert_eq!(put["pid"], read["pid"]);
    assert_eq!(read["count"], 2);
    assert_eq!(
        client.list("s", json!(null)).unwrap()["request"],
        json!({"action":"list", "scope":"s"})
    );
    assert_eq!(
        client.call(json!({
            "action": "read-source", "scope": "s", "text": "# source",
            "occurrence": "read-1", "requestCycle": 0
        })).unwrap()["request"],
        json!({
            "action": "read-source", "scope": "s", "text": "# source",
            "occurrence": "read-1", "requestCycle": 0
        })
    );
    assert_eq!(
        client.render("s", &["id"], &["protected"]).unwrap()["request"],
        json!({
            "action":"render", "scope":"s", "ids":["id"], "protected":["protected"]
        })
    );
    assert_eq!(
        client
            .resolve("s", json!({"content":"[[cf:v1:id]]"}))
            .unwrap()["request"],
        json!({
            "action":"resolve", "scope":"s", "value":{"content":"[[cf:v1:id]]"}
        })
    );
    assert_eq!(
        client
            .call(json!({"action":"status", "scope":"s", "extra":42}))
            .unwrap()["request"]["extra"],
        42
    );
    assert_eq!(
        client.fold("s", "", json!({
            "action": "wrong", "scope": "wrong", "text": "wrong",
            "language": "explicit", "commentStyles": [{"start": ";;"}]
        })).unwrap()["request"],
        json!({"action": "fold", "scope": "s", "text": "",
            "language": "explicit", "commentStyles": [{"start": ";;"}]})
    );
    assert_eq!(
        client.grep("s", "needle", json!({"query": "wrong", "id": "entry", "limit": 2})).unwrap()["request"],
        json!({"action": "grep", "scope": "s", "query": "needle", "id": "entry", "limit": 2})
    );
    assert_eq!(
        client.meta("s", "entry", json!({"id": "wrong", "limit": 2})).unwrap()["request"],
        json!({"action": "meta", "scope": "s", "id": "entry", "limit": 2})
    );
    client.close().unwrap();
    client.close().unwrap();
    assert!(matches!(client.list("s", json!(null)), Err(Error::Closed)));
}

#[test]
fn concurrent_calls_are_paired_and_serialized() {
    let client = Arc::new(Client::with_config(config()).unwrap());
    let threads: Vec<_> = (0..12)
        .map(|index| {
            let client = Arc::clone(&client);
            std::thread::spawn(move || {
                let response = client
                    .call(json!({"action":"echo", "scope":"s", "index":index}))
                    .unwrap();
                assert_eq!(response["request"]["index"], index);
                response["count"].as_u64().unwrap()
            })
        })
        .collect();
    let mut counts: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    counts.sort_unstable();
    assert_eq!(counts, (1..=12).collect::<Vec<_>>());
}

#[test]
fn application_errors_are_private_and_stream_stays_usable() {
    let client = Client::with_config(config()).unwrap();
    let error = client
        .call(json!({"action":"error", "scope":"s"}))
        .unwrap_err();
    assert!(!format!("{error} {error:?}").contains("private-payload"));
    assert!(!format!("{error} {error:?}").contains("secret-code"));
    match error {
        Error::Remote { code, message } => {
            assert_eq!(code, "secret-code");
            assert_eq!(message, "private-payload");
        }
        other => panic!("unexpected error: {other}"),
    }
    assert_eq!(client.list("s", json!(null)).unwrap()["count"], 2);
    assert!(matches!(client.call(json!([])), Err(Error::InvalidRequest)));
    assert!(matches!(
        client.put("s", "private-payload", json!([])),
        Err(Error::InvalidOptions)
    ));
    assert_eq!(client.list("s", json!(null)).unwrap()["count"], 3);
}

#[test]
fn invalid_responses_close_transport_without_echoing_data() {
    for action in ["invalid", "ambiguous"] {
        let client = Client::with_config(config()).unwrap();
        let error = client
            .call(json!({"action":action, "scope":"s"}))
            .unwrap_err();
        assert!(matches!(error, Error::InvalidResponse));
        assert!(!format!("{error} {error:?}").contains("private-payload"));
        assert!(matches!(client.list("s", json!(null)), Err(Error::Closed)));
    }
}

#[test]
fn missing_runtime_and_early_exit_have_actionable_errors() {
    let error =
        match Client::with_config(Config::new("-").python("/context-folding/no-such-python")) {
            Ok(_) => panic!("unexpected interpreter"),
            Err(error) => error,
        };
    assert!(matches!(error, Error::Spawn(_)));
    assert!(error.to_string().contains("Python runtime not found"));
    let client = Client::with_config(config()).unwrap();
    let error = client
        .call(json!({"action":"exit", "scope":"s"}))
        .unwrap_err();
    assert!(matches!(error, Error::RuntimeExited(_)));
    assert!(error
        .to_string()
        .contains("installed in the configured Python runtime"));

    // A child that closes stdin before a large request triggers the write-side
    // missing-module path rather than stdout EOF. It needs the same useful error.
    let mut cfg = config();
    cfg.python_args = vec![
        OsString::from("-c"),
        OsString::from("import sys; sys.exit(1)"),
    ];
    let client = Client::with_config(cfg).unwrap();
    let error = client
        .put("s", &"x".repeat(1_000_000), json!(null))
        .unwrap_err();
    assert!(matches!(error, Error::RuntimeExited(_)));
    assert!(error
        .to_string()
        .contains("installed in the configured Python runtime"));
}

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn marker() -> PathBuf {
    std::env::temp_dir().join(format!(
        "context-folding-rust-{}-{}.closed",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ))
}

#[test]
fn close_and_drop_deliver_eof_and_wait_for_exit() {
    for explicitly_close in [true, false] {
        let marker = marker();
        let mut cfg = config();
        cfg.state = marker.clone();
        let client = Client::with_config(cfg).unwrap();
        client.list("s", json!(null)).unwrap();
        if explicitly_close {
            client.close().unwrap();
        }
        drop(client);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "closed");
        std::fs::remove_file(marker).unwrap();
    }
}

#[test]
fn shutdown_is_bounded_for_unresponsive_engine() {
    let mut cfg = config();
    cfg.shutdown_timeout = Duration::from_millis(40);
    let client = Client::with_config(cfg).unwrap();
    client
        .call(json!({"action":"hang-close", "scope":"s"}))
        .unwrap();
    let start = Instant::now();
    client.close().unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn installed_core_delays_annotations_and_recovers_exact_source() {
    let Some(core_path) = std::env::var_os("CONTEXT_FOLDING_REAL_CORE_PATH") else {
        eprintln!("SKIP: actual engine test; set CONTEXT_FOLDING_REAL_CORE_PATH");
        return;
    };
    let directory = marker().with_extension("dir");
    std::fs::create_dir(&directory).unwrap();
    let mut cfg = Config::new(directory.join("archive.sqlite"));
    cfg.env.insert(OsString::from("PYTHONPATH"), core_path);
    let client = Client::with_config(cfg).unwrap();
    let text = format!("# @context-fold begin evidence\n{}# @context-fold end evidence\n",
        "# 原文🙂 evidence\n".repeat(80));
    let request = |cycle, occurrence| json!({
        "action": "read-source", "scope": "real", "text": text,
        "language": "python", "occurrence": occurrence, "requestCycle": cycle
    });
    let first = client.call(request(0, "read-1")).unwrap();
    assert_eq!(first["text"], text);
    assert_eq!(client.call(request(0, "read-1")).unwrap()["text"], text);
    let folded = client.call(request(1, "read-1")).unwrap();
    let view = folded["text"].as_str().unwrap();
    assert!(view.contains("[[cf:v2:"));
    assert_eq!(client.call(request(2, "read-2")).unwrap()["text"], text);
    let resolved = client.resolve("real", json!({"content": view})).unwrap();
    assert_eq!(resolved["value"]["content"], text);
    let id = first["id"].as_str().unwrap();
    assert!(client.read("real", id, json!({"limit": 120})).unwrap()["text"].as_str().unwrap().chars().count() <= 120);
    client.grep("real", "evidence", json!({"id": id, "limit": 2})).unwrap();
    client.meta("real", id, json!({})).unwrap();
    assert_eq!(client.call(request(3, "read-1")).unwrap()["text"], folded["text"]);
    assert!(matches!(client.call(json!({
        "action": "mark", "scope": "real", "id": id,
        "disposition": "foldable", "summary": "obsolete"
    })), Err(Error::Remote { .. })));
    assert!(client.list("real", json!({})).is_ok());
    client.close().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn installed_core_folds_submitted_text_and_returns_recoverable_references() {
    let Some(core_path) = std::env::var_os("CONTEXT_FOLDING_REAL_CORE_PATH") else {
        eprintln!("SKIP: actual engine test; set CONTEXT_FOLDING_REAL_CORE_PATH");
        return;
    };
    let directory = marker().with_extension("dir");
    std::fs::create_dir(&directory).unwrap();
    let mut cfg = Config::new(directory.join("archive.sqlite"));
    cfg.env.insert(OsString::from("PYTHONPATH"), core_path);
    let client = Client::with_config(cfg).unwrap();
    let empty = client.fold("fold-test", "", json!({})).unwrap();
    assert_eq!(empty["scope"], "fold-test");
    assert_eq!(empty["text"], "");
    assert_eq!(empty["references"], json!([]));
    let body = "completed 中文🙂\n".repeat(80).trim_end_matches('\n').to_owned();
    let prefix = format!("{}<!-- @context-fold begin evidence -->\r\n", "visible\n".repeat(800));
    let suffix = "\r\n<!-- @context-fold end evidence -->\r\nlast line without newline";
    let text = format!("{prefix}{body}{suffix}");
    let folded = client.fold("fold-test", &text, json!({})).unwrap();
    assert_eq!(folded["references"].as_array().unwrap().len(), 1);
    let reference = &folded["references"][0];
    assert_eq!(reference["label"], "evidence");
    assert_eq!(reference["id"], reference["sha256"]);
    let id = reference["id"].as_str().unwrap();
    assert_eq!(id.len(), 64);
    let literal = reference["reference"].as_str().unwrap();
    assert!(literal.starts_with("[[cf:v2:"));
    assert_eq!(folded["text"], format!("{prefix}{literal}{suffix}"));
    let resolved = client.resolve("fold-test", folded["text"].clone()).unwrap();
    assert_eq!(resolved["value"], text);
    assert_eq!(client.read("fold-test", id, json!({})).unwrap()["text"], body);
    assert!(matches!(client.read("another-scope", id, json!({})), Err(Error::Remote { .. })));
    client.close().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn installed_core_queries_nested_regions_without_unfolding() {
    let Some(core_path) = std::env::var_os("CONTEXT_FOLDING_REAL_CORE_PATH") else {
        eprintln!("SKIP: actual engine test; set CONTEXT_FOLDING_REAL_CORE_PATH");
        return;
    };
    let directory = marker().with_extension("dir");
    std::fs::create_dir(&directory).unwrap();
    let mut cfg = Config::new(directory.join("archive.sqlite"));
    cfg.env.insert(OsString::from("PYTHONPATH"), core_path);
    let client = Client::with_config(cfg).unwrap();
    let detail = format!("{} needle=42 中文🙂\n", "x".repeat(350)).repeat(20);
    let text = format!("<!-- @context-fold begin parent -->\nparent summary\n<!-- @context-fold begin child -->\n{detail}<!-- @context-fold end child -->\n<!-- @context-fold end parent -->");
    let folded = client.fold("nested", &text, json!({})).unwrap();
    assert_eq!(folded["references"].as_array().unwrap().len(), 1);
    let id = folded["references"][0]["id"].as_str().unwrap();
    let metadata = client.meta("nested", id, json!({})).unwrap();
    assert_eq!(metadata["sha256"], id);
    assert_eq!(metadata["childCount"], 1);
    assert!(metadata.get("text").is_none());
    let child_id = metadata["children"][0].as_str().unwrap();
    let listed = client.list("nested", json!({"id": id, "depth": 1, "limit": 10})).unwrap();
    assert!(listed["entries"].as_array().unwrap().iter().any(|entry| entry["id"] == child_id));
    let parent = client.read("nested", id, json!({"limit": 1000})).unwrap();
    assert!(parent["text"].as_str().unwrap().contains("[[cf:v2:"));
    assert!(!parent["text"].as_str().unwrap().contains("needle=42"));
    assert_ne!(parent["sha256"], parent["viewSha256"]);
    let line = client.read("nested", id, json!({"startLine": 1, "endLine": 1, "limit": 60})).unwrap();
    assert!(line["text"].as_str().unwrap().starts_with("parent summary"));
    let found = client.grep("nested", "needle=42", json!({"id": id, "limit": 2, "context": 1})).unwrap();
    assert_eq!(found["matches"].as_array().unwrap().len(), 2);
    assert_eq!(found["matches"][0]["id"], child_id);
    assert!(found["matches"].as_array().unwrap().iter().all(|hit| {
        let snippet = hit["text"].as_str().unwrap();
        snippet.contains("needle=42") && snippet.chars().count() <= 160
    }));
    assert_eq!(client.grep("nested", "needle=42", json!({"id": id, "recursive": false})).unwrap()["matches"], json!([]));
    assert!(client.read("nested", child_id, json!({})).unwrap()["text"].as_str().unwrap().chars().count() <= 1200);
    assert_eq!(client.fold("nested", &text, json!({})).unwrap()["text"], folded["text"]);
    client.close().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
