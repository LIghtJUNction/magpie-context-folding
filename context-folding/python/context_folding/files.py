"""Immutable UTF-8 files: publish complete bytes before issuing a reference."""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import stat


def _directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    mode = path.lstat().st_mode
    if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
        raise OSError("Archive directory must be a real directory")
    os.chmod(path, 0o700)


def _verify(path: Path, data: bytes) -> None:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise OSError("Archive item must be a regular file")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise OSError("Archive item must be a regular file")
        if source.read(len(data) + 1) != data:
            raise OSError("Archive item differs from its immutable original")
        os.fchmod(source.fileno(), 0o600)
        os.fsync(source.fileno())


def _sync_directories(root: Path, path: Path) -> None:
    # Windows does not support opening directories with the POSIX API.
    if os.name == "nt":
        return
    for directory in (path.parent, root, root.parent):
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def publish(root: Path, path: Path, text: str) -> None:
    """Atomic, no-clobber publication; existing bytes must match exactly.

    The private root and scope directories are owned by this archive. Files are
    never automatically deleted: a reference can outlive SQLite's root set.
    """
    data = text.encode("utf-8")
    _directory(root)
    _directory(path.parent)
    if path.exists() or path.is_symlink():
        _verify(path, data)
        _sync_directories(root, path)
        return
    temporary = path.parent / (".pending-" + secrets.token_hex(16))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            _verify(path, data)
        temporary.unlink()
        # The file and its directory entry survive a completed operation.
        _sync_directories(root, path)
    finally:
        temporary.unlink(missing_ok=True)
