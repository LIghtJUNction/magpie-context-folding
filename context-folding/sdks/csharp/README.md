# C# bridge SDK

This is an asynchronous .NET **bridge SDK**, not a native C# folding core. Install the standalone Python package first with uv (from `context-folding`: `uv venv` then `uv pip install --python .venv/bin/python .`). Set `PythonExecutable` to that environment's Python. Python is required at runtime; there is no Magpie dependency. The project targets the installed .NET 10 SDK and uses only framework libraries, with no third-party NuGet packages.

Add a project reference to `ContextFolding/ContextFolding.csproj`. Each `Client` owns one persistent `python3 -m context_folding rpc --state PATH` subprocess, serializes requests over JSON Lines, drains stderr, and returns a detached `JsonElement` from the response `result`. Engine errors throw `ContextFoldingException` carrying `Code`; invalid responses and transport failures close the bridge.

```csharp
using ContextFolding;

await using var client = new Client(new ClientOptions("/absolute/path/archive.sqlite")
{
    PythonExecutable = "/path/to/venv/bin/python", // optional; default python3
});
var item = await client.PutAsync("session", "Original evidence",
    new Dictionary<string, object?> { ["role"] = "tool" });
var id = item.GetProperty("id").GetString()!;
await client.MarkAsync("session", id, "foldable",
    new Dictionary<string, object?> { ["summary"] = "Historical evidence; original retained." });
Console.WriteLine(await client.ListAsync("session"));
Console.WriteLine(await client.ReadAsync("session", id));
Console.WriteLine(await client.RenderAsync("session", [id]));
Console.WriteLine(await client.ResolveAsync("session", new { content = $"[[cf:v1:{id}]]" }));
```

`CallAsync(IReadOnlyDictionary<string,object?> request, CancellationToken)` exposes all operations. `PutAsync`, `ListAsync`, `ReadAsync`, `MarkAsync`, `RenderAsync`, and `ResolveAsync` wrap common operations; each accepts optional extra fields and a cancellation token. Extra fields follow the Python engine protocol; wrappers preserve their explicit action/scope/ID arguments. `read` offsets, limits and character counts use Python Unicode code points, not .NET UTF-16 code units; do not derive offsets from `string.Length` when text contains supplementary characters.

Cancellation while waiting in the queue leaves the process usable and throws `OperationCanceledException`. Cancellation after dispatch closes the process and throws `ContextFoldingException` with code `cancelled`; create a new client afterward. The ordered protocol has no request IDs or remote cancellation message. `DisposeAsync` terminates the process and rejects outstanding requests; it is repeatable and does not delete the archive. There is no implicit timeout: use `CancellationTokenSource` for deadlines.

`ClientOptions` also exposes `WorkingDirectory`, environment overrides, `PythonArguments` (defaults to `-m context_folding rpc`; `--state PATH` is always appended), and `MaxResponseChars` (64 Mi characters default). stderr diagnostics retain at most 16 Ki characters. Requests and responses use UTF-8.

Run `dotnet run --project Tests/Tests.csproj` for package-free subprocess integration tests using a temporary Python RPC process. They cover persistence/concurrent requests, wrapper forwarding, Unicode, stderr pressure, application/protocol errors, response limits, process exit, cancellation, disposal, and failed startup. Set `CONTEXT_FOLDING_REAL_CORE_PATH=/absolute/path/context-folding/python` when running the tests to additionally check the actual Python core; otherwise that portion prints an explicit skip. After installing the Python core, run `dotnet run --project Example/Example.csproj` for an actual-engine example; source checkout execution can instead set `PYTHONPATH=/absolute/path/context-folding/python`.
