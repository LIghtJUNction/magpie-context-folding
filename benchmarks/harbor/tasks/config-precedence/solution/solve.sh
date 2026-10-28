#!/bin/bash
set -euo pipefail
task_app="${APP_DIR:-/app}"
cat > "$task_app/resolve_config.py" <<'PY'
import copy
import json
import sys
from pathlib import Path


def overlay(base, patch):
    result = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict):
            result[key] = overlay(result.get(key), value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def resolve(base, profiles, profile, overrides):
    if not all(isinstance(value, dict) for value in (base, profiles, overrides)):
        raise ValueError("input documents must be objects")
    if profile not in profiles or not isinstance(profiles[profile], dict):
        raise ValueError("unknown or invalid profile")
    result = overlay(base, profiles[profile])
    for dotted, value in overrides.items():
        path = dotted.split(".")
        if not all(path):
            raise ValueError("invalid dotted path")
        cursor = result
        for key in path[:-1]:
            if not isinstance(cursor.get(key), dict):
                if value is None:
                    cursor = None
                    break
                cursor[key] = {}
            cursor = cursor[key]
        if cursor is not None:
            if value is None:
                cursor.pop(path[-1], None)
            else:
                cursor[path[-1]] = copy.deepcopy(value)
    return {"profile": profile, "config": result}


def main():
    if len(sys.argv) != 6:
        raise ValueError("usage: resolve_config.py BASE PROFILES PROFILE OVERRIDES OUTPUT")
    base = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    profiles = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    overrides = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
    result = resolve(base, profiles, sys.argv[3], overrides)
    output = Path(sys.argv[5])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
PY
python3 "$task_app/resolve_config.py" "$task_app/data/base.json" "$task_app/data/profiles.json" staging "$task_app/data/overrides.json" "$task_app/output/effective.json"
