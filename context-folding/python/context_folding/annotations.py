"""Explicit fold comments shared by source and editable context text.

Discovery never edits source and never selects functions automatically.
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
    ("", ""), ("//", ""), ("#", ""), ("--", ""), (";", ""), ("%", ""),
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
                    styles: Any = None, *, strict: bool = False) -> dict[str, Any]:
    """Discover only paired, whole-line annotations; never infer foldable code.

    Python and optional JS/TS lexers exclude marker-looking string contents.
    Plain text and other languages use the same literal line protocol. Invalid,
    nested or incomplete pairs leave only their uncertain range visible. Earlier
    complete regions remain eligible. Source-editing helpers use strict validation
    before inserting comments and still reject any damaged marker.
    """
    extra = comment_styles([] if styles is None else styles)
    inferred = {".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript",
                ".cjs": "javascript", ".jsx": "jsx", ".ts": "typescript", ".mts": "typescript",
                ".cts": "typescript", ".tsx": "tsx"}
    language = (language or inferred.get(Path(path).suffix.lower(), "explicit") if path else language or "explicit").lower()
    from .javascript import LANGUAGES, normalize_language, parse_source, comment_lines
    language = "python" if language == "py" else normalize_language(language)
    lines = _source_lines(text)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    marker_styles = _marker_styles(extra)
    comments = None
    parser = "explicit-regions"
    if language == "python":
        marker_styles = [("#", "")]
        # Tokenization is sufficient: source syntax is not used to select blocks.
        try:
            comments = _python_comment_lines(text)
        except (SyntaxError, ValueError, tokenize.TokenError, IndentationError):
            if strict:
                raise ValueError("Invalid Python source; annotations unchanged") from None
            return {"language": language, "commentStyles": extra, "parser": "python-comments",
                    "regions": [], "limitations": ["Invalid Python tokens; original preserved."]}
        parser = "python-comments"
    elif language in LANGUAGES:
        marker_styles = [("//", ""), ("/*", "*/")]
        tree, data = parse_source(text, language)
        comments = comment_lines(tree, data)
        parser = "tree-sitter-explicit"

    regions = []
    opened = None
    invalid = False
    depth = 0
    problems = []

    def problem(reason: str):
        # Reading can preserve only the uncertain range. Editing must reject the
        # entire input before planning or applying any source changes.
        if strict:
            raise ValueError(reason)
        if reason not in problems:
            problems.append(reason)

    for number, line in enumerate(lines, 1):
        match = _comment_marker(line, marker_styles)
        if match is None or (comments is not None and number not in comments):
            continue
        style, body = match
        marker = _MARKER.fullmatch(body)
        if marker is None:
            problem("Malformed source annotation")
            if opened is not None:
                invalid = True
            continue
        operation, name = marker.groups()
        if operation == "begin":
            if opened is not None:
                problem("Nested source annotations are unsupported")
                invalid = True
                depth += 1
            else:
                opened = (name, number, style)
                invalid = False
                depth = 1
            continue
        if opened is None:
            problem("Unmatched source annotation")
            continue
        if depth > 1:
            # Nested content is never a candidate, including apparently valid
            # children. Resume only after the outer region closes correctly.
            depth -= 1
            continue
        if (name, style) != (opened[0], opened[2]):
            problem("Unmatched source annotation")
            invalid = True
            continue
        _, first, _ = opened
        opened = None
        depth = 0
        if invalid or number <= first + 1:
            continue
        start, end = offsets[first], offsets[number - 1]
        payload = text[start:end]
        newline = "\r\n" if payload.endswith("\r\n") else payload[-1:] if payload.endswith(("\r", "\n")) else ""
        end -= len(newline)
        payload = text[start:end]
        if not payload or re.search(r"\[\[cf:v[12]:", payload):
            continue
        sha256 = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        regions.append({"id": sha256[:12], "sha256": sha256, "name": name, "kind": "explicit",
                        "start": start, "end": end, "startLine": first + 1, "endLine": number - 1,
                        "header": name, "parentId": None, "disposition": "foldable"})
    if opened is not None:
        problem("Unterminated source annotation")
    if len(regions) > 10000:
        problem("Too many source annotations")
        regions = []
    # Extend colliding prefixes; do not equate different payloads at 12 digits.
    hashes = {region["sha256"] for region in regions}
    for region in regions:
        length = 12
        while any(other != region["sha256"] and other.startswith(region["sha256"][:length]) for other in hashes):
            length += 2
        region["id"] = region["sha256"][:length]
    limitations = [reason + "; affected text preserved." for reason in problems]
    if comments is None:
        limitations.append("Literal whole-line protocol; no language parser. Marker-looking multiline strings may be misidentified.")
    return {"language": language, "commentStyles": extra, "parser": parser,
            "limitations": limitations, "regions": regions}


def annotate_python_functions(text: str) -> dict[str, Any]:
    """Add explicit fold markers around multiline functions in valid Python source."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        raise ValueError("Invalid Python source; annotations unchanged") from None
    # Validate existing markers before planning any edits, including their nesting.
    discover_source(text, "python", strict=True)
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
    skipped_nested = 0
    for start, end, name in sorted(candidates, key=lambda item: (item[0], -item[1])):
        if any(start <= last and end >= first for _, first, last in existing) or any(
                start <= item["endLine"] and end >= item["startLine"] for item in added):
            skipped_nested += 1
            continue
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
    discover_source(output, "python", strict=True)
    return {"text": output, "added": added, "skippedNested": skipped_nested}


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
    if not regions:
        return {"text": text, "foldedRegions": []}
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


def fold_regions(client: Any, scope: str, text: str, language: str | None = None,
                 commentStyles: Any = None, *, occurrence: str | None = None,
                 requestCycle: int | None = None) -> dict[str, Any]:
    """Project explicit annotations using the same durable source path.

    The host supplies an occurrence and monotonically increasing requestCycle.
    Missing request-cycle information keeps the complete original visible unless
    delay_requests=0 was explicitly configured. No length threshold chooses text.
    """
    request = {"text": text, "limit": 24000}
    if language is not None:
        request["language"] = language
    if commentStyles is not None:
        request["commentStyles"] = commentStyles
    if occurrence is not None:
        request["occurrence"] = occurrence
    if requestCycle is not None:
        request["requestCycle"] = requestCycle
    result = client.read_source(scope, **request)
    # The historical adapter has no continuation interface; publish no partial view.
    if result["nextOffset"] is not None:
        return {"text": text, "references": [], "skipped": [{"reason": "projection-exceeds-adapter-page"}]}
    return {"text": result["text"], "references": result.get("foldedRegions", []),
            "skipped": [] if result.get("delayReason") is None else [{"reason": result["delayReason"]}]}
