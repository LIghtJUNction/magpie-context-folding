using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ContextFolding;

public sealed record ClientOptions(string StatePath)
{
    public string PythonExecutable { get; init; } = "python3";
    public IReadOnlyList<string> PythonArguments { get; init; } = ["-m", "context_folding", "rpc"];
    public string? WorkingDirectory { get; init; }
    public IReadOnlyDictionary<string, string?>? Environment { get; init; }
    public int MaxResponseChars { get; init; } = 64 * 1024 * 1024;
}

public sealed class ContextFoldingException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

/// <summary>Persistent subprocess bridge to the separately installed Python core.</summary>
public sealed class Client : IAsyncDisposable
{
    private readonly Process process;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task stderrDrain;
    private readonly Task stdoutPump;
    private readonly Task exitWatch;
    private readonly object sync = new();
    private readonly StringBuilder stderr = new();
    private TaskCompletionSource<JsonElement>? pending;
    private ContextFoldingException? failure;
    private readonly int maxResponseChars;

    public Client(ClientOptions options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(options.StatePath);
        if (options.MaxResponseChars < 1) throw new ArgumentOutOfRangeException(nameof(options));
        maxResponseChars = options.MaxResponseChars;
        var start = new ProcessStartInfo(options.PythonExecutable)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false, true),
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var arg in options.PythonArguments) start.ArgumentList.Add(arg);
        start.ArgumentList.Add("--state");
        start.ArgumentList.Add(options.StatePath);
        if (options.WorkingDirectory is not null) start.WorkingDirectory = options.WorkingDirectory;
        if (options.Environment is not null)
            foreach (var pair in options.Environment) start.Environment[pair.Key] = pair.Value;
        process = new Process { StartInfo = start };
        try { process.Start(); }
        catch (Exception error)
        {
            process.Dispose();
            throw new ContextFoldingException("transport", $"Cannot start Python engine: {error.Message}", error);
        }
        stderrDrain = DrainStderrAsync();
        stdoutPump = PumpStdoutAsync();
        exitWatch = WatchExitAsync();
    }

    private void Fail(ContextFoldingException error)
    {
        lock (sync)
        {
            if (failure is not null) return;
            failure = error;
            pending?.TrySetException(error);
            pending = null;
        }
        lifetime.Cancel();
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private async Task DrainStderrAsync()
    {
        var buffer = new char[4096];
        try
        {
            int count;
            while ((count = await process.StandardError.ReadAsync(buffer.AsMemory(), lifetime.Token)) > 0)
                lock (sync)
                {
                    stderr.Append(buffer, 0, count);
                    if (stderr.Length > 16384) stderr.Remove(0, stderr.Length - 16384);
                }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
    }

    private async Task WatchExitAsync()
    {
        await process.WaitForExitAsync();
        lock (sync)
        {
            Fail(new ContextFoldingException("transport", $"Python engine exited (code={process.ExitCode}): {stderr}"));
        }
    }

    private async Task PumpStdoutAsync()
    {
        var buffer = new char[4096];
        var line = new StringBuilder();
        try
        {
            int count;
            while ((count = await process.StandardOutput.ReadAsync(buffer.AsMemory(), lifetime.Token)) > 0)
            {
                for (var i = 0; i < count; i++)
                {
                    if (buffer[i] == '\n')
                    {
                        Receive(line.ToString().TrimEnd('\r'));
                        line.Clear();
                    }
                    else
                    {
                        line.Append(buffer[i]);
                        if (line.Length > maxResponseChars) throw new ContextFoldingException("protocol", "Engine response exceeds MaxResponseChars");
                    }
                }
            }
            Fail(new ContextFoldingException("transport", "Python engine closed its output"));
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            Fail(error as ContextFoldingException ?? new ContextFoldingException("protocol", $"Cannot read engine response: {error.Message}", error));
        }
    }

    private void Receive(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 1)
            throw new ContextFoldingException("protocol", "Invalid response envelope");
        lock (sync)
        {
            if (failure is not null) return;
            var completion = pending ?? throw new ContextFoldingException("protocol", "Unsolicited engine response");
            if (root.TryGetProperty("result", out var result))
            {
                pending = null;
                completion.TrySetResult(result.Clone());
            }
            else if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object
                && error.TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String
                && error.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
            {
                pending = null;
                completion.TrySetException(new ContextFoldingException(code.GetString()!, message.GetString()!));
            }
            else throw new ContextFoldingException("protocol", "Invalid response envelope");
        }
    }

    public async Task<JsonElement> CallAsync(IReadOnlyDictionary<string, object?> request, CancellationToken cancellationToken = default)
    {
        if (!request.TryGetValue("action", out var action) || action is not string actionText || string.IsNullOrWhiteSpace(actionText)
            || !request.TryGetValue("scope", out var scope) || scope is not string scopeText || string.IsNullOrWhiteSpace(scopeText))
            throw new ArgumentException("Request requires action and scope", nameof(request));
        var line = JsonSerializer.Serialize(request);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        try { await gate.WaitAsync(linked.Token); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            lock (sync) { throw failure ?? new ContextFoldingException("disposed", "Bridge is closed"); }
        }
        try
        {
            TaskCompletionSource<JsonElement> completion;
            lock (sync)
            {
                if (failure is not null) throw failure;
                cancellationToken.ThrowIfCancellationRequested();
                completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                pending = completion;
            }
            using var registration = cancellationToken.Register(() =>
                Fail(new ContextFoldingException("cancelled", "Request cancelled; dispatched requests terminate the bridge")));
            try
            {
                await process.StandardInput.WriteLineAsync(line.AsMemory(), linked.Token);
                await process.StandardInput.FlushAsync(linked.Token);
                return await completion.Task;
            }
            catch (Exception error) when (error is IOException or OperationCanceledException)
            {
                Fail(new ContextFoldingException("transport", $"Engine input failed: {error.Message}", error));
                return await completion.Task;
            }
        }
        finally { gate.Release(); }
    }

    private Task<JsonElement> OperationAsync(string action, string scope, IReadOnlyDictionary<string, object?>? fields,
        CancellationToken cancellationToken, params (string Key, object? Value)[] values)
    {
        var request = fields is null ? new Dictionary<string, object?>() : new Dictionary<string, object?>(fields);
        request["action"] = action;
        request["scope"] = scope;
        foreach (var (key, value) in values) request[key] = value;
        return CallAsync(request, cancellationToken);
    }

    public Task<JsonElement> FoldAsync(string scope, string text, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("fold", scope, fields, cancellationToken, ("text", text));
    public Task<JsonElement> PutAsync(string scope, string text, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("put", scope, fields, cancellationToken, ("text", text));
    public Task<JsonElement> ListAsync(string scope, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("list", scope, fields, cancellationToken);
    public Task<JsonElement> ReadAsync(string scope, string id, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("read", scope, fields, cancellationToken, ("id", id));

    public Task<JsonElement> RenderAsync(string scope, IReadOnlyList<string> ids, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("render", scope, fields, cancellationToken, ("ids", ids));
    public Task<JsonElement> ResolveAsync(string scope, object? value, IReadOnlyDictionary<string, object?>? fields = null, CancellationToken cancellationToken = default)
        => OperationAsync("resolve", scope, fields, cancellationToken, ("value", value));

    public async ValueTask DisposeAsync()
    {
        Fail(new ContextFoldingException("disposed", "Context folding bridge disposed"));
        await Task.WhenAll(stderrDrain, stdoutPump, exitWatch);
        // Keep synchronization primitives valid for callers already waiting on disposal.
        process.Dispose();
    }
}
