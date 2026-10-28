#!/bin/bash
set -euo pipefail
task_app="${APP_DIR:-/app}"
cat > "$task_app/ledger.py" <<'PY'
import json
import re
import sys
from pathlib import Path


def reconcile(text):
    seen = set()
    balances = {}
    accepted = duplicates = pending = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if not isinstance(event, dict):
            raise ValueError("record must be an object")
        for key in ("id", "account"):
            if not isinstance(event.get(key), str) or not event[key]:
                raise ValueError(f"invalid {key}")
        amount = event.get("amount")
        if not isinstance(amount, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", amount):
            raise ValueError("invalid amount")
        if event.get("kind") not in ("credit", "debit"):
            raise ValueError("invalid kind")
        if event.get("status") not in ("posted", "pending"):
            raise ValueError("invalid status")
        if event["id"] in seen:
            duplicates += 1
            continue
        seen.add(event["id"])
        if event["status"] == "pending":
            pending += 1
            continue
        whole, _, fraction = amount.partition(".")
        cents = int(whole) * 100 + int(fraction.ljust(2, "0"))
        if event["kind"] == "debit":
            cents = -cents
        account = event["account"]
        balances[account] = balances.get(account, 0) + cents
        accepted += 1
    return {
        "balances": [{"account": name, "balance_cents": balances[name]} for name in sorted(balances)],
        "accepted_events": accepted,
        "duplicate_events": duplicates,
        "ignored_pending_events": pending,
    }


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: ledger.py INPUT OUTPUT")
    result = reconcile(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
PY
python3 "$task_app/ledger.py" "$task_app/data/events.jsonl" "$task_app/output/report.json"
