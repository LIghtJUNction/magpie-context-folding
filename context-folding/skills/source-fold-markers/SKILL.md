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

For a Python file or project directory, preview with `uv run --project context-folding python -m context_folding annotate-functions /absolute/path`; use `--exclude GLOB` for project exclusions and `--apply` to write comments after preflight. For JS/TS, install the optional parser with `uv sync --project context-folding --extra javascript`, then run the same command with `--extra javascript` before `python` and `--language javascript` or `--language typescript` after the path. JSX/TSX grammars are selected per extension. Inspect output and validate after applying; write errors may leave a partially applied project batch.

Python discovery uses AST and real `#` comment tokens. JS/TS annotation uses Tree-sitter and inserts whole-line `//` markers only inside safe multiline block bodies; single-line functions, expression arrows and inline body boundaries are skipped. Output syntax trees excluding comments/positions must equal input trees. JS/TS discovery recognizes explicit whole-line `//` or `/* … */` regions using real comment nodes, including when the language is inferred from the file path; missing optional parsers and invalid source fail closed. It does not discover unmarked JS/TS structures. Complete LF/CRLF source is required; lone CR, Unicode line separators and NUL are rejected. Grammar checks do not typecheck or validate compiler directives. Comments change source locations, source maps and function source text; avoid source-text-sensitive files and rebuild maps. Other languages retain the generic explicit-marker fallback, which may misidentify marker-shaped multiline strings. Inspect changes and run project validation; do not promise safe automatic annotation across all languages.

Markers make regions eligible for folding in `read-source` views by default, subject to settings, keep/unmarked decisions, and the requirement that the replacement be shorter. The original source stays intact and can be recovered or expanded from the view. Ordinary file reads and the host's conversation context do not automatically fold because markers exist: the host must use or integrate the source-reading capability. For recovery, expansion, settings and host integration, consult the `context-folding` skill. markref recognition of these markers is under development; do not claim it is released or active without evidence.
