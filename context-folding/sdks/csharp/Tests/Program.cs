using ContextFolding;
using System.Text;
using System.Text.Json;

var directory = Path.Combine(Path.GetTempPath(), "cf-csharp-" + Guid.NewGuid());
Directory.CreateDirectory(directory);
var script = Path.Combine(directory, "fake.py");
await File.WriteAllTextAsync(script, """
import json, os, sys, time
for line in sys.stdin:
    request = json.loads(line)
    action = request['action']
    if action == 'slow': time.sleep(0.3)
    if action == 'hang': time.sleep(30)
    if action == 'exit': sys.exit(7)
    if action == 'bad':
        print('not json', flush=True)
        continue
    if action == 'large':
        print('x' * 5000, flush=True)
        continue
    if action == 'stderr':
        sys.stderr.write('diagnostic' * 100000)
        sys.stderr.flush()
    if action == 'error':
        print(json.dumps({'error': {'code': 'missing', 'message': 'No such item'}}), flush=True)
        continue
    print(json.dumps({'result': {'request': request, 'pid': os.getpid(), 'argv': sys.argv[1:]}}), flush=True)
""");
Client NewClient(int limit = 64 * 1024 * 1024) => new(new ClientOptions(Path.Combine(directory, "state with spaces.sqlite"))
{
    PythonArguments = ["-u", script], MaxResponseChars = limit,
});
static void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
}
static async Task Reject(Task task, string? code = null)
{
    try { await task.WaitAsync(TimeSpan.FromSeconds(5)); }
    catch (ContextFoldingException error) when (code is null || error.Code == code) { return; }
    catch (OperationCanceledException) when (code == "cancelled") { return; }
    throw new Exception($"Expected rejection {code}");
}
static string Action(JsonElement value) => value.GetProperty("request").GetProperty("action").GetString()!;
try
{
    await using (var client = NewClient())
    {
        var values = await Task.WhenAll(
            client.PutAsync("scope", "原文🙂", new Dictionary<string, object?> { ["role"] = "tool", ["action"] = "wrong" }),
            client.ListAsync("scope", new Dictionary<string, object?> { ["depth"] = 2 }),
            client.ReadAsync("scope", "entry"),
            client.CallAsync(new Dictionary<string, object?> { ["action"] = "read-source", ["scope"] = "scope", ["text"] = "# source", ["occurrence"] = "read-1", ["requestCycle"] = 0 }),
            client.RenderAsync("scope", ["entry"]),
            client.ResolveAsync("scope", new { content = "[[cf:v1:entry]]" }),
            client.FoldAsync("scope", "", new Dictionary<string, object?>
            {
                ["action"] = "wrong", ["scope"] = "wrong", ["text"] = "wrong",
                ["language"] = "explicit", ["commentStyles"] = new[] { new { start = ";;" } },
            }),
            client.SearchAsync("scope", "needle🙂", new Dictionary<string, object?>
            {
                ["action"] = "wrong", ["scope"] = "wrong", ["query"] = "wrong", ["id"] = "parent", ["limit"] = 1,
            }),
            client.MetaAsync("scope", "entry", new Dictionary<string, object?> { ["action"] = "wrong", ["id"] = "wrong", ["offset"] = 1 }));
        Check(values.Select(v => v.GetProperty("pid").GetInt32()).Distinct().Count() == 1, "Process must persist");
        Check(values.Select(Action).SequenceEqual(new[] { "put", "list", "read", "read-source", "render", "resolve", "fold", "search", "meta" }), "Wrappers forward actions");
        Check(values[0].GetProperty("request").GetProperty("text").GetString() == "原文🙂", "Unicode round trip");
        Check(values[0].GetProperty("argv")[1].GetString()!.EndsWith("state with spaces.sqlite"), "ArgumentList preserves spaces");
        var foldRequest = values[6].GetProperty("request");
        Check(foldRequest.GetProperty("scope").GetString() == "scope" && foldRequest.GetProperty("text").GetString() == "", "Fold preserves explicit arguments and empty text");
        Check(foldRequest.GetProperty("commentStyles")[0].GetProperty("start").GetString() == ";;", "Fold forwards comment styles");
        var searchRequest = values[7].GetProperty("request");
        Check(searchRequest.GetProperty("query").GetString() == "needle🙂" && searchRequest.GetProperty("scope").GetString() == "scope", "Search preserves explicit arguments");
        Check(values[8].GetProperty("request").GetProperty("id").GetString() == "entry", "Meta preserves explicit ID");
        await Reject(client.CallAsync(new Dictionary<string, object?> { ["action"] = "error", ["scope"] = "s" }), "missing");
        Check(Action(await client.CallAsync(new Dictionary<string, object?> { ["action"] = "stderr", ["scope"] = "s" })) == "stderr", "stderr drained");
        var slow = client.CallAsync(new Dictionary<string, object?> { ["action"] = "slow", ["scope"] = "s" });
        using var queued = new CancellationTokenSource();
        var waiting = client.ListAsync("s", cancellationToken: queued.Token);
        queued.Cancel();
        await Reject(waiting, "cancelled");
        await slow;
        Check(Action(await client.ListAsync("s")) == "list", "Queued cancellation preserves stream");
        using var active = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
        await Reject(client.CallAsync(new Dictionary<string, object?> { ["action"] = "hang", ["scope"] = "s" }, active.Token), "cancelled");
        await Reject(client.ListAsync("s"), "cancelled");
    }
    foreach (var action in new[] { "bad", "large", "exit" })
    {
        await using var client = NewClient(1024);
        await Reject(client.CallAsync(new Dictionary<string, object?> { ["action"] = action, ["scope"] = "s" }));
    }
    var disposed = NewClient();
    var hanging = disposed.CallAsync(new Dictionary<string, object?> { ["action"] = "hang", ["scope"] = "s" });
    await disposed.DisposeAsync();
    await Reject(hanging, "disposed");
    await Reject(disposed.ListAsync("s"), "disposed");
    await disposed.DisposeAsync();
    try
    {
        await using var missing = new Client(new ClientOptions(":memory:") { PythonExecutable = "/no-such-context-folding-python" });
        throw new Exception("Missing executable should fail");
    }
    catch (ContextFoldingException error) when (error.Code == "transport") { }
    Console.WriteLine("PASS: persistent process, wrappers, Unicode, stderr, errors, queued/active cancellation, invalid output, exit, disposal and spawn failure");
    var corePath = Environment.GetEnvironmentVariable("CONTEXT_FOLDING_REAL_CORE_PATH");
    if (corePath is not null)
    {
        await using var real = new Client(new ClientOptions(Path.Combine(directory, "real.sqlite"))
        {
            Environment = new Dictionary<string, string?> { ["PYTHONPATH"] = corePath },
        });
        var text = "# @context-fold begin evidence\n"
            + string.Concat(Enumerable.Repeat("# 原文🙂 evidence\n", 80))
            + "# @context-fold end evidence\n";
        Dictionary<string, object?> SourceRequest(int cycle, string occurrence = "read-1") => new()
        {
            ["action"] = "read-source", ["scope"] = "real", ["text"] = text,
            ["language"] = "python", ["occurrence"] = occurrence, ["requestCycle"] = cycle,
        };
        var first = await real.CallAsync(SourceRequest(0));
        Check(first.GetProperty("text").GetString() == text, "First observation remains complete");
        Check((await real.CallAsync(SourceRequest(0))).GetProperty("text").GetString() == text, "Retry must not consume delay");
        var folded = await real.CallAsync(SourceRequest(1));
        var view = folded.GetProperty("text").GetString()!;
        Check(view.Contains("[[cf:v3:"), "Explicit source markers fold after delay");
        Check((await real.CallAsync(SourceRequest(2, "read-2"))).GetProperty("text").GetString() == text, "New occurrence gets its own delay");
        var resolved = await real.ResolveAsync("real", new { content = view });
        Check(resolved.GetProperty("value").GetProperty("content").GetString() == text, "Exact annotated source recovery");
        var id = first.GetProperty("id").GetString()!;
        Check((await real.ReadAsync("real", id)).GetProperty("text").GetString() == text, "Read returns original");
        Check((await real.CallAsync(SourceRequest(3))).GetProperty("text").GetString()!.Contains("[[cf:v3:"), "Reading preserves folding");
        await real.CallAsync(new Dictionary<string, object?> { ["action"] = "restore", ["scope"] = "real", ["id"] = id });
        Check((await real.CallAsync(SourceRequest(4))).GetProperty("text").GetString() == text, "Explicitly restored source stays visible");
        var item = await real.PutAsync("real", "A🙂B", new Dictionary<string, object?> { ["role"] = "tool" });
        var read = await real.ReadAsync("real", item.GetProperty("id").GetString()!, new Dictionary<string, object?> { ["offset"] = 1, ["limit"] = 1 });
        Check(read.GetProperty("text").GetString() == "🙂" && read.GetProperty("nextOffset").GetInt32() == 2, "Python Unicode code-point offsets");
        await Reject(real.CallAsync(new Dictionary<string, object?>
        {
            ["action"] = "mark", ["scope"] = "real", ["id"] = id,
            ["disposition"] = "foldable", ["summary"] = "obsolete",
        }));
        await real.ListAsync("real");
        Console.WriteLine("PASS: actual Python source marker delay, retry, fresh occurrence, exact recovery, keep and Unicode offsets");
        var empty = await real.FoldAsync("fold-test", "");
        Check(empty.GetProperty("scope").GetString() == "fold-test" && empty.GetProperty("text").GetString() == "", "Fold accepts empty text");
        Check(empty.GetProperty("references").GetArrayLength() == 0, "Empty text has no references");
        var body = string.Concat(Enumerable.Repeat("completed 中文🙂\n", 80)).TrimEnd('\n');
        var prefix = string.Concat(Enumerable.Repeat("visible\n", 800)) + "<!-- @context-fold begin evidence -->\r\n";
        var suffix = "\r\n<!-- @context-fold end evidence -->\r\nlast line without newline";
        var submitted = prefix + body + suffix;
        var immediate = await real.FoldAsync("fold-test", submitted);
        var references = immediate.GetProperty("references");
        Check(references.GetArrayLength() == 1, "Explicit fold is immediate");
        var reference = references[0];
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
        var nodeId = reference.GetProperty("id").GetString()!;
        Check(nodeId.Length == 64 && nodeId != hash, "Occurrence identity is separate from body hash");
        Check(reference.GetProperty("sha256").GetString() == hash && reference.GetProperty("contentHash").GetString() == hash, "Fold hashes exact UTF-8 body");
        Check(reference.GetProperty("nodeId").GetString() == nodeId && reference.GetProperty("archiveId").GetString() == nodeId, "Reference carries occurrence ID");
        Check(reference.GetProperty("reference").GetString() == $"[[cf:v3:{nodeId}]]", "New references address occurrences");
        Check(reference.GetProperty("label").GetString() == "evidence", "Fold returns marker label");
        var immediateText = immediate.GetProperty("text").GetString()!;
        Check(immediateText == prefix + reference.GetProperty("reference").GetString() + suffix, "Fold returns full text without an extra newline");
        Check((await real.ResolveAsync("fold-test", immediateText)).GetProperty("value").GetString() == submitted, "Immediate fold recovers exact text");
        Check((await real.ReadAsync("fold-test", nodeId)).GetProperty("text").GetString() == body, "Occurrence ID reads original marked body");
        await Reject(real.ReadAsync("another-scope", nodeId));
        Console.WriteLine("PASS: immediate fold, empty input, complete view, Unicode hash and scoped recovery");
        var childBody = "intro🙂 Needle 中文 end\n" + string.Concat(Enumerable.Repeat("saved detail\n", 20)).TrimEnd('\n');
        string Region(string label) => $"<!-- @context-fold begin {label} -->\n{childBody}\n<!-- @context-fold end {label} -->";
        var nested = $"<!-- @context-fold begin parent -->\n{Region("first")}\n{Region("second")}\n<!-- @context-fold end parent -->";
        var tree = await real.FoldAsync("tree", nested, new Dictionary<string, object?> { ["sourceId"] = "conversation:42" });
        Check(tree.GetProperty("references").GetArrayLength() == 1, "Only outermost body is replaced");
        var parentId = tree.GetProperty("references")[0].GetProperty("id").GetString()!;
        var children = (await real.ListAsync("tree", new Dictionary<string, object?> { ["parentId"] = parentId })).GetProperty("entries");
        Check(children.GetArrayLength() == 2, "Identical siblings remain distinct occurrences");
        var firstChild = children[0].GetProperty("id").GetString()!;
        var secondChild = children[1].GetProperty("id").GetString()!;
        Check(firstChild != secondChild && children[0].GetProperty("sha256").GetString() == children[1].GetProperty("sha256").GetString(), "Distinct IDs can share content hash");
        Check(children[0].GetProperty("parentId").GetString() == parentId && children[1].GetProperty("parentId").GetString() == parentId, "Parent containment retained");
        var before = await real.MetaAsync("tree", parentId, new Dictionary<string, object?> { ["limit"] = 1 });
        Check(before.GetProperty("children").GetArrayLength() == 1 && before.GetProperty("nextOffset").GetInt32() == 1, "Child metadata is paginated");
        var tail = await real.MetaAsync("tree", parentId, new Dictionary<string, object?> { ["offset"] = 1, ["limit"] = 1 });
        Check(tail.GetProperty("children").GetArrayLength() == 1 && tail.GetProperty("nextOffset").ValueKind == JsonValueKind.Null, "Child metadata page completes");
        var matches = (await real.SearchAsync("tree", "Needle 中文", new Dictionary<string, object?> { ["id"] = parentId, ["caseSensitive"] = true })).GetProperty("matches");
        var leafHits = matches.EnumerateArray().Where(hit => hit.GetProperty("id").GetString() == firstChild || hit.GetProperty("id").GetString() == secondChild).ToArray();
        Check(leafHits.Length == 2, "Search preserves both repeated occurrences");
        foreach (var hit in leafHits)
        {
            Check(hit.GetProperty("offsetUnit").GetString() == "unicode-code-points", "Bridge offsets count Python code points");
            var page = await real.ReadAsync("tree", hit.GetProperty("id").GetString()!, new Dictionary<string, object?>
            {
                ["offset"] = hit.GetProperty("offset").GetInt32(), ["limit"] = "Needle 中文".EnumerateRunes().Count(),
            });
            Check(page.GetProperty("text").GetString() == "Needle 中文", "Search offsets address read's original text");
        }
        Check((await real.MetaAsync("tree", parentId, new Dictionary<string, object?> { ["limit"] = 1 })).GetRawText() == before.GetRawText(), "Queries leave node state unchanged");
        await Reject(real.MetaAsync("other-scope", firstChild));
        Console.WriteLine("PASS: occurrence tree, content deduplication metadata, read-only search/meta and exact match offsets");
    }
    else Console.WriteLine("SKIP: actual engine test; set CONTEXT_FOLDING_REAL_CORE_PATH to context-folding/python");
}
finally { Directory.Delete(directory, recursive: true); }
