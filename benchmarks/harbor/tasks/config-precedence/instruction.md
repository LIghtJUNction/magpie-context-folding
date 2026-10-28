# Repair the configuration resolver

Implement `/app/resolve_config.py` according to
`/app/docs/config_rules.md`. Its command is:

```bash
python /app/resolve_config.py BASE_JSON PROFILES_JSON PROFILE OVERRIDES_JSON OUTPUT_JSON
```

Inspect the rules and files under `/app/data`, implement the resolver, and create
`/app/output/effective.json` using `base.json`, `profiles.json`, the `staging`
profile, and `overrides.json`. Check additional cases for null deletion, false/zero
values, and conflicts between a scalar and a dotted override.

The verifier checks the generated file and runs independent functional cases.
Keep the complete implementation in the single `resolve_config.py` file, use
only Python's standard library, and do not change the inputs or documentation.

This synthetic task checks benchmark integration. It does not require context
folding and is not a published leaderboard benchmark.
