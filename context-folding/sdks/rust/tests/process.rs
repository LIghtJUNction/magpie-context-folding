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
        client.mark("s", "id", "foldable", "summary").unwrap()["request"],
        json!({
            "action":"mark", "scope":"s", "id":"id", "disposition":"foldable", "summary":"summary"
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
