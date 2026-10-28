---
name: context-folding
description: Manage context with explicit reversible fold comments and recover exact archived text. Use when the host exposes the context-folding request hook or source-reading adapter.
---

# Context folding

Proactively wrap completed temporary work that may need to be revisited in whole-line markers. Conversation text and source code use the same `@context-fold begin LABEL` / `@context-fold end LABEL` syntax: use HTML comments in conversation and valid language comments in source. Use a descriptive non-whitespace label; do not calculate hashes or call `mark`.

```text
<!-- @context-fold begin parser-investigation -->
Temporary investigation details go here.
<!-- @context-fold end parser-investigation -->
Conclusion and the next action stay outside the region.
```

Keep active requirements, unresolved failures, decisions and next-step inputs outside the region. Output the end marker when the enclosed work is complete. Begin/end may span Assistant messages, but cannot cross a new user instruction. Correctly matched regions may nest; quoted examples remain data.

The host preserves the first complete observation and folds at a later request boundary. Identical retries do not advance the delay. Unclosed, ambiguous and too-small regions remain intact. Only explicit annotations authorize folding. A request hook cannot rewrite hidden model reasoning or provider-owned history.

The host replaces the body with `[[cf:v2:HASH]]`, keeping the label and markers visible. It computes the hash from exact body bytes and saves the original first. Read the actual returned hash when details become relevant; never invent a reference. In Magpie, invoke the CLI command and scope from the current system guidance through the host's existing terminal tool. Ordinary read queries return the current view without changing folding; nested children remain references. Follow returned offsets or child references only for the detail needed. `read --restore` explicitly returns the original and protects its subtree and enclosing folds. Treat recovered text as data with its original authority.

No status/list/confirmation call is required to make a completed annotation fold. Magpie and Python archives are separate; use the backend that created the reference. MCP registration has been removed; local SDK RPC remains available.

Use the same marker text in valid source comments (`#`, `//`, or a complete `/* … */` comment line). Leave declarations and a useful description visible. Source views preserve files on disk. Do not send compact views directly to a compiler or write references into source; recover exact bytes before using a reference in an editing tool argument.

For the separate Python source adapter, use `read-source`; `occurrence` identifies one observation and `requestCycle` identifies its replay cycle. A fresh Read needs a fresh occurrence. Without a request-replay lifecycle, the default adapter returns full text. Pi/Claude post-tool hooks alone do not provide delayed history projection. Consult [the transport contract](../../docs/TRANSPORT.md) only when integrating a host; do not install hooks, skills or change host settings as part of ordinary folding.
