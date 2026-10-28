# C# bridge SDK

An asynchronous .NET bridge to the shared Python engine used by `ctxf` and MCP. It targets .NET 10 and uses framework libraries only. Each client owns one persistent `python3 -m context_folding rpc --state PATH` child.

Install Python with `uv sync --project context-folding`, select that interpreter, and add a reference to `ContextFolding/ContextFolding.csproj`. Use the same state path and scope as the CLI to share references.

```csharp
using ContextFolding;

await using var client = new Client(new ClientOptions("/absolute/private/archive.sqlite3")
{
    PythonExecutable = "/path/to/venv/bin/python",
});
var text = await File.ReadAllTextAsync("notes.txt");
var folded = await client.FoldAsync("task", text);
var references = folded.GetProperty("references");
if (references.GetArrayLength() > 0)
{
    var id = references[0].GetProperty("id").GetString()!;
    Console.WriteLine(await client.MetaAsync("task", id));
    Console.WriteLine(await client.ListAsync("task", new Dictionary<string, object?> { ["id"] = id, ["depth"] = 2, ["limit"] = 5 }));
    Console.WriteLine(await client.GrepAsync("task", "timeout", new Dictionary<string, object?> { ["id"] = id, ["limit"] = 3 }));
    Console.WriteLine(await client.ReadAsync("task", id, new Dictionary<string, object?> { ["startLine"] = 1, ["endLine"] = 4, ["limit"] = 240 }));
}
```

## Operations

`FoldAsync`, `ListAsync`, `GrepAsync`, `MetaAsync` and `ReadAsync` return a detached `JsonElement`. Each accepts optional fields and a cancellation token. Fold/read/meta take text or ID respectively; grep takes a literal query. Explicit arguments override extra fields.

Read/grep/list/meta do not set keep or unfold history. Read defaults to 1200 Unicode code points, maximum 24000, and preserves direct child references. Use inclusive `startLine`/`endLine` or `offset`, not both. Python offsets are not .NET UTF-16 string indices. List/grep/meta default to 10 items, maximum 100; grep additionally accepts `id`, `recursive`, `context`, `offset` and `limit`.

Fold accepts empty text and optional `language` / `commentStyles`. Its result contains `scope`, complete `text`, and top-level references with full-SHA `id`, `sha256`, `label`, short `reference` and `archiveId`. Query children with list/meta or recursive grep. Original `sha256` and node `viewSha256` describe different bytes.

`CallAsync` forwards complete requests, including host-only `read-source` cycles and status. Legacy archive/export wrappers remain compatible, but normal examples query small views. The bridge cannot rewrite history or infer model-request progress.

## Transport and lifecycle

JSON Lines calls are serialized; stderr is drained. Application errors throw `ContextFoldingException` with a code and preserve the process. Malformed responses or process failures close it.

Queued cancellation preserves the stream. Active cancellation terminates it because RPC has no cancellation IDs. `DisposeAsync` is repeatable and does not delete the archive. There is no implicit timeout; use a cancellation token for deadlines.

`ClientOptions` also provides working directory, environment overrides, `PythonArguments` (default `-m context_folding rpc`) and `MaxResponseChars` (64 Mi characters). `--state PATH` is appended; diagnostics retain at most 16 Ki characters. Payload encoding is UTF-8.

## Verify

```sh
dotnet run --project Tests/Tests.csproj
dotnet run --project Example/Example.csproj
```

Process tests require Python. Set `CONTEXT_FOLDING_REAL_CORE_PATH=/absolute/path/context-folding/python` for actual-core fold/nested-query/delay checks; otherwise that part reports a skip. Source examples can set `PYTHONPATH` instead of installing the package. Installing the Python CLI does not install .NET.
