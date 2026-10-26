"""Validated global and nearest-project TOML settings, with no persistence."""
from __future__ import annotations

from copy import deepcopy
import math
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib


MAX_CONFIG_BYTES = 1024 * 1024
DEFAULTS: dict[str, dict[str, Any]] = {
    "folding": {
        "mode": "intelligence",
        "enabled": True,
        "threshold_tokens": 64000,
        "keep_recent_messages": 12,
        "head_chars": 400,
        "max_session_bytes": 67108864,
        "minimum_saving_usd": 0.000001,
    },
    "annotations": {"enabled": True, "default_fold": True, "keep": []},
    "gc": {
        "enabled": False,
        "strength": "conservative",
        "idle_seconds": 2592000,
        "max_uses": 2,
        "retention_seconds": 2592000,
        "auto_purge": False,
    },
    "magpie": {},
    "policy": {"mode": "bytes", "auto_roles": ["tool"], "min_chars": 12000, "summary_chars": 1600,
               "minimum_saving_usd": 0.000001},
}
_KEYS = {
    **{section: set(values) for section, values in DEFAULTS.items()},
    "magpie": {"recovery_tool_name", "gateway_timeout_ms", "accounting"},
    "policy": {"mode", "auto_roles", "min_chars", "summary_chars", "minimum_saving_usd", "cost", "script", "certificate_script"},
}
_MODES = {
    "intelligence": (64000, 12, 400, ["tool"], 12000, 1600),
    "balanced": (32000, 6, 160, ["tool"], 4096, 800),
    "economy": (8192, 2, 0, ["assistant", "tool"], 2048, 320),
}


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


def _valid_url(value: Any) -> bool:
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.hostname)
    except ValueError:
        return False


def _validate(data: Any, source: str | Path) -> None:
    if not isinstance(data, dict):
        _fail(source, "settings", "expected a table")
    for section, values in data.items():
        if section == "version":
            if type(values) is not int or values != 1:
                _fail(source, section, "expected version 1")
            continue
        if section not in _KEYS:
            _fail(source, str(section), "unknown section")
        if not isinstance(values, dict):
            _fail(source, section, "expected a table")
        if section == "policy":
            _validate_policy(values, source)
            continue
        for key, value in values.items():
            name = f"{section}.{key}"
            if key not in _KEYS[section]:
                _fail(source, name, "unknown key")
            if key in {"enabled", "default_fold", "auto_purge"}:
                valid, expected = type(value) is bool, "expected a boolean"
            elif name == "annotations.keep":
                valid = isinstance(value, list) and all(
                    isinstance(item, str) and item and "\x00" not in item for item in value
                )
                expected = "expected an array of nonempty strings without NUL"
            elif name == "gc.strength":
                valid = isinstance(value, str) and value in _STRENGTHS
                expected = "expected off, conservative, balanced, or aggressive"
            elif name == "folding.mode":
                valid = isinstance(value, str) and value in {*_MODES, "agentic"}
                expected = "expected intelligence, balanced, economy, or agentic"
            elif name == "magpie.recovery_tool_name":
                valid = isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", value) is not None
                expected = "expected a recovery tool identifier"
            elif name == "magpie.accounting":
                _validate_accounting(value, source)
                continue
            else:
                minimum, maximum, integer = _RANGES[name]
                valid = _number(value, minimum, maximum, integer=integer)
                kind = "integer" if integer else "finite number"
                expected = f"expected {kind} in [{minimum}, {maximum}]"
            if not valid:
                _fail(source, name, expected)


def _validate_accounting(data: Any, source: str | Path) -> None:
    if not isinstance(data, dict):
        _fail(source, "magpie.accounting", "expected a table")
    for key, value in data.items():
        name = f"magpie.accounting.{key}"
        if key == "url":
            if not _valid_url(value):
                _fail(source, name, "expected an http/https URL with a nonempty host")
        elif key == "timeout_ms":
            if not _number(value, 50, 10000, integer=True):
                _fail(source, name, "expected an integer in [50, 10000]")
        else:
            _fail(source, name, "unknown key")


_SCRIPT_DEFAULTS = {"timeout_ms": 1000, "max_output_bytes": 65536,
                    "max_input_bytes": 8388608, "max_summary_chars": 2000}
_COST_DEFAULTS = {"bytes_per_token_lower": 1, "bytes_per_token_upper": 8,
                  "output_price_per_million": 0, "overhead_usd": 0,
                  "output_tokens": 0, "restore_tokens": 0}
_SAFE_COUNT = 9007199254740991


def _validate_policy(data: dict, source: str | Path, *, complete: bool = False) -> None:
    for key, value in data.items():
        name = f"policy.{key}"
        if key not in _KEYS["policy"]:
            _fail(source, name, "unknown key")
        if key == "mode":
            valid = isinstance(value, str) and value in {"bytes", "cost"}
        elif key == "auto_roles":
            valid = (isinstance(value, list) and len(value) <= 3
                     and all(isinstance(role, str) and role in {"user", "assistant", "tool"} for role in value)
                     and len(set(value)) == len(value))
        elif key == "min_chars":
            valid = _number(value, 0, _SAFE_COUNT, integer=True)
        elif key == "summary_chars":
            valid = _number(value, 256, 2000, integer=True)
        elif key == "minimum_saving_usd":
            valid = _number(value, 0)
        elif key in {"script", "certificate_script"}:
            _validate_script(value, source, name, complete=complete)
            continue
        else:
            _validate_cost(value, source, complete=complete)
            continue
        if not valid:
            _fail(source, name, "invalid setting")


def _validate_script(data: Any, source: str | Path, name: str, *, complete: bool) -> None:
    if not isinstance(data, dict):
        _fail(source, name, "expected a table")
    ranges = {"timeout_ms": 60000, "max_output_bytes": 1048576,
              "max_input_bytes": 67108864, "max_summary_chars": 16384}
    for key, value in data.items():
        if key == "command":
            valid = (isinstance(value, list) and len(value) >= 1
                     and all(isinstance(arg, str) and "\x00" not in arg for arg in value)
                     and Path(value[0]).is_absolute())
        elif key in ranges:
            valid = _number(value, 1, ranges[key], integer=True)
        else:
            _fail(source, f"{name}.{key}", "unknown key")
        if not valid:
            _fail(source, f"{name}.{key}", "invalid setting")
    if complete and "command" not in data:
        _fail(source, f"{name}.command", "required when script is configured")


def _validate_incremental(data: Any, source: str | Path, *, complete: bool) -> None:
    name = "policy.cost.incremental"
    if not isinstance(data, dict):
        _fail(source, name, "expected a table")
    counts = {"tool_calls", "model_round_trips", "input_tokens", "output_tokens"}
    prices = {"input_price_per_million", "output_price_per_million", "tool_fees_usd"}
    for key, value in data.items():
        if key in counts:
            if not _number(value, 0, _SAFE_COUNT, integer=True):
                _fail(source, f"{name}.{key}", "expected a nonnegative safe integer")
        elif key in prices:
            if not _number(value, 0):
                _fail(source, f"{name}.{key}", "expected a finite nonnegative number")
        else:
            _fail(source, f"{name}.{key}", "unknown key")
    if complete and not (counts | prices) <= data.keys():
        _fail(source, name, "all seven incremental bounds are required")


def _validate_cost(data: Any, source: str | Path, *, complete: bool) -> None:
    if not isinstance(data, dict):
        _fail(source, "policy.cost", "expected a table")
    rates = {"input", "cache_read", "cache_write"}
    for key, value in data.items():
        name = f"policy.cost.{key}"
        if key in rates:
            if not isinstance(value, dict):
                _fail(source, name, "expected a table")
            for bound, amount in value.items():
                if bound not in {"lower", "upper"}:
                    _fail(source, f"{name}.{bound}", "unknown key")
                if not _number(amount, 0):
                    _fail(source, f"{name}.{bound}", "expected a finite nonnegative number")
            if complete and not {"lower", "upper"} <= value.keys():
                _fail(source, name, "lower and upper are required")
            if complete and value["lower"] > value["upper"]:
                _fail(source, name, "lower must not exceed upper")
        elif key == "incremental":
            _validate_incremental(value, source, complete=complete)
        elif key in {"bytes_per_token_lower", "bytes_per_token_upper"}:
            if not _number(value, 0) or value == 0:
                _fail(source, name, "expected a positive finite number")
        elif key in {"output_tokens", "restore_tokens"}:
            if not _number(value, 0, _SAFE_COUNT, integer=True):
                _fail(source, name, "expected a nonnegative safe integer")
        elif key in {"output_price_per_million", "overhead_usd"}:
            if not _number(value, 0):
                _fail(source, name, "expected a finite nonnegative number")
        else:
            _fail(source, name, "unknown key")
    if complete:
        if not rates <= data.keys():
            _fail(source, "policy.cost", "input, cache_read and cache_write rates are required")
        if data["bytes_per_token_lower"] > data["bytes_per_token_upper"]:
            _fail(source, "policy.cost", "bytes_per_token_lower must not exceed bytes_per_token_upper")


_STRENGTHS = {"off", "conservative", "balanced", "aggressive"}
_RANGES = {
    "folding.threshold_tokens": (1, math.inf, True),
    "folding.keep_recent_messages": (0, math.inf, True),
    "folding.head_chars": (0, 1000, True),
    "folding.max_session_bytes": (1, 67108864, True),
    "folding.minimum_saving_usd": (0, math.inf, False),
    "gc.idle_seconds": (0, 315576000, False),
    "gc.max_uses": (0, 1_000_000_000, True),
    "gc.retention_seconds": (0, 315576000, False),
    "magpie.gateway_timeout_ms": (100, 10000, True),
}


def _apply(base: dict, layer: dict) -> None:
    layer = deepcopy(layer)
    layer.pop("version", None)
    _merge(base, layer)


def load_config(project_dir: str | os.PathLike[str] | None = None,
                overrides: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Merge defaults < global < nearest project < explicit overrides.

    Every present source is validated before merging. Strength and numeric GC
    fields merge independently, like all other settings.
    Optional accounting settings are omitted unless configured, and require a
    URL after merging. Source-path discovery is available through separate helpers.
    """
    result = {}
    accounting_source: str | Path = "<overrides>"
    policy_source: str | Path = "<overrides>"
    explicit_policy_minimum = False

    def apply_layer(data: dict, source: str | Path) -> None:
        nonlocal accounting_source, policy_source, explicit_policy_minimum
        _validate(data, source)
        _apply(result, data)
        if "accounting" in data.get("magpie", {}):
            accounting_source = source
        if "policy" in data:
            policy_source = source
            explicit_policy_minimum |= "minimum_saving_usd" in data["policy"]

    global_path = global_config_path()
    # Read the global source before discovery so its errors are never hidden.
    global_data = _read(global_path)
    if global_data is not None:
        apply_layer(global_data, global_path)
    project_path = project_config_path(project_dir)
    if project_path is not None:
        project_data = _read(project_path)
        if project_data is not None:
            apply_layer(project_data, project_path)
    if overrides is not None:
        apply_layer(overrides, "<overrides>")
    explicit = result
    selected = explicit.get("folding", {}).get("mode", "intelligence")
    threshold, recent, head, roles, minimum, summary = _MODES["intelligence" if selected == "agentic" else selected]
    result = deepcopy(DEFAULTS)
    result["folding"].update(mode=selected, threshold_tokens=threshold, keep_recent_messages=recent, head_chars=head)
    result["policy"].update(auto_roles=deepcopy(roles), min_chars=minimum, summary_chars=summary)
    _merge(result, explicit)
    explicit_policy = explicit.get("policy", {})
    if "mode" not in explicit_policy and (result["magpie"].get("accounting") or explicit_policy.get("cost")
                                          or explicit_policy.get("certificate_script")):
        result["policy"]["mode"] = "cost"
    accounting = result["magpie"].get("accounting")
    if accounting is not None:
        if "url" not in accounting:
            _fail(accounting_source, "magpie.accounting.url", "required when accounting is configured")
        accounting.setdefault("timeout_ms", 500)
    policy = result["policy"]
    if not explicit_policy_minimum:
        policy["minimum_saving_usd"] = result["folding"]["minimum_saving_usd"]
    if "cost" in policy:
        for key, value in _COST_DEFAULTS.items():
            policy["cost"].setdefault(key, value)
    for name in ("script", "certificate_script"):
        if name in policy:
            for key, value in _SCRIPT_DEFAULTS.items():
                policy[name].setdefault(key, value)
    _validate_policy(policy, policy_source, complete=True)
    return result
