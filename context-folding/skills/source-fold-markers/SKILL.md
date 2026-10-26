---
name: source-fold-markers
description: Add and maintain safe paired source folding comments when creating or modifying code. Use when working on source files that can benefit from compact, recoverable source views.
---

# Source fold markers

When a self-contained implementation has been verified and is unlikely to need further edits, proactively apply this skill and mark its body for default folding so the next agent can inspect its description and expand the exact code when needed. Preserve requirements, failure handling, security-relevant context and active work in the visible surrounding code; stability is a judgment based on evidence, not a claim that the code is bug-free. Use the host's actual skill discovery mechanism; a prompt cannot silently install or load a skill.

When creating or modifying source code, proactively mark meaningful regions that can be folded while retaining enough surrounding context to navigate the file. Do not mark or fold a one-line function: the overhead is not worthwhile. Choose useful boundaries such as a function body or a cohesive implementation block; avoid obscuring declarations needed to understand the surrounding code. Respect explicit user or project instructions about regions to keep visible. Do not add markers when there is no safe, valid place for them.

Use standalone comment lines containing `@context-fold begin NAME` and `@context-fold end NAME`, with the same non-whitespace name and the same comment delimiters on both lines. Choose a descriptive name. For example:

```javascript
function send(transport, payload) {
  // @context-fold begin send-payload
  transport.send(payload);
  // @context-fold end send-payload
}
```

A brief ordinary comment describing a region may immediately precede its begin marker. It remains visible while that region is folded, provided no enclosing region hides it. When expanding, choose a single region to keep descendants folded, or recursive expansion to reveal its descendants; check the returned view and recover the original when exact source is required.

Use comment syntax valid at that location in the actual language and consistent with the project. Each marker must occupy a complete comment line; paired block-comment delimiters must open and close on that same line. Never insert markers into strings, literals, generated output, or locations where comments change parsing or behavior. Preserve indentation, encoding, line endings, and existing source behavior. Inspect existing markers before editing; keep begin/end pairs balanced, properly nested, and non-crossing, including with any structurally discovered Python regions. Do not introduce malformed or empty regions. Preserve existing protected regions and avoid duplicate or overlapping annotations that make boundaries ambiguous.

For a Python file, preview with `uv run --project context-folding python -m context_folding annotate-functions /absolute/path/module.py`; use `--apply` to write the comments. The command currently supports one Python file per invocation. Inspect the output and validate the file after applying.

For Python, source discovery uses the AST and recognizes marker lines only as real `#` comment tokens. For other languages, explicit marker recognition has no general lexer or structural parser and may mistake marker-looking text in multiline strings for comments. Analyze each location and its language syntax manually unless a reliable language-aware parser is available; do not promise safe automatic annotation across all languages. If an annotation tool is available, follow its actual documented interface, inspect its changes, and validate the result; do not invent commands or assume an operation succeeded. Check syntax and run appropriate project validation after editing.

Markers make regions eligible for folding in `read-source` views by default, subject to settings, keep/unmarked decisions, and the requirement that the replacement be shorter. The original source stays intact and can be recovered or expanded from the view. Ordinary file reads and the host's conversation context do not automatically fold because markers exist: the host must use or integrate the source-reading capability. For recovery, expansion, settings and host integration, consult the `context-folding` skill. markref recognition of these markers is under development; do not claim it is released or active without evidence.
