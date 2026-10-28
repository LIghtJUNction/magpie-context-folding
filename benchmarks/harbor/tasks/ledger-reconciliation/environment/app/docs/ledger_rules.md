# Ledger contract, version 1

Each nonblank input line is one JSON object with these required fields:

| Field | Valid values |
| --- | --- |
| `id` | Nonempty string; event IDs are global across accounts |
| `account` | Nonempty string |
| `kind` | `credit` or `debit` |
| `amount` | String of digits, optionally followed by a decimal point and one or two digits |
| `status` | `posted` or `pending` |

Extra fields are ignored. Blank lines are ignored. An empty file is valid.
Validate every nonblank record before deduplication. A negative amount, number
instead of a string, more than two fractional digits, unsupported enum, malformed
JSON, or missing/invalid required field is invalid. On invalid input, exit
nonzero and do not create the output file.

Process valid records in file order:

1. The first occurrence of each `id` wins, even when it is pending. Every later
   occurrence is a duplicate and has no effect, even if its other fields differ.
2. A first-occurrence pending event is counted but has no balance effect.
3. A first-occurrence posted credit adds exact integer cents; a debit subtracts
   exact integer cents. Do not use floating-point arithmetic. Amounts may exceed
   the exact-integer range of a floating-point number.
4. Include every account with at least one accepted posted event, even if its
   final balance is zero. Sort accounts by their string value.

Write a JSON object with exactly these keys:

```json
{
  "balances": [{"account": "example", "balance_cents": 123}],
  "accepted_events": 1,
  "duplicate_events": 0,
  "ignored_pending_events": 0
}
```

Counts and balances are integers. `accepted_events` counts unique posted events.
Create the output parent directory if needed. JSON whitespace and object key
order do not matter. The command must not modify its input file.
