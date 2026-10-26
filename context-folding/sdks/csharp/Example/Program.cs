using ContextFolding;

// Install the independent Python package first. The bridge has no Magpie dependency.
await using var client = new Client(new ClientOptions("./context-state.sqlite"));
var item = await client.PutAsync("example", "Historical tool output", new Dictionary<string, object?> { ["role"] = "tool" });
var id = item.GetProperty("id").GetString()!;
await client.MarkAsync("example", id, "foldable", new Dictionary<string, object?> { ["summary"] = "Tool completed; original evidence is archived." });
Console.WriteLine(await client.RenderAsync("example", [id]));
Console.WriteLine(await client.ReadAsync("example", id));
Console.WriteLine(await client.ResolveAsync("example", new { content = $"[[cf:v1:{id}]]" }));
