# Repair the ledger reconciler

Implement `/app/ledger.py` using the rules in `/app/docs/ledger_rules.md`.
The command is `python /app/ledger.py INPUT_JSONL OUTPUT_JSON`.

Read the rules and sample data, replace the starter implementation, and run it on
`/app/data/events.jsonl` to create `/app/output/report.json`. Check your work with
additional inputs covering duplicate IDs, pending events, and exact cents.

The verifier checks the generated report and runs your program on independent
inputs. Your complete implementation must be in the single `ledger.py` file and
use only Python's standard library. Do not modify the sample inputs or rules.

This is a small synthetic integration task. Context folding is optional; an
ordinary terminal agent can solve the same task.
