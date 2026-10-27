"""Source annotations: Python AST discovery and explicit cross-language regions.

Discovery never edits source. The core archives originals and region payloads in
one transaction, then uses these ranges to produce reversible compact reads.
``fold_regions`` remains the legacy explicit-region adapter.
"""
from __future__ import annotations

import ast
import hashlib
import io
from pathlib import Path
import re
import tokenize
from typing import Any

_COMMENT_STYLES = (
    ("//", ""), ("#", ""), ("--", ""), (";", ""), ("%", ""),
    ("!", ""), ("'", ""), ('"', ""), ("REM", ""),
    ("/*", "*/"), ("<!--", "-->"), ("(*", "*)"), ("{-", "-}"),
    ("#|", "|#"), ("<#", "#>"),
)


def comment_styles(value: Any) -> list[dict[str, str]]:
    """Validate additional literal delimiters; no executable regex is accepted."""
    if not isinstance(value, list) or len(value) > 32:
        raise ValueError("Invalid source comment styles")
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {"start", "end"}:
            raise ValueError("Invalid source comment style")
        start, end = item.get("start"), item.get("end", "")
        if any(not isinstance(part, str) or len(part) > 64 or part != part.strip()
               or any(char in part for char in "\r\n\x00") for part in (start, end)) or not start:
            raise ValueError("Invalid source comment delimiters")
        style = {"start": start, "end": end}
        if style not in result:
            result.append(style)
    return result


def _marker_styles(extra: list[dict[str, str]]) -> list[tuple[str, str]]:
    styles = set(_COMMENT_STYLES) | {(s["start"], s["end"]) for s in extra}
    return sorted(styles, key=lambda s: (-len(s[0]), -len(s[1]), s))


def _comment_marker(line: str, styles: list[tuple[str, str]]):
    content = line.strip(" \t\r\n")
    for start, end in styles:
        if not content.startswith(start) or (end and not content.endswith(end)):
            continue
        if len(content) < len(start) + len(end):
            continue
        body = content[len(start):len(content) - len(end) if end else None].strip()
        if body.startswith("@context-fold"):
            return (start, end), body
    return None
_MARKER = re.compile(r"@context-fold[ \t]+(begin|end)[ \t]+([^\s]+)[ \t]*$")


def _source_lines(text: str) -> list[str]:
    # Match physical lines, not Unicode separators inside string literals.
    lines = re.findall(r"[^\r\n]*(?:\r\n|\r|\n|$)", text)
    if lines and not lines[-1]:
        lines.pop()
    return lines


def _python_comment_lines(text: str) -> set[int]:
    """Exclude marker-looking text within Python multiline strings."""
    result: set[int] = set()
    for token in tokenize.generate_tokens(io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n")).readline):
        if token.type == tokenize.COMMENT:
            result.add(token.start[0])
    return result


def _python_function_header_lines(text: str) -> dict[int, int]:
    """Map function definition lines to their suite colon's physical line."""
    tokens = tokenize.generate_tokens(io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n")).readline)
    headers: dict[int, int] = {}
    start = None
    depth = 0
    lambdas = 0
    for token in tokens:
        if start is None:
            if token.type == tokenize.NAME and token.string == "def":
                start = token.start[0]
                depth = 0
                lambdas = 0
        elif token.type == tokenize.NAME and token.string == "lambda" and depth == 0:
            lambdas += 1
        elif token.type == tokenize.OP:
            if token.string in "([{":
                depth += 1
            elif token.string in ")]}":
                depth -= 1
            elif token.string == ":" and depth == 0:
                if lambdas:
                    lambdas -= 1
                else:
                    headers[start] = token.start[0]
                    start = None
    return headers


def discover_source(text: str, language: str | None = None, path: str | None = None,
                    styles: Any = None) -> dict[str, Any]:
    """Return validated ranges; unsupported languages use explicit markers only.

    markref v0.1 has a comment lexer, not a structural parser. We do not infer
    braces or function boundaries with regular expressions. Python uses its AST
    and tokenizer; JS/TS validates explicit // and /* */ comments using optional Tree-sitter
    grammars. Other languages require whole-line begin/end annotations.
    """
    extra = comment_styles([] if styles is None else styles)
    marker_styles = _marker_styles(extra)
    inferred = {".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript",
                ".cjs": "javascript", ".jsx": "jsx", ".ts": "typescript", ".mts": "typescript",
                ".cts": "typescript", ".tsx": "tsx"}
    language = (language or inferred.get(Path(path).suffix.lower(), "explicit") if path else language or "explicit").lower()
    if language == "py":
        language = "python"
    from .javascript import LANGUAGES, normalize_language, parse_source, comment_lines
    language = normalize_language(language)
    javascript = language in LANGUAGES
    if language == "python":
        marker_styles = [("#", "")]
    elif javascript:
        marker_styles = [("//", ""), ("/*", "*/")]
    lines = _source_lines(text)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    comments = None
    tree = None
    if javascript:
        javascript_tree, javascript_data = parse_source(text, language)
        comments = comment_lines(javascript_tree, javascript_data)
    if language in {"python", "py"}:
        try:
            tree = ast.parse(text)
            comments = _python_comment_lines(text)
            function_headers = _python_function_header_lines(text)
        except (SyntaxError, ValueError, tokenize.TokenError, IndentationError):
            raise ValueError("Invalid Python source; annotations unchanged") from None
    regions: list[dict[str, Any]] = []

    def add(name: str, kind: str, first: int, last: int, header: str):
        start, end = offsets[first - 1], offsets[last]
        ending = lines[last - 1]
        newline = "\r\n" if ending.endswith("\r\n") else ending[-1:] if ending.endswith(("\n", "\r")) else ""
        end -= len(newline)
        if end <= start:
            return
        key = hashlib.sha256(f"{name}:{start}:{end}".encode()).hexdigest()[:16]
        regions.append({"id": key, "name": name, "kind": kind, "start": start, "end": end,
                        "startLine": first, "endLine": last, "header": header[:200],
                        "disposition": "foldable"})

    if tree is not None:
        compound = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.If, ast.For,
                    ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try)
        compound += tuple(getattr(ast, name) for name in ("Match", "TryStar") if hasattr(ast, name))

        def walk(node, prefix=""):
            name = prefix
            if isinstance(node, compound):
                label = getattr(node, "name", f"{type(node).__name__.lower()}@{node.lineno}")
                name = f"{prefix}.{label}" if prefix else label
                body = getattr(node, "body", None)
                # Multiline suites retain their entire header, including decorators.
                # One-line functions remain readable without automatic folding.
                first = body[0].lineno if body and body[0].lineno > node.lineno else node.lineno
                if body and first > node.lineno:
                    first = min([first] + [d.lineno for d in getattr(body[0], "decorator_list", [])])
                if (not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        or body[0].lineno > function_headers[node.lineno]):
                    add(name, type(node).__name__, first, node.end_lineno, lines[node.lineno - 1].strip())
            for child in ast.iter_child_nodes(node):
                walk(child, name)
        walk(tree)

    opened: list[tuple[str, int, tuple[str, str]]] = []
    for number, line in enumerate(lines, 1):
        match = _comment_marker(line, marker_styles)
        if match is None:
            continue
        style, body = match
        expected_styles = {("//", ""), ("/*", "*/")} if javascript else {("#", "")}
        if comments is not None and (style not in expected_styles or number not in comments):
            continue
        marker = _MARKER.fullmatch(body)
        if marker is None:
            raise ValueError("Malformed source annotation")
        operation, name = marker.groups()
        if operation == "begin":
            opened.append((name, number, style))
        else:
            if not opened or (name, style) != (opened[-1][0], opened[-1][2]):
                raise ValueError("Unmatched source annotation")
            _, first, _ = opened.pop()
            if number > first + 1:
                add(name, "explicit", first + 1, number - 1, name)
    if opened:
        raise ValueError("Unterminated source annotation")
    # Equal and crossing spans are ambiguous. Prefer explicit equal spans;
    # reject crossing ranges before the caller performs any archive writes.
    unique = {}
    for region in regions:
        unique[(region["start"], region["end"])] = region
    regions = sorted(unique.values(), key=lambda r: (r["start"], -r["end"]))
    stack = []
    for region in regions:
        while stack and region["start"] >= stack[-1]["end"]:
            stack.pop()
        if stack and region["end"] > stack[-1]["end"]:
            raise ValueError("Crossing source annotations")
        region["parentId"] = stack[-1]["id"] if stack else None
        stack.append(region)
    if len(regions) > 10000:
        raise ValueError("Too many source annotations")
    return {"language": language, "commentStyles": extra, "parser": "python-ast" if tree is not None else "tree-sitter-explicit" if javascript else "explicit-regions",
            "limitations": ["Only explicit whole-line // or /* */ regions are recognized; structural discovery requires annotate-functions first."] if javascript else [] if tree is not None else ["No structural parser for this language; only explicit whole-line regions are recognized. Marker-looking multiline strings may be misidentified."],
            "regions": regions}


def annotate_python_functions(text: str) -> dict[str, Any]:
    """Add explicit fold markers around multiline functions in valid Python source."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        raise ValueError("Invalid Python source; annotations unchanged") from None
    # Validate existing markers before planning any edits, including their nesting.
    discover_source(text, "python")
    lines = _source_lines(text)
    endings = [re.search(r"\r\n$|\r$|\n$", line) for line in lines]
    default_newline = next((match.group() for match in endings if match), "\n")
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    candidates = []
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    function_headers = _python_function_header_lines(text)
    decorator_lines = [token.start[0] for token in tokenize.generate_tokens(io.StringIO(normalized).readline)
                       if token.type == tokenize.OP and token.string == "@"
                       and not lines[token.start[0] - 1][:token.start[1]].strip()]

    def walk(node, prefix=""):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = f"{prefix}.{child.name}" if prefix else child.name
                if (not isinstance(child, ast.ClassDef)
                        and child.body[0].lineno > function_headers[child.lineno]):
                    start = child.lineno
                    if child.decorator_list:
                        first_decorator = child.decorator_list[0].lineno
                        start = max(line for line in decorator_lines if line <= first_decorator)
                    candidates.append((start, child.end_lineno, name))
                walk(child, name)
            else:
                walk(child, prefix)
    walk(tree)

    existing = []
    stack = []
    for number in sorted(_python_comment_lines(text)):
        match = _comment_marker(lines[number - 1], [("#", "")])
        if match:
            operation, name = _MARKER.fullmatch(match[1]).groups()
            if operation == "begin":
                stack.append((number, name))
            else:
                begin_line, _ = stack.pop()
                existing.append((name, begin_line, number))

    added = []
    events: dict[int, list[tuple[tuple[int, int], str, str]]] = {}
    for start, end, name in candidates:
        if any(mark_name == name and first == start - 1 and last > end
               for mark_name, first, last in existing):
            continue
        indent = re.match(r"[ \t]*", lines[start - 1]).group()
        begin_newline = endings[start - 1].group() if endings[start - 1] else default_newline
        end_newline = endings[end - 1].group() if endings[end - 1] else default_newline
        # At a shared boundary, close inner functions first, then open siblings.
        events.setdefault(offsets[start - 1], []).append(
            ((1, -end), f"{indent}# @context-fold begin {name}", begin_newline))
        # Existing child regions can close after the AST's last statement.
        # Enclose those markers too when adding a previously unmarked parent.
        close_line = max([end] + [last for _, first, last in existing
                                  if start <= first <= end < last])
        events.setdefault(offsets[close_line], []).append(
            ((0, -start), f"{indent}# @context-fold end {name}", end_newline))
        added.append({"name": name, "startLine": start, "endLine": end})
    chunks = []
    cursor = 0
    for offset, markers in sorted(events.items()):
        chunks.append(text[cursor:offset])
        ordered = sorted(markers, key=lambda event: event[0])
        if offset and text[offset - 1] not in "\r\n":
            chunks.append(ordered[0][2])
        for index, (_, marker, newline) in enumerate(ordered):
            chunks.append(marker)
            if offset < len(text) or text.endswith(("\r", "\n")) or index < len(ordered) - 1:
                chunks.append(newline)
        cursor = offset
    chunks.append(text[cursor:])
    output = "".join(chunks)
    # Comments must preserve Python semantics and remain usable by the source API.
    if ast.dump(ast.parse(output)) != ast.dump(tree):
        raise ValueError("Annotations would change Python syntax; annotations unchanged")
    discover_source(output, "python")
    return {"text": output, "added": added, "skippedNested": 0}


def select_regions(regions: list[dict], selectors: Any) -> set[str]:
    if not isinstance(selectors, list) or len(selectors) > 10000 or any(not isinstance(s, str) or not s for s in selectors):
        raise ValueError("Invalid source selectors")
    selected = set()
    for selector in selectors:
        matches = [r["id"] for r in regions if selector in (r["id"], r["name"])]
        if selector == "*":
            matches = [r["id"] for r in regions]
        if not matches:
            raise ValueError("Unknown source selector")
        selected.update(matches)
    return selected


class ReferenceLiteralError(ValueError):
    def __init__(self):
        super().__init__("Visible source contains a reserved reference prefix; use mode='original'")


def _check_literal_references(text: str) -> None:
    if "[[cf:" in text:
        raise ReferenceLiteralError()


def compact_source(text: str, annotation: dict, expand: Any = None, keep_all: bool = False,
                   *, expand_mode: str = "recursive") -> dict:
    if expand_mode not in {"single", "recursive"}:
        raise ValueError("Invalid source expansion mode")
    regions = annotation["regions"]
    expanded = select_regions(regions, [] if expand is None else expand)
    by_id = {r["id"]: r for r in regions}
    # Targeted expansion reveals ancestors; keep/unmarked also protects children.
    protected = set(expanded)
    kept = {r["id"] for r in regions if r["disposition"] != "foldable"}
    for key in expanded | kept:
        parent = by_id[key]["parentId"]
        while parent:
            protected.add(parent)
            parent = by_id[parent]["parentId"]
    chunks, visible, cursor = [], [], 0
    for region in regions:
        if region["start"] < cursor:
            continue
        parent, preserve = region["id"], keep_all
        while parent:
            preserve = preserve or parent in kept or (expand_mode == "recursive" and parent in expanded)
            parent = by_id[parent]["parentId"]
        payload = text[region["start"]:region["end"]]
        if preserve or region["id"] in protected or len(region["reference"]) >= len(payload):
            continue
        _check_literal_references(text[cursor:region["start"]])
        chunks.extend((text[cursor:region["start"]], region["reference"]))
        cursor = region["end"]
        visible.append({key: region[key] for key in ("id", "name", "header", "reference", "startLine", "endLine")})
    _check_literal_references(text[cursor:])
    chunks.append(text[cursor:])
    return {"text": "".join(chunks), "foldedRegions": visible}


def fold_regions(
    client: Any,
    scope: str,
    text: str,
    language: str | None = None,
    min_lines: int = 256,
    commentStyles: Any = None,
) -> dict[str, Any]:
    """Archive interiors of explicitly marked regions longer than min_lines.

    Common line/block comment delimiters are built in; ``commentStyles`` adds
    literal start/end delimiters for other languages (end defaults to empty).
    Python additionally uses tokenization when ``language`` is python/py to
    reject markers inside strings. Other languages use the explicit whole-line
    convention; this fallback does not claim full language parsing.

    Boundary lines remain byte-for-byte intact. A region's terminal newline is
    kept beside the reference and excluded from its archived payload, so resolve
    reproduces the original text exactly, including CRLF and Unicode. Offsets in
    reference metadata count Python string characters, not encoded bytes.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(min_lines, int) or isinstance(min_lines, bool) or min_lines < 0:
        raise ValueError("min_lines must be a nonnegative integer")
    if language is not None and not isinstance(language, str):
        raise TypeError("language must be a string or None")

    def unchanged(reason: str, line: int | None = None) -> dict[str, Any]:
        _check_literal_references(text)
        skipped: dict[str, Any] = {"reason": reason}
        if line is not None:
            skipped["line"] = line
        return {"text": text, "references": [], "skipped": [skipped]}

    extra = comment_styles([] if commentStyles is None else commentStyles)
    marker_styles = _marker_styles(extra)
    python_lines = None
    if language and language.lower() in {"python", "py"}:
        marker_styles = [("#", "")]
        try:
            python_lines = _python_comment_lines(text)
        except (tokenize.TokenError, IndentationError, SyntaxError):
            return unchanged("invalid_python_tokens")

    lines = _source_lines(text)
    regions: list[dict[str, Any]] = []
    opened: dict[str, Any] | None = None
    offset = 0
    for number, line in enumerate(lines, 1):
        match = _comment_marker(line, marker_styles)
        if match is None:
            offset += len(line)
            continue
        style, body = match
        # Python's tokenizer identifies actual # comments; other marker syntax
        # is not a Python comment and must remain ordinary source text.
        if python_lines is not None and (style != ("#", "") or number not in python_lines):
            offset += len(line)
            continue
        marker = _MARKER.fullmatch(body)
        if marker is None:
            return unchanged("malformed_marker", number)
        operation, name = marker.groups()
        if operation == "begin":
            if opened is not None:
                return unchanged("nested_region", number)
            opened = {"name": name, "style": style, "startLine": number, "start": offset + len(line)}
        else:
            if opened is None:
                return unchanged("unmatched_end", number)
            if name != opened["name"] or style != opened["style"]:
                return unchanged("mismatched_end", number)
            opened.update({"endLine": number, "end": offset})
            regions.append(opened)
            opened = None
        offset += len(line)
    if opened is not None:
        return unchanged("unterminated_region", opened["startLine"])

    selected = []
    skipped: list[dict[str, Any]] = []
    cursor = 0
    for region in regions:
        start, end = region["start"], region["end"]
        interior = text[start:end]
        line_count = len(_source_lines(interior))
        if line_count <= min_lines:
            skipped.append({"name": region["name"], "startLine": region["startLine"],
                            "endLine": region["endLine"], "lines": line_count, "reason": "below_threshold"})
            continue
        newline = "\r\n" if interior.endswith("\r\n") else "\n" if interior.endswith("\n") else "\r" if interior.endswith("\r") else ""
        payload = interior[:-len(newline)] if newline else interior
        _check_literal_references(text[cursor:start])
        selected.append((region, payload, newline, line_count))
        cursor = end
    _check_literal_references(text[cursor:])

    # Validate all retained source before the legacy adapter makes any writes.
    chunks: list[str] = []
    references: list[dict[str, Any]] = []
    cursor = 0
    for region, payload, newline, line_count in selected:
        start, end = region["start"], region["end"]
        result = client.call({"action": "put", "scope": scope, "text": payload, "role": "tool"})
        reference = result["reference"]
        if not isinstance(reference, str) or not reference:
            raise ValueError("put returned an invalid reference")
        chunks.extend((text[cursor:start], reference, newline))
        references.append({"name": region["name"], "id": result["id"], "reference": reference,
                           "startLine": region["startLine"], "endLine": region["endLine"],
                           "start": start, "end": end, "lines": line_count})
        cursor = end
    chunks.append(text[cursor:])
    return {"text": "".join(chunks), "references": references, "skipped": skipped}
