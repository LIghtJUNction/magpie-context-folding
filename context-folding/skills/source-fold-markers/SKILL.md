---
name: source-fold-markers
description: Add explicit, optionally nested source-folding comments while keeping useful declarations visible. Use when authoring or editing source for the context-folding reader.
---

# Source fold markers

Use whole-line comments in the source language:

```rust
// Decode the validated frame.
// @context-fold begin decode-frame
let header = read_header(input)?;
// @context-fold begin payload
let payload = read_payload(input, header.length)?;
validate_payload(&payload)?;
// @context-fold end payload
// @context-fold end decode-frame
```

Match each label and comment shell. Close inner regions before outer ones. Leave necessary declarations, active decisions and short descriptions outside; preserve indentation and line endings. Do not cross pairs, place markers in strings or annotate trivial content just to create a reference.

Only annotations permit folding. The system saves exact originals and creates hashes; it does not choose functions by size, AST, age or token pressure. Parent views retain child references. Use list/meta to discover children, grep for relevant evidence, and bounded read for selected lines. These queries do not unfold history. Never write compact views back into real source.

`annotate-functions` is an explicit source-editing helper. Preview requested changes, respect edit scope and validate the program. Python uses comment tokens; JS/TS uses optional parser support. Generic literal parsing has no universal lexer and can misread marker-shaped text inside multiline strings.

For the concise query workflow, see [context-folding](../context-folding/SKILL.md). A host must supply request replay for delayed source projection; a one-shot post-tool hook does not add that lifecycle.
