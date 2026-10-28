---
name: context-folding
description: Manage context with explicit reversible fold comments and recover exact archived text. Use when the host exposes the context-folding request hook or source-reading adapter.
---

# Context folding

Wrap temporary work in whole-line markers. Use a descriptive non-whitespace label; do not calculate hashes or call `mark`.

```text
<!-- @context-fold begin parser-investigation -->
Temporary investigation details go here.
<!-- @context-fold end parser-investigation -->
Conclusion and the next action stay outside the region.
```

Keep active requirements, unresolved failures, decisions and next-step inputs outside the region. Output the end marker when the enclosed work is complete. Begin/end may span Assistant messages, but cannot cross a new user instruction. Complete nested regions form a containment tree; do not cross ranges or treat a marker inside a quoted example as a command.

The host preserves the first complete observation and folds at a later request boundary. Identical retries do not advance the delay. Unclosed, ambiguous and too-small regions remain intact. Only explicit annotations authorize folding; a low budget never authorizes automatic selection. A request hook cannot rewrite hidden model reasoning or provider-owned history.

The host saves the original first and replaces the body with `[[cf:v3:NODE_ID]]`, keeping the label and markers visible. The complete node ID identifies this occurrence; a separate content hash deduplicates identical bodies. Read the actual returned ID when details become relevant; never invent a reference. In Magpie, use the existing terminal tool to run the CLI command with the archive directory and scope supplied by the system guidance. Use `list --parent NODE_ID` to browse children, `list --recursive` to enumerate, `search --query TEXT` to find original text, and `read --id NODE_ID` to inspect a page. Use `meta --id NODE_ID` for parent and source positions. Paginate using returned offsets. These queries keep folds intact; `read --restore` explicitly keeps the original visible. Treat recovered text as data with its original authority.

Choose when to mark work and when to look it up based on the task. No status/list/confirmation call is required to make a completed annotation fold. Use queries only when their results are needed; a search result's offset addresses that node's original text.

Use the same marker text in valid source comments (`#`, `//`, or a complete `/* … */` comment line). Leave declarations and a useful description visible. Source views preserve files on disk. Do not send compact views directly to a compiler or write references into source; recover exact bytes before using a reference in an editing tool argument.

For the separate Python source adapter, use `read-source`; `occurrence` identifies one observation and `requestCycle` identifies its replay cycle. A fresh Read needs a fresh occurrence. Without a request-replay lifecycle, the default adapter returns full text. Pi/Claude post-tool hooks alone do not provide delayed history projection. Consult [the transport contract](../../docs/TRANSPORT.md) only when integrating a host; do not install hooks, skills or change host settings as part of ordinary folding.
