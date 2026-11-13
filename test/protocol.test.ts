import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { appendGuide, extractSpans, replaceExtractedSpans, replaceSpans, type Protocol } from "../src/protocol.js";

test("Responses custom tool results are foldable and custom code input remains exact", () => {
  const call = { type: "custom_tool_call", call_id: "code-1", name: "exec", input: "const x = await tools.run(); text(x);" };
  const body = { input: [call, { type: "custom_tool_call_output", call_id: "code-1", output: "original custom tool evidence" },
    { role: "user", content: [{ type: "input_text", text: "Continue" }] }] };
  const tool = extractSpans(body, "responses").find(span => span.role === "tool");
  assert.ok(tool);
  assert.equal(tool.text, "original custom tool evidence");
  assert.equal(tool.protectedReason, undefined);
  const result = replaceSpans(body, new Map([[tool.id, "folded evidence"]]), "responses");
  assert.ok(Array.isArray(result.input));
  assert.deepEqual(result.input[0], call);
  const output: unknown = result.input[1];
  assert.ok(typeof output === "object" && output !== null && "output" in output);
  assert.equal(output.output, "folded evidence");
  const pending = { input: [call] };
  assert.deepEqual(appendGuide(pending, "guide", "responses"), pending);
});

test("Chat folds historical user, assistant and tool text without changing tool calls, images or instructions", () => {
  const body = {
    model: "test", stream: true, tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "system", content: "system instructions" },
      { role: "developer", content: "developer instructions" },
      { role: "user", content: [{ type: "text", text: "long historical request" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "long historical answer", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"source"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "long tool result" },
      { role: "user", content: "current request" },
    ],
  };
  const original = structuredClone(body);
  const spans = extractSpans(body, "chat");
  assert.deepEqual(spans.map((span) => span.role), ["user", "assistant", "tool", "user"]);
  const folded = replaceSpans(body, new Map(spans.slice(0, 3).map((span) => [span.id, `folded ${span.role}`])), "chat");
  assert.deepEqual(body, original);
  assert.deepEqual(folded.tools, body.tools);
  assert.equal(folded.model, body.model);
  assert.equal(folded.stream, true);
  assert.deepEqual(extractSpans(folded, "chat").map((span) => span.text), ["folded user", "folded assistant", "folded tool", "current request"]);
  assert.deepEqual(folded.messages, [
    body.messages[0], body.messages[1],
    { role: "user", content: [{ type: "text", text: "folded user" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    { ...body.messages[3], content: "folded assistant" },
    { role: "tool", tool_call_id: "call_1", content: "folded tool" }, body.messages[5],
  ]);
});

test("span IDs remain stable when later messages are appended and distinguish repeated text", () => {
  const body = { messages: [{ role: "user", content: "repeat" }, { role: "assistant", content: "answer" }, { role: "user", content: "repeat" }] };
  const spans = extractSpans(body, "chat");
  const later = extractSpans({ messages: [...body.messages, { role: "assistant", content: "next" }] }, "chat");
  assert.deepEqual(later.slice(0, 3), spans);
  assert.notEqual(spans[0]?.id, spans[2]?.id);
  assert.match(spans[0]?.id ?? "", /^[a-f0-9]{24}-0$/);
  assert.match(spans[2]?.id ?? "", /^[a-f0-9]{24}-1$/);
});

test("Responses text and function outputs remain reversible without touching reasoning or arguments", () => {
  const body = { instructions: "preserve", input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "request" }, { type: "input_image", image_url: "https://example.test/i.png" }] },
    { type: "reasoning", id: "r1", encrypted_content: "signed data", summary: [{ type: "summary_text", text: "reasoning summary" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    { type: "function_call", call_id: "c1", name: "read", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "c1", output: "result" },
  ] };
  const spans = extractSpans(body, "responses");
  assert.deepEqual(spans.map((span) => span.text), ["request", "answer", "result"]);
  const replacement = new Map(spans.map((span) => [span.id, `summary ${span.text}`]));
  const folded = replaceSpans(body, replacement, "responses");
  assert.deepEqual(extractSpans(folded, "responses").map((span) => span.text), ["summary request", "summary answer", "summary result"]);
  const restored = replaceSpans(folded, new Map(extractSpans(folded, "responses").map((span, index) => [span.id, spans[index]?.text ?? ""])), "responses");
  assert.deepEqual(restored, body);
});

test("Responses string input can be extracted, replaced and receive guidance", () => {
  const body = { input: "request", instructions: "unchanged" };
  const span = extractSpans(body, "responses").at(0);
  assert.ok(span);
  assert.deepEqual(replaceSpans(body, new Map([[span.id, "summary"]]), "responses"), { ...body, input: "summary" });
  assert.deepEqual(appendGuide(body, "guide", "responses"), { ...body, input: "request\n\nguide" });
});

test("Anthropic folds tool_result text while preserving signed thinking, tool use and multimodal content", () => {
  const body = { system: "keep", messages: [
    { role: "user", content: "request" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning", signature: "signature" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "c1", name: "read", input: { path: "original" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", is_error: false, content: [{ type: "text", text: "result" }, { type: "image", source: { type: "base64", data: "AAAA" } }] }] },
  ] };
  const spans = extractSpans(body, "anthropic");
  assert.deepEqual(spans.map((span) => [span.role, span.text]), [["user", "request"], ["assistant", "answer"], ["tool", "result"]]);
  const result = replaceSpans(body, new Map(spans.map((span) => [span.id, "folded"])), "anthropic");
  const restored = replaceSpans(result, new Map(extractSpans(result, "anthropic").map((span, index) => [span.id, spans[index]?.text ?? ""])), "anthropic");
  assert.deepEqual(restored, body);
  const guided = appendGuide(body, "guide", "anthropic");
  assert.deepEqual(guided.messages, [body.messages[0], body.messages[1], { role: "user", content: [...(body.messages[2]?.content ?? []), { type: "text", text: "guide" }] }]);
});

test("Gemini folds explicit function result strings while preserving thoughts, arguments and attachments", () => {
  const body = { systemInstruction: { parts: [{ text: "keep" }] }, contents: [
    { role: "user", parts: [{ text: "request" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
    { role: "model", parts: [{ text: "thought", thought: true }, { text: "signed", thoughtSignature: "sig" }, { text: "answer" }, { functionCall: { name: "read", args: { path: "keep" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "result", count: 1, nested: { text: "keep" } } } }] },
  ] };
  const spans = extractSpans(body, "gemini");
  assert.deepEqual(spans.map((span) => [span.role, span.text]), [["user", "request"], ["assistant", "answer"], ["tool", "result"]]);
  const result = replaceSpans(body, new Map(spans.map((span) => [span.id, "folded"])), "gemini");
  const restored = replaceSpans(result, new Map(extractSpans(result, "gemini").map((span, index) => [span.id, spans[index]?.text ?? ""])), "gemini");
  assert.deepEqual(restored, body);
});

test("incomplete tool exchanges are protected and never receive guide messages", () => {
  const cases: [Protocol, Record<string, unknown>][] = [
    ["chat", { messages: [{ role: "user", content: "request" }, { role: "assistant", content: "calling", tool_calls: [{ id: "c1", function: { name: "read" } }] }] }],
    ["responses", { input: [{ role: "user", content: "request" }, { type: "function_call", call_id: "c1", name: "read", arguments: "{}" }] }],
    ["anthropic", { messages: [{ role: "user", content: "request" }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] }] }],
    ["gemini", { contents: [{ role: "user", parts: [{ text: "request" }] }, { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] }] }],
  ];
  for (const [protocol, body] of cases) {
    const spans = extractSpans(body, protocol);
    assert.ok(spans.length > 0);
    assert.ok(spans.every((span) => span.protectedReason === "unfinished-tool-exchange"));
    assert.deepEqual(replaceSpans(body, new Map(spans.map((span) => [span.id, "folded"])), protocol), body);
    assert.deepEqual(appendGuide(body, "guide", protocol), body);
  }
});

test("server-managed Responses history and Anthropic prefills are protected", () => {
  const cases: [Protocol, Record<string, unknown>, string][] = [
    ["responses", { input: "request", previous_response_id: "resp_1" }, "server-managed-history"],
    ["responses", { input: "request", conversation: { id: "conv_1" } }, "server-managed-history"],
    ["anthropic", { messages: [{ role: "user", content: "request" }, { role: "assistant", content: "The answer is" }] }, "assistant-prefill"],
  ];
  for (const [protocol, body, reason] of cases) {
    assert.ok(extractSpans(body, protocol).every((span) => span.protectedReason === reason));
    assert.deepEqual(appendGuide(body, "guide", protocol), body);
  }
});

test("guidance is appended after complete tool results without changing prior messages or reserved fields", () => {
  const bodies: [Protocol, Record<string, unknown>, string][] = [
    ["chat", { model: "test", tools: ["keep"], stream: false, messages: [{ role: "assistant", tool_calls: [{ id: "c1" }] }, { role: "tool", tool_call_id: "c1", content: "result" }] }, "messages"],
    ["responses", { model: "test", tools: ["keep"], stream: false, input: [{ type: "function_call", call_id: "c1" }, { type: "function_call_output", call_id: "c1", output: "result" }] }, "input"],
    ["gemini", { model: "test", tools: ["keep"], stream: false, contents: [{ role: "model", parts: [{ functionCall: { name: "read" } }] }, { role: "user", parts: [{ functionResponse: { name: "read", response: { text: "result" } } }] }] }, "contents"],
  ];
  for (const [protocol, body, key] of bodies) {
    const original = structuredClone(body);
    const result = appendGuide(body, "guide", protocol);
    assert.deepEqual(body, original);
    assert.equal(result.model, body.model);
    assert.equal(result.stream, body.stream);
    assert.deepEqual(result.tools, body.tools);
    const messages = result[key];
    assert.ok(Array.isArray(messages));
    assert.deepEqual(messages.slice(0, -1), body[key]);
    assert.equal(extractSpans(result, protocol).at(-1)?.text, "guide");
  }
});

function readExchange(protocol: Protocol, args: unknown = { path: "./src/file.ts" }, name = "read", output: unknown = "file contents"): Record<string, unknown> {
  if (protocol === "chat") return { messages: [
    { role: "assistant", content: "reading", tool_calls: [{ id: "read-1", type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: "read-1", content: output },
  ] };
  if (protocol === "responses") return { input: [
    { type: "function_call", call_id: "read-1", name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    { type: "function_call_output", call_id: "read-1", output },
  ] };
  if (protocol === "anthropic") return { messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "read-1", name, input: args }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: output }] },
  ] };
  return { contents: [
    { role: "model", parts: [{ functionCall: { id: "read-1", name, args } }] },
    { role: "user", parts: [{ functionResponse: { id: "read-1", name, response: { output } } }] },
  ] };
}

const protocols: Protocol[] = ["chat", "responses", "anthropic", "gemini"];

test("file reads expose raw path provenance across protocols without changing IDs or wire data", () => {
  for (const protocol of protocols) {
    for (const name of ["read", "Read", "read_file"]) {
      for (const key of ["path", "file_path", "filePath", "absolute_path", "absolutePath"]) {
        const body = readExchange(protocol, { [key]: "../raw/./file.ts" }, name);
        const original = structuredClone(body);
        const spans = extractSpans(body, protocol);
        const tool = spans.find((span) => span.role === "tool");
        assert.deepEqual(tool?.source, { path: "../raw/./file.ts", range: "full" }, `${protocol}/${name}/${key}`);
        assert.ok(spans.filter((span) => span.role !== "tool").every((span) => span.source === undefined));
        const withoutSource = extractSpans(readExchange(protocol, { [key]: "../raw/./file.ts" }, "write"), protocol);
        assert.deepEqual(spans.map((span) => span.id), withoutSource.map((span) => span.id));
        assert.deepEqual(body, original);
        assert.ok(tool);
        const folded = replaceSpans(body, new Map([[tool.id, "folded"]]), protocol);
        // Only the selected text leaf may change; arguments and IDs stay byte-for-byte intact.
        const expected = structuredClone(original);
        const outputSpan = extractSpans(expected, protocol).find((span) => span.role === "tool")!;
        let parent: any = expected;
        for (const part of outputSpan.path.slice(0, -1)) parent = parent[part];
        parent[outputSpan.path.at(-1)!] = "folded";
        assert.deepEqual(folded, expected);
      }
    }
  }
});

test("read ranges distinguish full, offset/limit and line slices consistently", () => {
  for (const protocol of protocols) {
    const source = (args: Record<string, unknown>) => extractSpans(readExchange(protocol, { path: "a", ...args }), protocol).find((span) => span.role === "tool")?.source;
    const ranges = [{}, { offset: 1 }, { limit: 10 }, { offset: 1, limit: 10 }, { offset: 2, limit: 10 }, { start_line: 1, end_line: 10 }, { start_line: 1 }, { end_line: 10 }];
    assert.equal(new Set(ranges.map((args) => source(args)?.range)).size, ranges.length);
    assert.equal(source({ startLine: 1, endLine: 10 })?.range, source({ start_line: 1, end_line: 10 })?.range);
    assert.equal(source({ start: 1, end: 10 })?.range, source({ start_line: 1, end_line: 10 })?.range);
    assert.deepEqual(source({ offset: 1, limit: 10 }), source({ limit: 10, offset: 1 }));
    for (const args of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: "10" }, { start_line: 5, end_line: 2 }, { start_line: 1, startLine: 2 }, { offset: 1, end_line: 10 }, { range: "1-10" }, { pages: "1" }]) {
      assert.equal(source(args), undefined, `${protocol}/${JSON.stringify(args)}`);
    }
  }
});

test("only explicit valid read calls can identify file outputs", () => {
  for (const protocol of protocols) {
    for (const name of ["write", "Write", "edit", "bash", "cat", "mcp__read_file"]) {
      assert.ok(extractSpans(readExchange(protocol, { path: "a", command: "cat a" }, name, "a: file contents"), protocol).every((span) => span.source === undefined));
    }
    for (const args of [{}, { path: "" }, { path: "  " }, { path: ["a"] }, { path: "a", file_path: "b" }, { path: "a", absolutePath: "b" }, "malformed JSON", "null"]) {
      assert.ok(extractSpans(readExchange(protocol, args), protocol).every((span) => span.source === undefined), `${protocol}/${JSON.stringify(args)}`);
    }
    for (const output of ["Error: could not read a", "ENOENT: a", "<tool_use_error>missing a</tool_use_error>", "File not found: a", "Permission denied: a", '{"error":"missing a"}']) {
      assert.ok(extractSpans(readExchange(protocol, { path: "a" }, "read", output), protocol).every((span) => span.source === undefined), `${protocol}/${output}`);
    }
    const body = readExchange(protocol);
    if (protocol === "chat") (body.messages as any[])[1].tool_call_id = "other";
    else if (protocol === "responses") (body.input as any[])[1].call_id = "other";
    else if (protocol === "anthropic") (body.messages as any[])[1].content[0].tool_use_id = "other";
    else (body.contents as any[])[1].parts[0].functionResponse.id = "other";
    assert.ok(extractSpans(body, protocol).every((span) => span.source === undefined), protocol);
  }
});

test("failed, signed, multimodal and multiple text results never receive read provenance", () => {
  for (const protocol of protocols) {
    const bodies: Record<string, unknown>[] = [];
    for (const flag of [{ is_error: true }, { isError: true }, { success: false }, { error: "missing" }, { status: "failed" }, { signature: "signed" }]) {
      const body = readExchange(protocol);
      const result = protocol === "chat" ? (body.messages as any[])[1]
        : protocol === "responses" ? (body.input as any[])[1]
          : protocol === "anthropic" ? (body.messages as any[])[1].content[0]
            : (body.contents as any[])[1].parts[0].functionResponse.response;
      Object.assign(result, flag);
      bodies.push(body);
    }
    if (protocol !== "gemini") {
      for (const output of [
        [{ type: "text", text: "first" }, { type: "text", text: "second" }],
        [{ type: "text", text: "text" }, { type: "image", source: { data: "AAAA" } }],
        [{ type: "text", text: "text", signature: "signed" }],
      ]) bodies.push(readExchange(protocol, { path: "a" }, "read", output));
      const single = readExchange(protocol, { path: "a" }, "read", [{ type: "text", text: "file contents" }]);
      assert.deepEqual(extractSpans(single, protocol).find((span) => span.role === "tool")?.source, { path: "a", range: "full" });
    } else {
      for (const response of [
        { text: "first", output: "second" },
        { output: "text", inlineData: { data: "AAAA" } },
        { output: "text", nested: { text: "ambiguous" } },
      ]) {
        const body = readExchange(protocol);
        (body.contents as any[])[1].parts[0].functionResponse.response = response;
        bodies.push(body);
      }
      const signed = readExchange(protocol);
      (signed.contents as any[])[1].parts[0].thoughtSignature = "signed";
      bodies.push(signed);
    }
    for (const body of bodies) assert.ok(extractSpans(body, protocol).every((span) => span.source === undefined), `${protocol}/${JSON.stringify(body)}`);
  }
});

test("duplicate IDs, multiple result envelopes and results preceding calls are ambiguous", () => {
  for (const protocol of protocols) {
    for (const change of ["duplicate-call", "duplicate-result", "result-first"]) {
      const body = readExchange(protocol);
      const items = (body.messages ?? body.input ?? body.contents) as unknown[];
      if (change === "duplicate-call") items.splice(1, 0, structuredClone(items[0]));
      else if (change === "duplicate-result") items.push(structuredClone(items[1]));
      else items.reverse();
      assert.ok(extractSpans(body, protocol).every((span) => span.source === undefined), `${protocol}/${change}`);
    }
  }
});

test("Gemini repeated same-name calls match by ID or FIFO, including failed results", () => {
  const body = { contents: [
    { role: "model", parts: [
      { functionCall: { name: "read", args: { path: "a" } } },
      { functionCall: { name: "read", args: { path: "b", offset: 5, limit: 10 } } },
    ] },
    { role: "user", parts: [
      { functionResponse: { name: "read", response: { output: "first" } } },
      { functionResponse: { name: "read", response: { output: "second" } } },
    ] },
  ] };
  assert.deepEqual(extractSpans(body, "gemini").map((span) => span.source), [
    { path: "a", range: "full" }, { path: "b", range: "offset:5:limit:10" },
  ]);
  const failed: any = structuredClone(body);
  Object.assign(failed.contents[1].parts[0].functionResponse.response, { error: "failed" });
  assert.deepEqual(extractSpans(failed, "gemini").map((span) => span.source?.path), [undefined, "b"]);
  const identified: any = structuredClone(body);
  identified.contents[0].parts[0].functionCall.id = "a";
  identified.contents[0].parts[1].functionCall.id = "b";
  identified.contents[1].parts[0].functionResponse.id = "b";
  identified.contents[1].parts[1].functionResponse.id = "a";
  assert.deepEqual(extractSpans(identified, "gemini").map((span) => span.source?.path), ["b", "a"]);
});

test("Gemini declines mixed-ID matching and attachments while preserving explicit-ID matching", () => {
  const body: any = readExchange("gemini", { path: "identified" });
  body.contents[0].parts.push({ functionCall: { name: "read", args: { path: "unnamed" } } });
  body.contents[1].parts.push({ functionResponse: { name: "read", response: { output: "unnamed result" } } });
  assert.deepEqual(extractSpans(body, "gemini").map((span) => span.source?.path), ["identified", undefined]);
  const extra: any = readExchange("gemini");
  delete extra.contents[0].parts[0].functionCall.id;
  delete extra.contents[1].parts[0].functionResponse.id;
  extra.contents[1].parts.push(structuredClone(extra.contents[1].parts[0]));
  assert.ok(extractSpans(extra, "gemini").every((span) => span.source === undefined));
  for (const change of ["parts", "inlineData", "signed-call"]) {
    const attached: any = readExchange("gemini");
    if (change === "parts") attached.contents[1].parts[0].functionResponse.parts = [{ inlineData: { data: "AAAA" } }];
    else if (change === "inlineData") attached.contents[1].parts[0].inlineData = { data: "AAAA" };
    else attached.contents[0].parts[0].thoughtSignature = "signature";
    assert.ok(extractSpans(attached, "gemini").every((span) => span.source === undefined), change);
  }
});

test("read result IDs select the corresponding file even when results are reordered", () => {
  for (const protocol of protocols) {
    const first: any = readExchange(protocol, { path: "a" }, "read", "first");
    const second: any = readExchange(protocol, { path: "b" }, "read", "second");
    const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
    if (protocol === "chat") {
      second[key][0].tool_calls[0].id = "read-2";
      second[key][1].tool_call_id = "read-2";
    } else if (protocol === "responses") {
      second[key][0].call_id = "read-2";
      second[key][1].call_id = "read-2";
    } else if (protocol === "anthropic") {
      second[key][0].content[0].id = "read-2";
      second[key][1].content[0].tool_use_id = "read-2";
    } else {
      second[key][0].parts[0].functionCall.id = "read-2";
      second[key][1].parts[0].functionResponse.id = "read-2";
    }
    const body = { [key]: [first[key][0], second[key][0], second[key][1], first[key][1]] };
    assert.deepEqual(extractSpans(body, protocol).filter((span) => span.role === "tool").map((span) => span.source?.path), ["b", "a"], protocol);
  }
});

test("request-local repeated text retains exact role hashes and occurrence IDs", () => {
  const text = 'same text with quotes " and a newline\n😀';
  const body = { messages: [
    { role: "user", content: text }, { role: "assistant", content: text },
    { role: "user", content: text }, { role: "tool", content: text },
  ] };
  const spans = extractSpans(body, "chat");
  const counts = new Map<string, number>();
  for (const span of spans) {
    const hash = createHash("sha256").update(JSON.stringify([span.role, text])).digest("hex").slice(0, 24);
    const count = counts.get(hash) ?? 0;
    assert.equal(span.id, `${hash}-${count}`);
    counts.set(hash, count + 1);
  }
  body.messages[0]!.content = "changed between requests";
  assert.notEqual(extractSpans(body, "chat")[0]!.id, spans[0]!.id);
});

test("repeated read text reuses parsing without sharing envelope safety or request state", () => {
  for (const protocol of protocols) {
    const output = '{"data":[1,2,3],"text":"file contents"}';
    const body: any = readExchange(protocol, { path: "a" }, "read", output);
    const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
    const other: any = readExchange(protocol, { path: "b" }, "read", output);
    if (protocol === "chat") {
      other[key][0].tool_calls[0].id = "read-2";
      other[key][1].tool_call_id = "read-2";
    } else if (protocol === "responses") {
      other[key][0].call_id = "read-2";
      other[key][1].call_id = "read-2";
    } else if (protocol === "anthropic") {
      other[key][0].content[0].id = "read-2";
      other[key][1].content[0].tool_use_id = "read-2";
    } else {
      other[key][0].parts[0].functionCall.id = "read-2";
      other[key][1].parts[0].functionResponse.id = "read-2";
    }
    body[key].push(...other[key]);
    const parse = JSON.parse;
    let outputParses = 0;
    JSON.parse = ((value: string, ...rest: any[]) => {
      if (value === output) outputParses++;
      return parse(value, ...rest);
    }) as typeof JSON.parse;
    try {
      assert.deepEqual(extractSpans(body, protocol).filter(span => span.role === "tool").map(span => span.source?.path), ["a", "b"]);
      assert.equal(outputParses, 1, `${protocol}: identical result text is parsed once per extraction`);
      extractSpans(body, protocol);
      assert.equal(outputParses, 2, `${protocol}: parsing state never survives an extraction`);
    } finally {
      JSON.parse = parse;
    }
    const result = protocol === "anthropic" ? other[key][1].content[0]
      : protocol === "gemini" ? other[key][1].parts[0].functionResponse.response : other[key][1];
    result.signature = "signed";
    assert.deepEqual(extractSpans(body, protocol).filter(span => span.role === "tool").map(span => span.source?.path), ["a", undefined]);
  }
});

test("pre-extracted replacement matches the public API across protocols and rechecks protection", () => {
  for (const protocol of protocols) {
    const body: any = readExchange(protocol);
    const original = structuredClone(body);
    const spans = extractSpans(body, protocol);
    const replacements = new Map(spans.map(span => [span.id, "folded"]));
    assert.deepEqual(replaceExtractedSpans(body, replacements, protocol, spans), replaceSpans(body, replacements, protocol));
    assert.deepEqual(body, original);
    // Even if a pipeline accidentally adds an unfinished exchange after extraction,
    // the fast path must still decline all writes.
    const key = protocol === "responses" ? "input" : protocol === "gemini" ? "contents" : "messages";
    body[key].push(structuredClone(body[key][0]));
    assert.deepEqual(replaceExtractedSpans(body, replacements, protocol, spans), body);
    const protectedSpans = extractSpans(body, protocol);
    body[key].pop();
    assert.deepEqual(replaceExtractedSpans(body, replacements, protocol, protectedSpans), body);
  }
  for (const [protocol, body] of [
    ["responses", { input: "request", previous_response_id: "server" }],
    ["anthropic", { messages: [{ role: "assistant", content: "prefill" }] }],
  ] satisfies [Protocol, Record<string, unknown>][]) {
    const spans = extractSpans(body, protocol);
    assert.deepEqual(replaceExtractedSpans(body, new Map(spans.map(span => [span.id, "folded"])), protocol, spans), body);
  }
});

test("malformed and unknown content is ignored instead of being rewritten", () => {
  for (const protocol of ["chat", "responses", "anthropic", "gemini"] satisfies Protocol[]) {
    const body = { messages: [null, "invalid", { content: "missing role" }, { role: "unknown", content: "unknown role" }], input: [null, { type: "unknown", content: "opaque" }], contents: [null, { parts: [{ text: "no role" }] }] };
    assert.deepEqual(extractSpans(body, protocol), []);
    assert.deepEqual(replaceSpans(body, new Map([["not-an-id", "overwrite"]]), protocol), body);
  }
  const unknownContent = { messages: [{ role: "user", content: { custom: "opaque content" } }] };
  assert.deepEqual(appendGuide(unknownContent, "guide", "chat"), {
    messages: [...unknownContent.messages, { role: "user", content: "guide" }],
  });
});
