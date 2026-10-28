# C# bridge SDK

This is an asynchronous .NET **bridge SDK**, not a native C# folding core. Install the standalone Python package first with uv (from `context-folding`: `uv venv` then `uv pip install --python .venv/bin/python .`). Set `PythonExecutable` to that environment's Python. Python is required at runtime; there is no Magpie dependency. The project targets the installed .NET 10 SDK and uses only framework libraries, with no third-party NuGet packages.

Add a project reference to `ContextFolding/ContextFolding.csproj`. Each `Client` owns one persistent `python3 -m context_folding rpc --state PATH` subprocess, serializes requests over JSON Lines, drains stderr, and returns a detached `JsonElement` from the response `result`. Engine errors throw `ContextFoldingException` carrying `Code`; invalid responses and transport failures close the bridge.

This is the same engine used by `ctxf fold` and `ctxf rpc`. Point `ClientOptions` at their archive file and use the same scope to share references. The SDK requires an explicit state path and scope; it does not assume the CLI's `default` scope.

```csharp
using ContextFolding;

await using var client = new Client(new ClientOptions("/absolute/path/archive.sqlite")
{
    PythonExecutable = "/path/to/venv/bin/python", // optional; default python3
});
var text = "<!-- @context-fold begin investigation -->\n"
    + string.Concat(Enumerable.Repeat("Completed investigation detail.\n", 40))
    + "<!-- @context-fold end investigation -->\n";
var folded = await client.FoldAsync("session", text);
Console.Write(folded.GetProperty("text").GetString());
Console.WriteLine(await client.ResolveAsync("session", new { content = folded.GetProperty("text").GetString() }));
var references = folded.GetProperty("references");
if (references.GetArrayLength() > 0)
    Console.WriteLine(await client.ReadAsync("session", references[0].GetProperty("id").GetString()!));
```

`FoldAsync(scope, text, fields?, cancellationToken)` forwards the explicit immediate operation. Empty text is valid; optional fields include `sourceId`, `language` and `commentStyles`. The result contains `scope`, complete `text`, and `references`. Each reference includes an occurrence `id` / `nodeId` / `archiveId`, a separate body `sha256` / `contentHash`, a `label`, and a v3 `reference` carrying the complete 64-digit node ID. Only bodies replaced by this call are listed. The caller consumes the returned view; the bridge does not rewrite model history.

`CallAsync(IReadOnlyDictionary<string,object?> request, CancellationToken)` exposes all operations. `PutAsync`, `ListAsync`, `SearchAsync`, `MetaAsync`, `ReadAsync`, `RenderAsync`, and `ResolveAsync` wrap other common operations; each accepts optional extra fields and a cancellation token. `ListAsync`, `SearchAsync`, `MetaAsync` and `ReadAsync` are read-only. New v3 references carry occurrence node IDs; their separate `sha256` fields identify body content. Use `CallAsync` for explicit `restore` and `read-source`, including `occurrence` and `requestCycle`; its default delay remains unchanged by `fold`. A fresh source read needs a fresh occurrence; retries keep the same cycle. The bridge does not observe model requests or advance cycles itself. `mark` and `group` are removed.

Extra fields follow the Python engine protocol; wrappers preserve their explicit action/scope/text/ID arguments. `read` offsets, limits and character counts use Python Unicode code points, not .NET UTF-16 code units; do not derive offsets from `string.Length` when text contains supplementary characters.

Cancellation while waiting in the queue leaves the process usable and throws `OperationCanceledException`. Cancellation after dispatch closes the process and throws `ContextFoldingException` with code `cancelled`; create a new client afterward. The ordered protocol has no request IDs or remote cancellation message. `DisposeAsync` terminates the process and rejects outstanding requests; it is repeatable and does not delete the archive. There is no implicit timeout: use `CancellationTokenSource` for deadlines.

`ClientOptions` also exposes `WorkingDirectory`, environment overrides, `PythonArguments` (defaults to `-m context_folding rpc`; `--state PATH` is always appended), and `MaxResponseChars` (64 Mi characters default). stderr diagnostics retain at most 16 Ki characters. Requests and responses use UTF-8.

Run `dotnet run --project Tests/Tests.csproj` for package-free subprocess integration tests using a temporary Python RPC process. They cover persistence/concurrent requests, wrapper forwarding, Unicode, stderr pressure, application/protocol errors, response limits, process exit, cancellation, disposal, and failed startup. Set `CONTEXT_FOLDING_REAL_CORE_PATH=/absolute/path/context-folding/python` when running the tests to additionally check immediate `fold`, empty input, complete views, exact UTF-8 hashes and scoped recovery, plus source annotation delay, retries and fresh occurrences against the actual Python core; otherwise that portion prints an explicit skip. After installing the Python core, run `dotnet run --project Example/Example.csproj` for an actual-engine example; source checkout execution can instead set `PYTHONPATH=/absolute/path/context-folding/python`.
