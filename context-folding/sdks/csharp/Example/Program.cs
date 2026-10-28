using ContextFolding;

// Install the independent Python package first; the bridge has no Magpie dependency.
await using var client = new Client(new ClientOptions("./context-state.sqlite"));
var text = "<!-- @context-fold begin investigation -->\n"
    + "Next step: check the parser timeout.\n<!-- @context-fold begin trace -->\n"
    + string.Concat(Enumerable.Repeat("Observed timeout while reading the parser response.\n", 30))
    + "<!-- @context-fold end trace -->\n"
    + "<!-- @context-fold end investigation -->\n";
var folded = await client.FoldAsync("example", text);
Console.Write(folded.GetProperty("text").GetString()); // Explicit fold is immediate.
var references = folded.GetProperty("references");
if (references.GetArrayLength() > 0)
{
    var id = references[0].GetProperty("id").GetString()!;
    Console.WriteLine(await client.MetaAsync("example", id));
    Console.WriteLine(await client.ListAsync("example", new Dictionary<string, object?> { ["id"] = id, ["depth"] = 2, ["limit"] = 5 }));
    Console.WriteLine(await client.GrepAsync("example", "timeout", new Dictionary<string, object?> { ["id"] = id, ["limit"] = 3 }));
    Console.WriteLine(await client.ReadAsync("example", id, new Dictionary<string, object?> { ["limit"] = 160 }));
}
