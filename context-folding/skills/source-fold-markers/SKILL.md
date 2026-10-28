---
name: source-fold-markers
description: Add explicit source folding comments around completed code while keeping useful declarations visible. Use when authoring or editing source for the context-folding reader.
---

# Source fold markers

Mark useful, completed implementation regions with whole-line comments in the file's language:

```rust
// Decode the validated frame; errors are returned to the caller.
// @context-fold begin decode-frame
let header = read_header(input)?;
let payload = read_payload(input, header.length)?;
// @context-fold end decode-frame
```

Use the same non-whitespace label and comment delimiters for both markers. Leave a short description and necessary declarations outside. Preserve the source's indentation and line endings. Do not nest, cross, leave empty regions, insert markers in strings, annotate trivial one-line code, or obscure work still needed for the next decision.

Annotations are the only folding permission. The reader does not infer foldable functions from their size, AST, age or token pressure. A compact view uses a generated `[[cf:v2:HASH]]` reference; the source file stays complete. Read the actual reference or expand a named region when its details are needed. Do not guess hashes or write folded views over real source.

`annotate-functions` is an optional, explicit batch editing command for Python/JS/TS. Preview its proposed changes, respect repository edit scope, and validate the resulting program. It is separate from reading: discovery alone never adds comments or folds unmarked functions. For language-aware source adapters, Python comments are tokenized and JS/TS comments use the optional parser; generic explicit text has no universal language lexer. Avoid generic projection when marker-looking text inside literals is ambiguous.

A host must integrate request projection for the default delayed fold. Source-only post-tool hooks cannot later replace history; without lifecycle information they preserve full text. Use the [context-folding guide](../context-folding/SKILL.md) for the concise marker and recovery workflow.
