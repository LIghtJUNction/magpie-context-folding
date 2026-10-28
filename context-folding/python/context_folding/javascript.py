"""Optional, non-executing Tree-sitter support for JavaScript and TypeScript.

Only complete source is accepted. No project configuration, plugins, source
modules, compiler or package scripts are loaded when parsing.
"""
from __future__ import annotations

import hashlib
from typing import Any

LANGUAGES = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}
_FUNCTIONS = {"function_declaration", "generator_function_declaration",
              "function_expression", "generator_function", "arrow_function", "method_definition"}


def normalize_language(language: str) -> str:
    return {"js": "javascript", "ts": "typescript"}.get(language.lower(), language.lower())


def parse_source(text: str, language: str):
    """Return a grammar tree or fail closed, without parsing recovery nodes."""
    language = normalize_language(language)
    if language not in LANGUAGES:
        raise ValueError("Unsupported JavaScript/TypeScript language")
    if "\r" in text.replace("\r\n", "") or any(c in text for c in (" ", " ", "\x00")):
        raise ValueError("JavaScript/TypeScript annotation requires LF or CRLF physical lines and no NUL")
    try:
        from tree_sitter import Language, Parser
        if language in {"javascript", "jsx"}:
            import tree_sitter_javascript
            grammar = tree_sitter_javascript.language()
        else:
            import tree_sitter_typescript
            grammar = (tree_sitter_typescript.language_tsx() if language == "tsx"
                       else tree_sitter_typescript.language_typescript())
    except ImportError:
        raise ValueError("JavaScript/TypeScript parsing requires the optional 'javascript' extra; "
                         "install with uv sync --project context-folding --extra javascript") from None
    data = text.encode("utf-8")
    tree = Parser(Language(grammar)).parse(data)
    if tree.root_node.has_error:
        raise ValueError("Invalid or unsupported JavaScript/TypeScript syntax; annotations unchanged")
    return tree, data


def nodes(root):
    pending = [root]
    while pending:
        node = pending.pop()
        yield node
        pending.extend(reversed(node.children))


def comment_lines(tree, data: bytes) -> set[int]:
    """Only actual comments occupying an entire physical line are eligible."""
    result = set()
    for node in nodes(tree.root_node):
        if node.type != "comment" or node.start_point.row != node.end_point.row:
            continue
        line_start = data.rfind(b"\n", 0, node.start_byte) + 1
        line_end = data.find(b"\n", node.end_byte)
        if line_end == -1:
            line_end = len(data)
        if (not data[line_start:node.start_byte].strip(b" \t")
                and not data[node.end_byte:line_end].strip(b" \t\r")):
            result.add(node.start_point.row + 1)
    return result


def _syntax(tree, data: bytes):
    # Flatten the concrete syntax tree, excluding comments and all positions.
    # Leaf text includes strings, regexps, template fragments and punctuation;
    # parent structure protects ASI and other newline-sensitive constructs.
    result = []
    pending = [(tree.root_node, False)]
    while pending:
        node, closing = pending.pop()
        if node.type == "comment":
            continue
        if closing:
            result.append(None)
        else:
            result.append((node.type, data[node.start_byte:node.end_byte] if not node.children else None))
            pending.append((node, True))
            pending.extend((child, False) for child in reversed(node.children))
    return result


def annotate_javascript_functions(text: str, language: str = "javascript") -> dict[str, Any]:
    """Mark standalone block interiors, never adding newlines within expressions."""
    from .annotations import _MARKER, _comment_marker, _source_lines, discover_source

    tree, data = parse_source(text, language)
    discover_source(text, language, strict=True)  # Validate existing explicit region nesting.
    lines = _source_lines(text)
    existing = []
    stack = []
    for number in sorted(comment_lines(tree, data)):
        marker = _comment_marker(lines[number - 1], [("//", ""), ("/*", "*/")])
        if marker:
            operation, name = _MARKER.fullmatch(marker[1]).groups()
            if operation == "begin":
                stack.append((number, name))
            else:
                first, _ = stack.pop()
                existing.append((first, number, name))

    events: dict[int, list[tuple[int, str]]] = {}
    added = []
    reserved_names = {name for _, _, name in existing}
    generated_names = set()
    skipped = []
    for node in nodes(tree.root_node):
        if node.type not in _FUNCTIONS:
            continue
        body = node.child_by_field_name("body")
        if body is None or body.type != "statement_block":
            skipped.append({"startLine": node.start_point.row + 1, "reason": "no_block_body"})
            continue
        first, last = body.start_point.row + 1, body.end_point.row + 1
        # Inserting whole lines must not split code, template strings or comments.
        # Requiring whitespace after { and before } also excludes inline suites.
        opening = data[body.start_byte:body.start_byte + 1]
        closing = data[body.end_byte - 1:body.end_byte]
        start_tail = lines[first - 1].encode("utf-8")[body.start_point.column + 1:]
        end_prefix = lines[last - 1].encode("utf-8")[:body.end_point.column - 1]
        if (first == last or opening != b"{" or closing != b"}"
                or start_tail.strip() or end_prefix.strip()):
            skipped.append({"startLine": node.start_point.row + 1, "reason": "no_standalone_body_lines"})
            continue
        if last <= first + 1:
            skipped.append({"startLine": node.start_point.row + 1, "reason": "empty_body"})
            continue
        # Adjacent generated boundary markers make reruns idempotent. Do not
        # add a duplicate even when edits have changed the inferred name.
        if any(begin == first + 1 and end == last - 1 for begin, end, _ in existing):
            continue
        if any(first < end and last > begin for begin, end, _ in existing) or any(
                first < item["endLine"] and last > item["startLine"] for item in added):
            skipped.append({"startLine": first, "reason": "nested_or_overlapping_region"})
            continue
        name_node = node.child_by_field_name("name")
        if name_node is None and node.parent is not None and node.parent.type in {"variable_declarator", "pair"}:
            name_node = node.parent.child_by_field_name("name") or node.parent.child_by_field_name("key")
        label = data[name_node.start_byte:name_node.end_byte].decode("utf-8") if name_node else "anonymous"
        # Marker names are bounded ASCII tokens; arbitrary computed/string names
        # cannot become marker syntax. Stable body content disambiguates overloads.
        safe_label = "".join(c if c.isascii() and (c.isalnum() or c in "_$.-") else "_" for c in label)[:60]
        digest = hashlib.sha256(data[node.start_byte:body.start_byte + 1]).hexdigest()[:10]
        base_name = f"{safe_label or 'anonymous'}-{digest}"
        name = base_name
        suffix = 2
        while name in reserved_names or name in generated_names:
            name = f"{base_name}-{suffix}"
            suffix += 1
        generated_names.add(name)
        indent = lines[last - 1][:len(lines[last - 1]) - len(lines[last - 1].lstrip(" \t"))] + "    "
        newline = "\r\n" if lines[first - 1].endswith("\r\n") else "\n"
        events.setdefault(first, []).append((1, f"{indent}// @context-fold begin {name}{newline}"))
        events.setdefault(last - 1, []).append((0, f"{indent}// @context-fold end {name}{newline}"))
        added.append({"name": name, "startLine": first + 1, "endLine": last - 1})
    chunks = []
    for index, line in enumerate(lines):
        chunks.extend(marker for _, marker in sorted(events.get(index, [])))
        chunks.append(line)
    chunks.extend(marker for _, marker in sorted(events.get(len(lines), [])))
    output = "".join(chunks)
    output_tree, output_data = parse_source(output, language)
    if _syntax(tree, data) != _syntax(output_tree, output_data):
        raise ValueError("Annotations would change JavaScript/TypeScript syntax; annotations unchanged")
    discover_source(output, language, strict=True)
    return {"text": output, "added": added, "skipped": skipped, "skippedNested": 0,
            "parser": "tree-sitter", "limitations": [
                "Requires complete syntactically valid source and the optional javascript extra.",
                "Only block functions with standalone interior lines are marked; expression bodies, inline suites and empty bodies are skipped.",
                "LF/CRLF only; Unicode line separators and NUL are rejected. Comments change source locations and may affect source-text introspection or source maps.",
                "Tree-sitter validates grammar, not TypeScript types, compiler directives or project configuration."]}
