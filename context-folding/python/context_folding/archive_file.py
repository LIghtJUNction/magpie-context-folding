"""Agent-independent UTF-8 content-addressed files."""
import hashlib
import os
from pathlib import Path
import re
import tempfile


def archive_path(directory: Path, digest: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid archive hash")
    root = directory / "archive"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root.resolve() / (digest + ".txt")
    if any(c in str(path) for c in "\r\n\0"):
        raise ValueError("Invalid archive path")
    return path


def save_archive_file(directory: Path, text: str) -> Path:
    data = text.encode("utf-8")
    path = archive_path(directory, hashlib.sha256(data).hexdigest())
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
        with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
            if stream.read() != data:
                raise ValueError("Archive file content mismatch")
            os.fsync(stream.fileno())
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.unlink(temporary)
    return path


def reference_body(text: str) -> str:
    return re.sub(r"^line:\d+(?:\r\n|\r|\n)hash:[a-f0-9]{64}(?:\r\n|\r|\n)"
                  r"tokens:\d+(?:\r\n|\r|\n)tokens_method:utf8-bytes/4-ceil(?:\r\n|\r|\n)"
                  r"path:[^\r\n]+(?:\r\n|\r|\n)", "", text)


def region_reference(directory: Path, region: dict, payload: str, reference: str) -> str:
    if not region.get("conversationMarker") or region.get("alreadyFolded"):
        return reference
    newline = re.search(r"\r\n|\r|\n", payload)
    newline = newline.group() if newline else "\n"
    lines = len(re.split(r"\r\n|\r|\n", payload))
    tokens = (len(payload.encode("utf-8")) + 3) // 4
    return newline.join((f"line:{lines}", f"hash:{region['sha256']}", f"tokens:{tokens}",
                         "tokens_method:utf8-bytes/4-ceil",
                         f"path:{archive_path(directory, region['sha256'])}", reference))
