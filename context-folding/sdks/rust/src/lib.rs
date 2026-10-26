//! Synchronous Rust bridge to the shared Python context-folding engine.
//!
//! Python 3.10+ and the `context-folding` Python package must be installed in the
//! configured interpreter. This crate is a subprocess bridge, not a native core.
//! One persistent process serves all calls; a mutex serializes request/response
//! pairs, so a client can be shared with `Arc<Client>` across threads.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

pub use serde_json;

/// Runtime settings. Arguments are passed directly, without a shell.
#[derive(Clone, Debug)]
pub struct Config {
    pub python: OsString,
    /// Arguments before `-m context_folding rpc --state PATH`, e.g. `-u`.
    pub python_args: Vec<OsString>,
    pub state: PathBuf,
    /// Optional working directory and environment for finding the Python package.
    pub current_dir: Option<PathBuf>,
    pub env: BTreeMap<OsString, OsString>,
    /// Time allowed for the engine to exit after stdin closes, before killing it.
    pub shutdown_timeout: Duration,
}

impl Config {
    pub fn new(state: impl Into<PathBuf>) -> Self {
        Self {
            python: OsString::from("python3"),
            python_args: Vec::new(),
            state: state.into(),
            current_dir: None,
            env: BTreeMap::new(),
            shutdown_timeout: Duration::from_secs(2),
        }
    }

    pub fn python(mut self, python: impl AsRef<OsStr>) -> Self {
        self.python = python.as_ref().to_owned();
        self
    }
}

/// Failures never include request payloads or raw response text in formatting.
/// Remote error details remain available as fields for explicit inspection.
pub enum Error {
    Spawn(io::Error),
    Io(io::Error),
    Closed,
    Poisoned,
    InvalidRequest,
    InvalidOptions,
    InvalidResponse,
    RuntimeExited(Option<ExitStatus>),
    Remote { code: String, message: String },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) if error.kind() == io::ErrorKind::NotFound => write!(
                f,
                "Python runtime not found; install Python 3.10+ or configure Config.python"
            ),
            Self::Spawn(error) => write!(f, "could not start Python context-folding engine: {error}"),
            Self::Io(error) => write!(f, "context-folding transport failed: {error}"),
            Self::Closed => f.write_str("context-folding client is closed"),
            Self::Poisoned => f.write_str("context-folding client lock is poisoned"),
            Self::InvalidRequest => f.write_str("RPC request must be a JSON object"),
            Self::InvalidOptions => f.write_str("RPC options must be a JSON object or null"),
            Self::InvalidResponse => f.write_str("engine returned an invalid JSON Lines response"),
            Self::RuntimeExited(status) => {
                f.write_str("Python context-folding engine closed stdout")?;
                if let Some(status) = status {
                    write!(f, " ({status})")?;
                }
                f.write_str("; ensure context-folding is installed in the configured Python runtime (see inherited stderr)")
            }
            Self::Remote { .. } => f.write_str("context-folding engine returned an application error; inspect Error::Remote fields for details"),
        }
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Python errors may echo sensitive data, so neither formatter prints them.
        fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn(error) | Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Process {
    fn call(&mut self, request: &Value) -> Result<Value> {
        // Encode before touching the stream, so validation cannot leave a partial request.
        let mut bytes = serde_json::to_vec(request).map_err(|_| Error::InvalidRequest)?;
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or(Error::Closed)?;
        if let Err(error) = stdin.write_all(&bytes).and_then(|_| stdin.flush()) {
            return Err(match error.kind() {
                io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset => {
                    Error::RuntimeExited(self.child.try_wait().ok().flatten())
                }
                _ => Error::Io(error),
            });
        }
        let mut line = Vec::new();
        if self
            .stdout
            .read_until(b'\n', &mut line)
            .map_err(Error::Io)?
            == 0
        {
            return Err(Error::RuntimeExited(self.child.try_wait().ok().flatten()));
        }
        if line.last() != Some(&b'\n') {
            return Err(Error::InvalidResponse);
        }
        let response: Value = serde_json::from_slice(&line).map_err(|_| Error::InvalidResponse)?;
        let object = response.as_object().ok_or(Error::InvalidResponse)?;
        if object.len() != 1 {
            return Err(Error::InvalidResponse);
        }
        if let Some(result) = object.get("result") {
            return Ok(result.clone());
        }
        let error = object
            .get("error")
            .and_then(Value::as_object)
            .ok_or(Error::InvalidResponse)?;
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidResponse)?;
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidResponse)?;
        Err(Error::Remote {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }

    fn close(&mut self, timeout: Duration) -> Result<()> {
        // EOF is the protocol's shutdown signal. Reap the child even on fallback.
        self.stdin.take();
        let start = Instant::now();
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if start.elapsed() < timeout => {
                    thread::sleep(
                        Duration::from_millis(10).min(timeout.saturating_sub(start.elapsed())),
                    );
                }
                Ok(None) => {
                    let killed = self.child.kill();
                    // Reap even if kill races with the child's own exit.
                    self.child.wait().map_err(Error::Io)?;
                    killed.map_err(Error::Io)?;
                    return Ok(());
                }
                Err(error) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return Err(Error::Io(error));
                }
            }
        }
    }
}

/// A persistent, serialized JSON Lines connection to the Python engine.
///
/// Calls block until the engine responds. Call `close` after work is complete;
/// drop also closes stdin, allows a bounded graceful exit, then kills and reaps
/// an unresponsive child. Transport/protocol failures permanently close a client
/// to avoid pairing later requests with a stale response.
pub struct Client {
    process: Mutex<Option<Process>>,
    shutdown_timeout: Duration,
}

impl Client {
    pub fn new(state: impl Into<PathBuf>) -> Result<Self> {
        Self::with_config(Config::new(state))
    }

    pub fn with_config(config: Config) -> Result<Self> {
        let mut command = Command::new(&config.python);
        command
            .args(&config.python_args)
            .args(["-m", "context_folding", "rpc", "--state"])
            .arg(&config.state)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit rather than pipe: Python diagnostics cannot fill an unread pipe.
            .stderr(Stdio::inherit());
        if let Some(directory) = &config.current_dir {
            command.current_dir(directory);
        }
        let mut child = command.spawn().map_err(Error::Spawn)?;
        let stdin = child.stdin.take().expect("piped child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped child stdout"));
        Ok(Self {
            process: Mutex::new(Some(Process {
                child,
                stdin: Some(stdin),
                stdout,
            })),
            shutdown_timeout: config.shutdown_timeout,
        })
    }

    /// Send any RPC object, including engine actions without a convenience method.
    pub fn call(&self, request: Value) -> Result<Value> {
        if !request.is_object() {
            return Err(Error::InvalidRequest);
        }
        let mut guard = self.process.lock().map_err(|_| Error::Poisoned)?;
        let process = guard.as_mut().ok_or(Error::Closed)?;
        let result = process.call(&request);
        if matches!(&result, Err(error) if !matches!(error, Error::Remote { .. } | Error::InvalidRequest))
        {
            if let Some(mut process) = guard.take() {
                let _ = process.close(self.shutdown_timeout);
            }
        }
        result
    }

    /// Store text. Options may include `role`, `source`, or other engine fields.
    pub fn put(&self, scope: &str, text: &str, options: Value) -> Result<Value> {
        let mut request = options_object(options)?;
        request.insert("text".into(), json!(text));
        self.action("put", scope, request)
    }

    /// Read an archived entry. Options are passed through to the engine.
    pub fn read(&self, scope: &str, id: &str, options: Value) -> Result<Value> {
        let mut request = options_object(options)?;
        request.insert("id".into(), json!(id));
        self.action("read", scope, request)
    }

    pub fn list(&self, scope: &str, options: Value) -> Result<Value> {
        self.action("list", scope, options_object(options)?)
    }

    pub fn mark(&self, scope: &str, id: &str, disposition: &str, summary: &str) -> Result<Value> {
        self.action(
            "mark",
            scope,
            options_object(json!({
                "id": id, "disposition": disposition, "summary": summary
            }))?,
        )
    }

    pub fn render(&self, scope: &str, ids: &[&str], protected: &[&str]) -> Result<Value> {
        self.action(
            "render",
            scope,
            options_object(json!({ "ids": ids, "protected": protected }))?,
        )
    }

    pub fn resolve(&self, scope: &str, value: Value) -> Result<Value> {
        self.action("resolve", scope, options_object(json!({ "value": value }))?)
    }

    fn action(&self, action: &str, scope: &str, mut fields: Map<String, Value>) -> Result<Value> {
        fields.insert("action".into(), json!(action));
        fields.insert("scope".into(), json!(scope));
        self.call(Value::Object(fields))
    }

    /// Idempotent shutdown. Other calls wait for their serialized turn.
    pub fn close(&self) -> Result<()> {
        let mut guard = self.process.lock().map_err(|_| Error::Poisoned)?;
        match guard.take() {
            Some(mut process) => process.close(self.shutdown_timeout),
            None => Ok(()),
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let slot = match self.process.get_mut() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut process) = slot.take() {
            let _ = process.close(self.shutdown_timeout);
        }
    }
}

fn options_object(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Null => Ok(Map::new()),
        Value::Object(object) => Ok(object),
        _ => Err(Error::InvalidOptions),
    }
}
