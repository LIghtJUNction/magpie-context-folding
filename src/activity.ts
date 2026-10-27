import type { Span } from './protocol.js';

export type ActivityReason = 'plugin-control' | 'authorization-required' | 'tool-error' | 'operation-receipt';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFoldingTool(name: unknown): boolean {
  return typeof name === 'string'
    && /(?:^|__|[.:/])(?:magpie_)?context_folding(?:_context_folding)?(?:$|[.:/])/.test(name);
}

/** Only whole synthetic blocks are ignored; a user's text plus a guide is still a user turn. */
export function isPluginGuide(text: string): boolean {
  let rest = text.trim();
  if (!rest) return false;
  while (rest) {
    const opening = /^<(context-folding(?: scope=[a-f0-9]{64})?|context-budget|context-folding-receipts)>/.exec(rest);
    if (!opening) return false;
    const tag = opening[1]!.split(' ', 1)[0]!;
    const closing = `</${tag}>`;
    const end = rest.indexOf(closing, opening[0].length);
    if (end < 0) return false;
    rest = rest.slice(end + closing.length).trim();
  }
  return true;
}

/** Literal member calls only: never evaluate code or treat quoted instructions as calls. */
function codeCallsFolding(args: unknown): boolean {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* Custom tools carry raw code. */ }
  }
  const code = typeof args === 'string' ? args : record(args)
    ? [args.code, args.script, args.input].find(value => typeof value === 'string') : undefined;
  if (typeof code !== 'string' || !code.includes('context_folding')) return false;
  const tokens: { text: string; literal?: string }[] = [];
  let operand = true;
  for (let index = 0; index < code.length;) {
    const rest = code.slice(index);
    const space = /^\s+|^\/\/[^\n]*|^\/\*[\s\S]*?\*\//.exec(rest);
    if (space) { index += space[0].length; continue; }
    const quoted = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/.exec(rest);
    if (quoted) {
      const text = quoted[0];
      // Escapes/computed names are deliberately not guessed.
      tokens.push({ text, ...(!text.includes('\\') && text[0] !== '`' ? { literal: text.slice(1, -1) } : {}) });
      index += text.length;
      operand = false;
      continue;
    }
    const regex = operand ? /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[a-z]*/i.exec(rest) : null;
    if (regex) { tokens.push({ text: 'regex' }); index += regex[0].length; operand = false; continue; }
    const token = /^[\w$]+|^\S/.exec(rest)?.[0];
    if (!token) break;
    tokens.push({ text: token });
    index += token.length;
    operand = /^(?:await|return|throw|yield)$/.test(token) || !/^(?:[\w$]+|[\])])$/.test(token);
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text !== 'tools') continue;
    const member = tokens[index + 1]?.text;
    const name = member === '.' ? tokens[index + 2]?.text
      : member === '[' && tokens[index + 3]?.text === ']' ? tokens[index + 2]?.literal : undefined;
    const next = tokens[index + (member === '.' ? 3 : 4)]?.text;
    if (isFoldingTool(name) && next === '(') return true;
  }
  return false;
}

const authorizationStatus = /^(?:requires_authentication|authentication_required|requires_authorization|authorization_required|awaiting_authorization|authorization_pending|pending_authorization|awaiting_approval|approval_required|login_required)$/i;
const failedStatus = /^(?:error|failed|failure|timed_out|timeout|cancelled|canceled|incomplete)$/i;
const terminalStatus = /^(?:success|succeeded|complete|completed|authorized|approved|denied|rejected|expired|revoked|cancelled|canceled)$/i;
const receiptTool = /(?:^|__|[.:])(?:github_)?(?:create_commit|update_ref|merge_pull_request|create_pull_request|push_files|create_file|update_file)$/;

/** Inspect real result fields and recognizable output lines, not arbitrary keyword mentions. */
export function toolActivity(name: unknown, args: unknown, payload: unknown, envelope?: unknown,
  parseText: (text: string) => unknown = JSON.parse): ActivityReason | undefined {
  if (isFoldingTool(name) || (typeof name === 'string' && /(?:^|__|[.:/])(?:exec|execute|run_code|code_mode)$/.test(name)
    && codeCallsFolding(args))) return 'plugin-control';
  let failed = false;
  let authorization = false;
  let control = false;
  let receipt = typeof name === 'string' && receiptTool.test(name);
  let remaining = 2000;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || --remaining < 0) return;
    if (typeof value === 'string') {
      if (/^\s*[\[{]/.test(value)) {
        try {
          const parsed = parseText(value);
          if (parsed !== undefined) { visit(parsed, depth + 1); return; }
        } catch { /* Human-readable tool output. */ }
      }
      authorization ||= /^(?:authorization|authentication|login|approval) (?:is )?required\b|^\s*(?:please (?:authorize|approve|sign in|log in)|waiting for (?:user |human )?(?:authorization|approval))\b/im.test(value);
      failed ||= /^\s*(?:error:|fatal:|failed:|<tool_use_error>|not ok \d+\b|\(fail\)\s+|FAIL(?:ED)?\s+\S|test result:\s+FAILED\b|[1-9]\d* tests? failed\b|(?:Process|Command) exited with (?:exit )?code [1-9]\d*\b)|^\s*(?:Tests|Test Suites):\s+[1-9]\d* failed\b/im.test(value);
      receipt ||= /^\[[^\]\r\n]+ [a-f0-9]{7,40}\]\s|^\s*[a-f0-9]{7,40}\.\.?[a-f0-9]{7,40}\s+\S+\s+->\s+\S+/im.test(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!record(value)) return;
    control ||= value._contextFolding === 'control-result';
    const status = typeof value.status === 'string' ? value.status : '';
    const terminal = terminalStatus.test(status);
    authorization ||= authorizationStatus.test(status)
      || ['requires_authentication', 'requires_authorization', 'requires_approval', 'login_required'].some(key => value[key] === true)
      || (!terminal && ['authorization_url', 'authorizationUrl', 'verification_uri', 'verification_uri_complete', 'verification_url', 'login_url', 'auth_url'].some(key => typeof value[key] === 'string' && value[key]));
    const error = value.error;
    if (typeof error === 'string' && authorizationStatus.test(error)) authorization = true;
    failed ||= value.is_error === true || value.isError === true || value.success === false || value.ok === false
      || failedStatus.test(status) || (error !== undefined && error !== null && error !== false && error !== '')
      || ['exit_code', 'exitCode'].some(key => typeof value[key] === 'number' && value[key] !== 0);
    receipt ||= value.committed === true || value.merged === true;
    // Known result envelopes only; schemas, documentation, and arbitrary object fields are not signals.
    for (const key of ['content', 'structuredContent', 'result', 'results', 'output', 'data', 'text', 'message']) {
      if (value[key] !== undefined) visit(value[key], depth + 1);
    }
  };
  visit(envelope, 0);
  visit(payload, 0);
  return control ? 'plugin-control' : authorization ? 'authorization-required' : failed ? 'tool-error' : receipt ? 'operation-receipt' : undefined;
}

/** Lifecycle protection is per span; it must never be used as protocol-wide unsafety. */
export function activityProtectedSpans(spans: readonly Span[], lastUserIndex: number): Map<string, string> {
  const protectedSpans = new Map<string, string>();
  const lastMessageIndex = spans.reduce((last, span) => span.role === 'user' && isPluginGuide(span.text)
    ? last : Math.max(last, span.messageIndex), -1);
  for (const span of spans) {
    if (span.role === 'user' && isPluginGuide(span.text)) {
      protectedSpans.set(span.id, 'plugin-control');
      continue;
    }
    if (span.role !== 'tool') continue;
    if (span.activityReason) protectedSpans.set(span.id, span.activityReason);
    else if (lastUserIndex >= 0 ? span.messageIndex >= lastUserIndex : span.messageIndex === lastMessageIndex) {
      protectedSpans.set(span.id, 'active-tool-result');
    }
  }
  return protectedSpans;
}
