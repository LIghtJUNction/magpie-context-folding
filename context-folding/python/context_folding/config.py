"""Shared annotation settings, including Magpie request-only CLI and savings options."""
from __future__ import annotations

from copy import deepcopy
import math
import os
import re
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

MAX_CONFIG_BYTES = 1024 * 1024
SAFE_INTEGER = 9007199254740991
DEFAULTS = {
    "folding": {"enabled": True, "max_session_bytes": 67108864, "delay_requests": 1,
                "min_savings_tokens": 256},
    "annotations": {"enabled": True, "default_fold": True, "keep": []},
    "gc": {"enabled": False, "strength": "conservative", "idle_seconds": 2592000,
           "max_uses": 2, "retention_seconds": 2592000, "auto_purge": False},
    "magpie": {},
}
_KEYS = {**{section: set(values) for section, values in DEFAULTS.items()},
         "magpie": {"shell_tool_name", "recovery_command", "gateway_timeout_ms"}}
_RANGES = {
    "folding.max_session_bytes": (1, 67108864, True),
    "folding.delay_requests": (0, SAFE_INTEGER, True),
    "folding.min_savings_tokens": (0, SAFE_INTEGER, True),
    "gc.idle_seconds": (0, 315576000, False),
    "gc.max_uses": (0, 1000000000, True),
    "gc.retention_seconds": (0, 315576000, False),
    "magpie.gateway_timeout_ms": (100, 10000, True),
}
_REMOVED_BUDGET = {"context_window_tokens", "reserve_output_tokens", "budget_hints"}
_REMOVED = {"mode", "threshold_tokens", "keep_recent_messages", "head_chars", "minimum_saving_usd"}

class ConfigError(ValueError):
    """A settings source could not be read, parsed, or validated."""

def _fail(source: str | Path, key: str, reason: str) -> None:
    raise ConfigError(f"{source}: {key}: {reason}") from None


def global_config_path() -> Path:
    """Use XDG_CONFIG_HOME when nonempty, otherwise the user's .config."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "context-folding" / "config.toml"


def _exists(path: Path) -> bool:
    try:
        path.stat()
    except FileNotFoundError:
        return False
    except OSError as error:
        _fail(path, "file", f"cannot inspect settings path ({error})")
    return True


def project_config_path(project_dir: str | os.PathLike[str] | None = None) -> Path | None:
    """Find only the nearest settings file, including but never above a Git root."""
    try:
        directory = Path.cwd() if project_dir is None else Path(project_dir)
        directory = directory.resolve()
        if not directory.is_dir():
            _fail(directory, "project_dir", "expected an existing directory")
    except (OSError, RuntimeError, ValueError) as error:
        if isinstance(error, ConfigError):
            raise
        _fail(str(project_dir), "project_dir", f"cannot inspect project directory ({error})")
    while True:
        candidate = directory / ".context-folding.toml"
        if _exists(candidate):
            return candidate
        if _exists(directory / ".git") or directory.parent == directory:
            return None
        directory = directory.parent


def _read(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_CONFIG_BYTES + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        _fail(path, "file", f"cannot read settings ({error})")
    if len(content) > MAX_CONFIG_BYTES:
        _fail(path, "file", f"settings exceed {MAX_CONFIG_BYTES} bytes")
    try:
        return tomllib.loads(content.decode("utf-8"))
    except (ValueError, RecursionError) as error:
        _fail(path, "TOML", "invalid settings")


def _merge(base: dict, updates: dict) -> None:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = deepcopy(value)


def _number(value: Any, minimum: int | float, maximum: int | float = math.inf,
            *, integer: bool = False) -> bool:
    if type(value) is not int and (integer or type(value) is not float):
        return False
    # Compare first: math.isfinite() may overflow on arbitrary-size Python ints.
    return minimum <= value <= maximum and (type(value) is int or math.isfinite(value))


def _validate(data: Any, source: str | Path) -> None:
    if not isinstance(data, dict):
        _fail(source, "settings", "expected a table")
    for section, values in data.items():
        if section == "version":
            if type(values) is not int or values != 1:
                _fail(source, section, "expected version 1")
            continue
        if section == "policy":
            _fail(source, section, "removed: delete policy settings; only explicit fold annotations are supported")
        if section not in _KEYS:
            _fail(source, str(section), "unknown section")
        if not isinstance(values, dict):
            _fail(source, section, "expected a table")
        for key, value in values.items():
            name = f"{section}.{key}"
            if section == "folding" and key in _REMOVED_BUDGET:
                _fail(source, name, "removed: delete context-window, output-reserve and budget-hint settings; "
                      "context budgets are not managed by this project")
            if (section == "folding" and key in _REMOVED) or name == "magpie.accounting":
                _fail(source, name, "removed: delete strategy/automatic-folding settings; use explicit fold annotations")
            if name == "magpie.recovery_tool_name":
                _fail(source, name, "removed: MCP recovery was removed; use magpie.shell_tool_name for a callable shell wrapper")
            if key not in _KEYS[section]:
                _fail(source, name, "unknown key")
            if key in {"enabled", "default_fold", "auto_purge"}:
                valid, expected = type(value) is bool, "expected a boolean"
            elif name == "annotations.keep":
                valid = isinstance(value, list) and all(isinstance(item, str) and item and "\0" not in item for item in value)
                expected = "expected an array of nonempty strings without NUL"
            elif name == "gc.strength":
                valid = isinstance(value, str) and value in {"off", "conservative", "balanced", "aggressive"}
                expected = "expected off, conservative, balanced, or aggressive"
            elif name == "magpie.shell_tool_name":
                valid = isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", value) is not None
                expected = "expected a shell tool identifier"
            elif name == "magpie.recovery_command":
                valid = isinstance(value, str) and bool(value.strip()) and len(value) <= 4096 and not any(char in value for char in "\0\r\n")
                expected = "expected a nonempty single-line CLI command of at most 4096 characters"
            else:
                low, high, integer = _RANGES[name]
                valid = _number(value, low, high, integer=integer)
                expected = f"expected {'integer' if integer else 'finite number'} in [{low}, {high}]"
            if not valid:
                _fail(source, name, expected)


def load_config(project_dir: str | os.PathLike[str] | None = None,
                overrides: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Merge defaults < global < nearest project < explicit overrides; never write."""
    result = deepcopy(DEFAULTS)

    def apply(data: dict, source: str | Path) -> None:
        _validate(data, source)
        _merge(result, {key: value for key, value in data.items() if key != "version"})

    global_path = global_config_path()
    global_data = _read(global_path)
    if global_data is not None:
        apply(global_data, global_path)
    project_path = project_config_path(project_dir)
    if project_path is not None:
        project_data = _read(project_path)
        if project_data is not None:
            apply(project_data, project_path)
    if overrides is not None:
        apply(overrides, "<overrides>")
    return result
