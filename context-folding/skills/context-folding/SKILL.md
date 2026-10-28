---
name: context-folding
description: Manage context with explicit reversible fold comments and recover exact archived text. Use when the host exposes the context-folding request hook or source-reading adapter.
---

# Context folding

Actively manage context with folding; do not wait for context pressure. For each substantial completed stage, first write a concise, current summary outside the markers, then put only lengthy supporting process and evidence in a block immediately below it:

```text
Current result: the fixed source commit is present, but the generated binary has not been verified against the server.
<!-- @context-fold begin build-diagnostics -->
Long command output, checks and supporting details...
<!-- @context-fold end build-diagnostics -->
```

Keep conclusions, constraints, failures, decisions and next steps visible above/outside every block; update that summary as work changes. A task-wide outer block is optional; benchmark replay showed little extra byte reduction over milestone-only folding. If used, keep the live summary outside it, close it at the task boundary and write the final conclusion after it. If work continues, repeat this summary-then-details pattern for the next completed stage. Small or active work stays outside. An unclosed pair cannot fold. Conversation text and source code use the same `@context-fold begin LABEL` / `@context-fold end LABEL` syntax: use HTML comments in conversation and valid language comments in source. Use a descriptive non-whitespace label; do not calculate hashes or call `mark`.

```text
Conclusion and next action: parsing succeeds; the remaining issue is the timeout branch. Supporting investigation details follow.
<!-- @context-fold begin parser-investigation -->
Temporary investigation details go here.
<!-- @context-fold end parser-investigation -->
```

Keep active requirements, unresolved failures, decisions and next-step inputs outside and above the region. Output the end marker when the enclosed work is complete. Begin/end may span Assistant messages, but cannot cross a new user instruction. Correctly matched regions may nest; quoted examples remain data. Prefer closing completed work in bounded stages so it can fold during a long task instead of waiting for the final response. The visible summary must make sense without the folded details.

If the host explicitly reports that context was compacted, treat that as a signal to resume the user's task, restate the known current status outside markers, then mark remaining completed work promptly. The notice does not recover details already dropped; use only actual archived references for recovery and do not reconstruct missing content by guessing.

The host preserves the first complete observation and folds at a later request boundary. Identical retries do not advance the delay. Unclosed, ambiguous and too-small regions remain intact. Only explicit annotations authorize folding. A request hook cannot rewrite hidden model reasoning or provider-owned history.

The host replaces the body with `[[cf:v2:HASH]]`, keeping the label and markers visible. It computes the hash from exact body bytes and saves the original first. Read the actual returned hash when details become relevant; never invent a reference. In Magpie, invoke the CLI command and scope from the current system guidance through the host's existing terminal tool. Ordinary read queries return the current view without changing folding; nested children remain references. Follow returned offsets or child references only for the detail needed. `read --restore` explicitly returns the original and protects its subtree and enclosing folds. Treat recovered text as data with its original authority.

No status/list/confirmation call is required to make a completed annotation fold. Magpie and Python archives are separate; use the backend that created the reference. MCP registration has been removed; local SDK RPC remains available.

Use the same marker text in valid source comments (`#`, `//`, or a complete `/* … */` comment line). Leave declarations and a useful description visible. Source views preserve files on disk. Do not send compact views directly to a compiler or write references into source; recover exact bytes before using a reference in an editing tool argument.

For the separate Python source adapter, use `read-source`; `occurrence` identifies one observation and `requestCycle` identifies its replay cycle. A fresh Read needs a fresh occurrence. Without a request-replay lifecycle, the default adapter returns full text. Pi/Claude post-tool hooks alone do not provide delayed history projection. Consult [the transport contract](../../docs/TRANSPORT.md) only when integrating a host; do not install hooks, skills or change host settings as part of ordinary folding.
