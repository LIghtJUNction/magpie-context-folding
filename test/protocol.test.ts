import assert from "node:assert/strict";
import test from "node:test";
import { appendGuide, extractSpans, replaceSpans, type Protocol } from "../src/protocol.js";

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
