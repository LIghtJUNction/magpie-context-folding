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

_COMMENT_LINE = re.compile(
    r"^[ \t]*(?:(?P<line>//|\#|--|;)[ \t]*(?P<line_body>.*?)"
    r"|/\*[ \t]*(?P<block_body>.*?)[ \t]*\*/"
    r"|<!--[ \t]*(?P<html_body>.*?)[ \t]*-->)[ \t]*$"
)
_MARKER = re.compile(r"@context-fold[ \t]+(begin|end)[ \t]+([^\s]+)[ \t]*$")


def _python_comment_lines(text: str) -> set[int]:
    """Exclude marker-looking text within Python multiline strings."""
    result: set[int] = set()
    for token in tokenize.generate_tokens(io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n")).readline):
        if token.type == tokenize.COMMENT:
            result.add(token.start[0])
    return result


def discover_source(text: str, language: str | None = None, path: str | None = None) -> dict[str, Any]:
    """Return validated ranges; unsupported languages use explicit markers only.

    markref v0.1 has a comment lexer, not a structural parser. We do not infer
    braces or function boundaries with regular expressions. Python uses its AST
    and tokenizer; other languages require whole-line begin/end annotations.
    """
    language = (language or ("python" if path and Path(path).suffix.lower() in {".py", ".pyi"} else "explicit")).lower()
    if language == "py":
        language = "python"
    # Match Python physical lines, not Unicode separators inside string literals.
    lines = re.findall(r"[^\r\n]*(?:\r\n|\r|\n|$)", text)
    if lines and not lines[-1]:
        lines.pop()
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    comments = None
    tree = None
    if language in {"python", "py"}:
        try:
            tree = ast.parse(text)
            comments = _python_comment_lines(text)
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
                # One-line suites are archived as whole statements.
                first = body[0].lineno if body and body[0].lineno > node.lineno else node.lineno
                if body and first > node.lineno:
                    first = min([first] + [d.lineno for d in getattr(body[0], "decorator_list", [])])
                add(name, type(node).__name__, first, node.end_lineno, lines[node.lineno - 1].strip())
            for child in ast.iter_child_nodes(node):
                walk(child, name)
        walk(tree)

    opened = None
    for number, line in enumerate(lines, 1):
        match = _COMMENT_LINE.fullmatch(line.rstrip("\r\n"))
        if match is None:
            continue
        style = match.group("line") or ("/*" if match.group("block_body") is not None else "<!--")
        if comments is not None and (style != "#" or number not in comments):
            continue
        body = next(value for value in (match.group("line_body"), match.group("block_body"), match.group("html_body")) if value is not None).strip()
        if not body.startswith("@context-fold"):
            continue
        marker = _MARKER.fullmatch(body)
        if marker is None:
            raise ValueError("Malformed source annotation")
        operation, name = marker.groups()
        if operation == "begin":
            if opened is not None:
                raise ValueError("Nested explicit regions are unsupported")
            opened = (name, number, style)
        else:
            if opened is None or (name, style) != (opened[0], opened[2]):
                raise ValueError("Unmatched source annotation")
            if number > opened[1] + 1:
                add(name, "explicit", opened[1] + 1, number - 1, name)
            opened = None
    if opened is not None:
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
    return {"language": language, "parser": "python-ast" if tree is not None else "explicit-regions",
            "limitations": [] if tree is not None else ["No structural parser for this language; only explicit whole-line regions are recognized. Marker-looking multiline strings may be misidentified."],
            "regions": regions}


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


def compact_source(text: str, annotation: dict, expand: Any = None, keep_all: bool = False) -> dict:
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
            preserve = preserve or parent in kept or parent in expanded
            parent = by_id[parent]["parentId"]
        payload = text[region["start"]:region["end"]]
        if preserve or region["id"] in protected or len(region["reference"]) >= len(payload):
            continue
        chunks.extend((text[cursor:region["start"]], region["reference"]))
        cursor = region["end"]
        visible.append({key: region[key] for key in ("id", "name", "header", "reference", "startLine", "endLine")})
    chunks.append(text[cursor:])
    return {"text": "".join(chunks), "foldedRegions": visible}


def fold_regions(
    client: Any,
    scope: str,
    text: str,
    language: str | None = None,
    min_lines: int = 256,
) -> dict[str, Any]:
    """Archive interiors of explicitly marked regions longer than min_lines.

    Supported whole-line comments: //, #, --, ;, /* ... */, <!-- ... -->.
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
        skipped: dict[str, Any] = {"reason": reason}
        if line is not None:
            skipped["line"] = line
        return {"text": text, "references": [], "skipped": [skipped]}

    python_lines = None
    if language and language.lower() in {"python", "py"}:
        try:
            python_lines = _python_comment_lines(text)
        except (tokenize.TokenError, IndentationError, SyntaxError):
            return unchanged("invalid_python_tokens")

    lines = text.splitlines(keepends=True)
    regions: list[dict[str, Any]] = []
    opened: dict[str, Any] | None = None
    offset = 0
    for number, line in enumerate(lines, 1):
        content = line.rstrip("\r\n")
        match = _COMMENT_LINE.fullmatch(content)
        if match is None:
            offset += len(line)
            continue
        style = match.group("line") or ("/*" if match.group("block_body") is not None else "<!--")
        # Python's tokenizer identifies actual # comments; other marker syntax
        # is not a Python comment and must remain ordinary source text.
        if python_lines is not None and (style != "#" or number not in python_lines):
            offset += len(line)
            continue
        body = next(value for value in (
            match.group("line_body"), match.group("block_body"), match.group("html_body")
        ) if value is not None).strip()
        if not body.startswith("@context-fold"):
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

    chunks: list[str] = []
    references: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    cursor = 0
    for region in regions:
        start, end = region["start"], region["end"]
        interior = text[start:end]
        line_count = len(interior.splitlines())
        if line_count <= min_lines:
            skipped.append({"name": region["name"], "startLine": region["startLine"],
                            "endLine": region["endLine"], "lines": line_count, "reason": "below_threshold"})
            continue
        newline = "\r\n" if interior.endswith("\r\n") else "\n" if interior.endswith("\n") else "\r" if interior.endswith("\r") else ""
        payload = interior[:-len(newline)] if newline else interior
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
