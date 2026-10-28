"""Independent expected-output cases for the ledger task."""

import json
import random
import sys

from runner import main


def event(identifier, account, cents, kind="credit", status="posted"):
    return {"id": identifier, "account": account, "amount": f"{cents // 100}.{cents % 100:02d}", "kind": kind, "status": status}


def report(balances, accepted, duplicates=0, pending=0):
    return {
        "balances": [{"account": key, "balance_cents": value} for key, value in sorted(balances.items())],
        "accepted_events": accepted,
        "duplicate_events": duplicates,
        "ignored_pending_events": pending,
    }


def run_checks(checks):
    checks.check("public_report", lambda: checks.artifact("output/report.json", report({"alpha": 670, "beta": 510, "gamma": 0}, 6, 2, 1)))

    def valid(name, records, expected):
        text = "\n\n" + "\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n\n"
        checks.check(name, lambda: checks.execute("ledger.py", ["@events.jsonl"], {"events.jsonl": text}, expected))

    valid("empty_input", [], report({}, 0))
    valid("global_first_occurrence_and_pending", [
        event("reserved", "unused", 999, status="pending"),
        event("reserved", "later", 200),
        event("paid", "first", 300),
        event("paid", "different", 900, kind="debit"),
    ], report({"first": 300}, 1, 2, 1))
    valid("large_exact_cents_and_zero_account", [
        event("large", "large", 900719925474099301),
        event("tiny", "large", 1, kind="debit"),
        event("zero", "zero", 0),
        event("debt", "debt", 17, kind="debit"),
    ], report({"large": 900719925474099300, "zero": 0, "debt": -17}, 4))
    valid("integer_and_one_decimal_amounts", [
        {**event("integer", "世界", 0), "amount": "0012"},
        {**event("fraction", "世界", 0, kind="debit"), "amount": "1.2"},
    ], report({"世界": 1080}, 2))

    # Build expected sums while constructing distinct IDs, then append known
    # duplicates. This does not call or copy the submitted/oracle reconciler.
    rng = random.Random(7341)
    records, balances = [], {}
    pending = accepted = 0
    for index in range(36):
        account = rng.choice(["A", "b", "β", "空"])
        cents = rng.randrange(0, 1_000_000)
        kind = rng.choice(["credit", "debit"])
        status = "pending" if index % 7 == 0 else "posted"
        records.append(event(f"generated-{index}", account, cents, kind, status))
        if status == "pending":
            pending += 1
        else:
            accepted += 1
            balances[account] = balances.get(account, 0) + (cents if kind == "credit" else -cents)
    records.extend({**records[index], "account": "ignored", "amount": "777.77"} for index in (0, 1, 7, 15))
    valid("unseen_seeded_ledger", records, report(balances, accepted, 4, pending))

    for label, bad in [
        ("fractional_cent", {**event("bad", "x", 0), "amount": "1.001"}),
        ("negative_amount", {**event("bad", "x", 0), "amount": "-1"}),
        ("numeric_amount", {**event("bad", "x", 0), "amount": 1}),
        ("unknown_kind", {**event("bad", "x", 0), "kind": "refund"}),
        ("unknown_status", {**event("bad", "x", 0), "status": "other"}),
        ("empty_id", {**event("bad", "x", 0), "id": ""}),
        ("non_object", []),
    ]:
        payload = json.dumps(bad) + "\n"
        checks.check(label, lambda payload=payload: checks.execute("ledger.py", ["@events.jsonl"], {"events.jsonl": payload}, invalid=True))
    payload = json.dumps(event("same", "x", 100)) + "\n" + json.dumps({**event("same", "x", 0), "amount": "1.001"})
    checks.check("validate_before_deduplication", lambda: checks.execute("ledger.py", ["@events.jsonl"], {"events.jsonl": payload}, invalid=True))
    checks.check("malformed_json", lambda: checks.execute("ledger.py", ["@events.jsonl"], {"events.jsonl": "{broken\n"}, invalid=True))


if __name__ == "__main__":
    sys.exit(main(run_checks))
