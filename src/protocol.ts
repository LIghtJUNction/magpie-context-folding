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
      if (item.type === "function_call_output") {
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
      if (item.type === "function_call") add(item.call_id);
      else if (item.type === "function_call_output") complete(item.call_id);
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
  const occurrences = new Map<string, number>();
  const reason = protectionReason(body, protocol);
  return candidates.map((candidate) => {
    const hash = createHash("sha256").update(JSON.stringify([candidate.role, candidate.text])).digest("hex").slice(0, 24);
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
  const result = structuredClone(body);
  for (const span of extractSpans(body, protocol)) {
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
