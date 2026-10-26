import { createHash } from "node:crypto";

export type Protocol = "chat" | "responses" | "anthropic" | "gemini";
export type Path = (string | number)[];

export interface Span {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  path: Path;
  messageIndex: number;
  protectedReason?: string;
  source?: { path: string; range: string };
}

type Candidate = Omit<Span, "id">;
type Role = Span["role"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textRole(value: unknown): Role | undefined {
  return value === "user" || value === "assistant" || value === "tool" ? value : undefined;
}

function addText(
  candidates: Candidate[],
  value: unknown,
  role: Role,
  path: Path,
  messageIndex: number,
): void {
  if (typeof value === "string" && value.length > 0) {
    candidates.push({ role, text: value, path, messageIndex });
  }
}

function addTextParts(
  candidates: Candidate[],
  content: unknown,
  role: Role,
  path: Path,
  messageIndex: number,
  types: ReadonlySet<string>,
): void {
  if (typeof content === "string") {
    addText(candidates, content, role, path, messageIndex);
  } else if (Array.isArray(content)) {
    content.forEach((part: unknown, index) => {
      if (isRecord(part) && typeof part.type === "string" && types.has(part.type) && !("signature" in part)) {
        addText(candidates, part.text, role, [...path, index, "text"], messageIndex);
      }
    });
  }
}

const chatTextTypes = new Set(["text"]);
const responseTextTypes = new Set(["input_text", "output_text", "text"]);

function chatSpans(body: Record<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  if (!Array.isArray(body.messages)) return candidates;
  body.messages.forEach((message: unknown, index) => {
    if (!isRecord(message)) return;
    const role = textRole(message.role);
    if (!role) return;
    addTextParts(candidates, message.content, role, ["messages", index, "content"], index, chatTextTypes);
  });
  return candidates;
}

function responseSpans(body: Record<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  if (typeof body.input === "string") {
    addText(candidates, body.input, "user", ["input"], 0);
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item: unknown, index) => {
      if (!isRecord(item)) return;
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        addTextParts(candidates, item.output, "tool", ["input", index, "output"], index, responseTextTypes);
      } else if (item.type === "message" || item.type === undefined) {
        const role = textRole(item.role);
        if (role === "user" || role === "assistant") {
          addTextParts(candidates, item.content, role, ["input", index, "content"], index, responseTextTypes);
        }
      }
    });
  }
  return candidates;
}

function anthropicSpans(body: Record<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  if (!Array.isArray(body.messages)) return candidates;
  body.messages.forEach((message: unknown, messageIndex) => {
    if (!isRecord(message)) return;
    const role = textRole(message.role);
    if (role !== "user" && role !== "assistant") return;
    const path: Path = ["messages", messageIndex, "content"];
    if (typeof message.content === "string") {
      addText(candidates, message.content, role, path, messageIndex);
    } else if (Array.isArray(message.content)) {
      message.content.forEach((part: unknown, partIndex) => {
        if (!isRecord(part)) return;
        if (part.type === "text" && !("signature" in part)) {
          addText(candidates, part.text, role, [...path, partIndex, "text"], messageIndex);
        } else if (part.type === "tool_result") {
          addTextParts(candidates, part.content, "tool", [...path, partIndex, "content"], messageIndex, chatTextTypes);
        }
      });
    }
  });
  return candidates;
}

function geminiSpans(body: Record<string, unknown>): Candidate[] {
  const candidates: Candidate[] = [];
  if (!Array.isArray(body.contents)) return candidates;
  body.contents.forEach((content: unknown, messageIndex) => {
    if (!isRecord(content) || !Array.isArray(content.parts)) return;
    const role = content.role === "model" ? "assistant" : content.role === "user" ? "user" : undefined;
    if (!role) return;
    content.parts.forEach((part: unknown, partIndex) => {
      if (!isRecord(part) || part.thought === true || "thoughtSignature" in part) return;
      const path: Path = ["contents", messageIndex, "parts", partIndex];
      addText(candidates, part.text, role, [...path, "text"], messageIndex);
      if (isRecord(part.functionResponse) && isRecord(part.functionResponse.response)) {
        const response = part.functionResponse.response;
        for (const key of ["text", "output", "result", "content"]) {
          addText(candidates, response[key], "tool", [...path, "functionResponse", "response", key], messageIndex);
        }
      }
    });
  });
  return candidates;
}

type Source = NonNullable<Span["source"]>;

function readSource(name: unknown, value: unknown): Source | undefined {
  if (name !== "read" && name !== "Read" && name !== "read_file") return;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return; }
  }
  if (!isRecord(value)) return;
  const args = value;
  const paths = ["path", "file_path", "filePath", "absolute_path"].filter((key) => key in args).map((key) => args[key]);
  const path = paths[0];
  if (typeof path !== "string" || !path.trim() || paths.some((entry) => entry !== path)) return;
  const controls = [
    ["offset"], ["limit"], ["start_line", "startLine", "start"], ["end_line", "endLine", "end"],
  ];
  const values: (number | undefined)[] = [];
  for (const aliases of controls) {
    const entries = aliases.filter((key) => key in args).map((key) => args[key]);
    const first = entries[0];
    if (entries.length && (typeof first !== "number" || !Number.isSafeInteger(first) || first < 0 || entries.some((entry) => entry !== first))) return;
    values.push(first as number | undefined);
  }
  const [offset, limit, start, end] = values;
  if (limit === 0 || (start !== undefined && end !== undefined && end < start)) return;
  if ((offset !== undefined || limit !== undefined) && (start !== undefined || end !== undefined)) return;
  // Unknown slicing controls must not accidentally label a partial read as a full read.
  if (["range", "line_range", "lines", "pages"].some((key) => key in args)) return;
  const range = offset !== undefined || limit !== undefined
    ? `offset:${offset ?? "default"}:limit:${limit ?? "default"}`
    : start !== undefined || end !== undefined
      ? `start:${start ?? "default"}:end:${end ?? "default"}`
      : "full";
  return { path, range };
}

function unsafeReadResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsafeReadResult);
  if (!isRecord(value)) return false;
  if (["signature", "thoughtSignature", "encrypted_content", "encryptedContent", "error", "inlineData", "inline_data", "fileData", "file_data", "image_url", "audio", "input_audio"].some((key) => key in value)
    || (typeof value.type === "string" && /^(?:image|image_url|input_image|input_audio|audio|file|input_file|thinking|redacted_thinking)$/.test(value.type))
    || value.is_error === true || value.isError === true || value.success === false || value.thought === true
    || (typeof value.status === "string" && /^(?:error|failed|failure|cancelled|canceled|incomplete)$/i.test(value.status))) return true;
  return Object.values(value).some((entry) => (isRecord(entry) || Array.isArray(entry)) && unsafeReadResult(entry));
}

function singleReadText(value: unknown, types: ReadonlySet<string>, textSafety: Map<string, boolean>): boolean {
  if (typeof value === "string") {
    const cached = textSafety.get(value);
    if (cached !== undefined) return cached;
    let safe = !!value.length && !/^\s*(?:error\b|failed\b|ENOENT\b|EACCES\b|EPERM\b|file not found\b|no such file or directory\b|permission denied\b|<tool_use_error>)/i.test(value);
    if (safe) {
      try { safe = !unsafeReadResult(JSON.parse(value)); } catch { /* Ordinary file text. */ }
    }
    textSafety.set(value, safe);
    return safe;
  }
  return Array.isArray(value) && value.length === 1 && isRecord(value[0])
    && typeof value[0].type === "string" && types.has(value[0].type)
    && !unsafeReadResult(value[0]) && singleReadText(value[0].text, types, textSafety)
    && !Object.keys(value[0]).some((key) => !["type", "text", "annotations"].includes(key));
}

function attachReadSources(body: Record<string, unknown>, protocol: Protocol, candidates: Candidate[]): void {
  type Call = { id: unknown; name: unknown; args: unknown; safe: boolean };
  type Result = { id: unknown; name?: unknown; path: Path; safe: boolean };
  const events: ({ call: Call } | { result: Result })[] = [];
  // Only immutable strings are reused, and only within this extraction. Envelope
  // safety and protocol-specific text-part checks still run for every result.
  const textSafety = new Map<string, boolean>();
  const items = protocol === "responses" ? body.input : protocol === "gemini" ? body.contents : body.messages;
  if (!Array.isArray(items)) return;
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) continue;
    if (protocol === "chat") {
      if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) {
          if (isRecord(call) && isRecord(call.function)) events.push({ call: {
            id: call.id, name: call.function.name, args: call.function.arguments, safe: !unsafeReadResult(call),
          } });
        }
      } else if (item.role === "tool") events.push({ result: {
        id: item.tool_call_id, path: ["messages", index, "content"],
        safe: !unsafeReadResult(item) && singleReadText(item.content, chatTextTypes, textSafety),
      } });
    } else if (protocol === "responses") {
      if (item.type === "function_call" || item.type === "custom_tool_call") events.push({ call: { id: item.call_id, name: item.name, args: item.arguments ?? item.input, safe: !unsafeReadResult(item) } });
      else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") events.push({ result: {
        id: item.call_id, path: ["input", index, "output"], safe: !unsafeReadResult(item) && singleReadText(item.output, responseTextTypes, textSafety),
      } });
    } else {
      const parts = protocol === "gemini" ? item.parts : item.content;
      if (!Array.isArray(parts)) continue;
      for (const [partIndex, part] of parts.entries()) {
        if (!isRecord(part)) continue;
        const safe = !unsafeReadResult(part);
        if (protocol === "anthropic") {
          if (item.role === "assistant" && part.type === "tool_use") events.push({ call: { id: part.id, name: part.name, args: part.input, safe } });
          else if (item.role === "user" && part.type === "tool_result") events.push({ result: {
            id: part.tool_use_id, path: ["messages", index, "content", partIndex, "content"], safe: safe && singleReadText(part.content, chatTextTypes, textSafety),
          } });
        } else if (item.role === "model" || item.role === "user") {
          if (item.role === "model" && isRecord(part.functionCall)) {
            const call = part.functionCall;
            events.push({ call: { id: call.id, name: call.name, args: call.args, safe } });
          }
          if (item.role === "user" && isRecord(part.functionResponse)) {
            const response = part.functionResponse;
            const output = response.response;
            const textKeys = isRecord(output) ? ["text", "output", "result", "content"].filter((key) => typeof output[key] === "string") : [];
            events.push({ result: {
              id: response.id, name: response.name, path: ["contents", index, "parts", partIndex, "functionResponse", "response"],
              safe: safe && isRecord(output) && textKeys.length === 1 && singleReadText(output[textKeys[0]!], chatTextTypes, textSafety)
                && !Object.values(output).some((entry) => isRecord(entry) || Array.isArray(entry))
                && Object.keys(part).every((key) => key === "functionResponse")
                && !Array.isArray(response.parts),
            } });
          }
        }
      }
    }
  }
  // Duplicate IDs or multiple result envelopes cannot identify a single file version.
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const event of events) {
    const id = "call" in event ? event.call.id : event.result.id;
    const counts = "call" in event ? callCounts : resultCounts;
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const identifiedNames = new Set(events.flatMap((event) => "call" in event && event.call.id !== undefined ? [event.call.name] : []));
  const unnamedCounts = new Map<unknown, { calls: number; results: number }>();
  for (const event of events) {
    const entry = "call" in event ? event.call : event.result;
    if (entry.id !== undefined) continue;
    const count = unnamedCounts.get(entry.name) ?? { calls: 0, results: 0 };
    if ("call" in event) count.calls++;
    else count.results++;
    unnamedCounts.set(entry.name, count);
  }
  const pending = new Map<string, Call>();
  const unnamed = new Map<string, Call[]>();
  for (const event of events) {
    if ("call" in event) {
      const call = event.call;
      if (typeof call.id === "string" && call.id) pending.set(call.id, call);
      else if (protocol === "gemini" && call.id === undefined && typeof call.name === "string") {
        const queue = unnamed.get(call.name) ?? [];
        queue.push(call);
        unnamed.set(call.name, queue);
      }
      continue;
    }
    const result = event.result;
    let call: Call | undefined;
    if (typeof result.id === "string" && result.id) {
      call = pending.get(result.id);
      pending.delete(result.id);
      if (callCounts.get(result.id) !== 1 || resultCounts.get(result.id) !== 1) continue;
    } else if (protocol === "gemini" && result.id === undefined && typeof result.name === "string") {
      // Without IDs, consume same-name calls in wire order, including failed reads.
      // A mixture of ID-bearing and ID-less calls with this name is ambiguous.
      const count = unnamedCounts.get(result.name);
      if (identifiedNames.has(result.name) || !count || count.calls !== count.results) continue;
      call = unnamed.get(result.name)?.shift();
    }
    if (!call || !call.safe || !result.safe || (protocol === "gemini" && call.name !== result.name)) continue;
    const source = readSource(call.name, call.args);
    if (!source) continue;
    const spans = candidates.filter((candidate) => candidate.role === "tool" && result.path.every((part, index) => candidate.path[index] === part));
    if (spans.length === 1) spans[0]!.source = source;
  }
}

function hasPendingCalls(body: Record<string, unknown>, protocol: Protocol): boolean {
  const pending = new Map<string, number>();
  const add = (id: unknown): void => {
    if (typeof id === "string") pending.set(id, (pending.get(id) ?? 0) + 1);
  };
  const complete = (id: unknown): void => {
    if (typeof id !== "string") return;
    const count = pending.get(id) ?? 0;
    if (count <= 1) pending.delete(id);
    else pending.set(id, count - 1);
  };
  const messages = protocol === "responses" ? body.input : protocol === "gemini" ? body.contents : body.messages;
  if (!Array.isArray(messages)) return false;
  for (const item of messages) {
    if (!isRecord(item)) continue;
    if (protocol === "chat") {
      if (item.role === "assistant" && Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) if (isRecord(call)) add(call.id);
      } else if (item.role === "tool") complete(item.tool_call_id);
    } else if (protocol === "responses") {
      if (item.type === "function_call" || item.type === "custom_tool_call") add(item.call_id);
      else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") complete(item.call_id);
    } else {
      const parts = protocol === "gemini" ? item.parts : item.content;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (protocol === "anthropic") {
          if (part.type === "tool_use") add(part.id);
          else if (part.type === "tool_result") complete(part.tool_use_id);
        } else {
          if (isRecord(part.functionCall)) add(part.functionCall.name);
          if (isRecord(part.functionResponse)) complete(part.functionResponse.name);
        }
      }
    }
  }
  return pending.size > 0;
}

function protectionReason(body: Record<string, unknown>, protocol: Protocol): string | undefined {
  if (hasPendingCalls(body, protocol)) return "unfinished-tool-exchange";
  if (protocol === "responses" && (typeof body.previous_response_id === "string" || typeof body.conversation === "string" || isRecord(body.conversation))) {
    return "server-managed-history";
  }
  if (protocol === "anthropic" && Array.isArray(body.messages)) {
    const last: unknown = body.messages.at(-1);
    if (isRecord(last) && last.role === "assistant") return "assistant-prefill";
  }
  return undefined;
}

export function extractSpans(body: Record<string, unknown>, protocol: Protocol): Span[] {
  let candidates: Candidate[];
  switch (protocol) {
    case "chat": candidates = chatSpans(body); break;
    case "responses": candidates = responseSpans(body); break;
    case "anthropic": candidates = anthropicSpans(body); break;
    case "gemini": candidates = geminiSpans(body); break;
  }
  attachReadSources(body, protocol, candidates);
  const occurrences = new Map<string, number>();
  const hashes = new Map<Role, Map<string, string>>();
  const reason = protectionReason(body, protocol);
  return candidates.map((candidate) => {
    let roleHashes = hashes.get(candidate.role);
    if (!roleHashes) {
      roleHashes = new Map();
      hashes.set(candidate.role, roleHashes);
    }
    let hash = roleHashes.get(candidate.text);
    if (hash === undefined) {
      hash = createHash("sha256").update(JSON.stringify([candidate.role, candidate.text])).digest("hex").slice(0, 24);
      roleHashes.set(candidate.text, hash);
    }
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    return { ...candidate, id: `${hash}-${occurrence}`, ...(reason ? { protectedReason: reason } : {}) };
  });
}

function setText(root: Record<string, unknown>, path: Path, text: string): void {
  let current: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else if (isRecord(current) && typeof part === "string" && Object.hasOwn(current, part)) current = current[part];
    else return;
  }
  const leaf = path.at(-1);
  if (Array.isArray(current) && typeof leaf === "number" && typeof current[leaf] === "string") current[leaf] = text;
  else if (isRecord(current) && typeof leaf === "string" && Object.hasOwn(current, leaf) && typeof current[leaf] === "string") current[leaf] = text;
}

export function replaceSpans(
  body: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
  protocol: Protocol,
): Record<string, unknown> {
  return replaceExtractedSpans(body, replacements, protocol, extractSpans(body, protocol));
}

/**
 * Internal request-pipeline fast path. `spans` must be the unmodified result of
 * extractSpans(body, protocol), with neither body nor spans mutated since then.
 * Do not reuse spans across requests, protocols, or replacement passes.
 * Protection is checked again against the current body before any write.
 */
export function replaceExtractedSpans(
  body: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
  protocol: Protocol,
  spans: readonly Span[],
): Record<string, unknown> {
  const result = structuredClone(body);
  if (protectionReason(body, protocol)) return result;
  for (const span of spans) {
    const replacement = replacements.get(span.id);
    if (replacement !== undefined && !span.protectedReason) setText(result, span.path, replacement);
  }
  return result;
}

function appendToContent(message: Record<string, unknown>, guide: string, textType: string): Record<string, unknown> {
  if (typeof message.content === "string") return { ...message, content: `${message.content}\n\n${guide}` };
  if (Array.isArray(message.content)) return { ...message, content: [...message.content, { type: textType, text: guide }] };
  return message;
}

export function appendGuide(
  body: Record<string, unknown>,
  guide: string,
  protocol: Protocol,
): Record<string, unknown> {
  const result = structuredClone(body);
  if (!guide || protectionReason(body, protocol)) return result;
  if (protocol === "responses") {
    if (typeof result.input === "string") result.input = `${result.input}\n\n${guide}`;
    else if (Array.isArray(result.input)) result.input.push({ role: "user", content: [{ type: "input_text", text: guide }] });
    else result.input = [{ role: "user", content: [{ type: "input_text", text: guide }] }];
  } else if (protocol === "gemini") {
    if (Array.isArray(result.contents)) result.contents.push({ role: "user", parts: [{ text: guide }] });
    else result.contents = [{ role: "user", parts: [{ text: guide }] }];
  } else {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const last: unknown = messages.at(-1);
    if (isRecord(last) && last.role === "user" && (typeof last.content === "string" || Array.isArray(last.content))) {
      messages[messages.length - 1] = appendToContent(last, guide, "text");
    }
    else messages.push({ role: "user", content: guide });
    result.messages = messages;
  }
  return result;
}
