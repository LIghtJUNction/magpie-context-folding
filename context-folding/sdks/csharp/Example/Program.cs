using ContextFolding;

// Install the independent Python package first; the bridge has no Magpie dependency.
await using var client = new Client(new ClientOptions("./context-state.sqlite"));
var text = "# @context-fold begin investigation\n"
    + string.Concat(Enumerable.Repeat("# Archived evidence from a completed step.\n", 30))
    + "# @context-fold end investigation\n";
Dictionary<string, object?> Request(int cycle) => new()
{
    ["action"] = "read-source", ["scope"] = "example", ["text"] = text,
    ["language"] = "python", ["occurrence"] = "read-1", ["requestCycle"] = cycle,
};
var first = await client.CallAsync(Request(0));
Console.WriteLine(first.GetProperty("text")); // First observation remains complete.
var folded = await client.CallAsync(Request(1));
Console.WriteLine(folded.GetProperty("text"));
Console.WriteLine(await client.ResolveAsync("example", new { content = folded.GetProperty("text").GetString() }));
Console.WriteLine(await client.ReadAsync("example", first.GetProperty("id").GetString()!));
