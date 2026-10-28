using ContextFolding;

// Install the independent Python package first; the bridge has no Magpie dependency.
await using var client = new Client(new ClientOptions("./context-state.sqlite"));
var text = "<!-- @context-fold begin investigation -->\n"
    + string.Concat(Enumerable.Repeat("Archived evidence from a completed step.\n", 30))
    + "<!-- @context-fold end investigation -->\n";
var folded = await client.FoldAsync("example", text);
Console.Write(folded.GetProperty("text").GetString()); // Explicit fold is immediate.
Console.WriteLine(await client.ResolveAsync("example", new { content = folded.GetProperty("text").GetString() }));
var references = folded.GetProperty("references");
if (references.GetArrayLength() > 0)
    Console.WriteLine(await client.ReadAsync("example", references[0].GetProperty("id").GetString()!));
