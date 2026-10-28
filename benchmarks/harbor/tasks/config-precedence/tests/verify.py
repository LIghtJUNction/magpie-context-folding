"""Independent expected-output cases for layered configuration."""

import sys

from runner import main


def run_checks(checks):
    public = {"profile": "staging", "config": {
        "service": {"host": "stage.internal", "port": 9090, "tls": True, "paths": ["blue", "green"]},
        "logging": {"level": "warn"}, "feature": 0,
    }}
    checks.check("public_effective_config", lambda: checks.artifact("output/effective.json", public))

    def case(name, base, overlay, overrides, expected):
        files = {"base.json": base, "profiles.json": {"chosen": overlay}, "overrides.json": overrides}
        wanted = {"profile": "chosen", "config": expected}
        checks.check(name, lambda: checks.execute("resolve_config.py", ["@base.json", "@profiles.json", "chosen", "@overrides.json"], files, wanted))

    case("empty", {}, {}, {}, {})
    case("recursive_merge_and_deletion", {"a": {"x": 1, "y": 2}, "b": 3}, {"a": {"x": None, "z": 4}, "b": None}, {}, {"a": {"y": 2, "z": 4}})
    case("lists_replace_and_falsy_values_survive", {"a": [1, 2], "b": True, "c": 7, "d": "old"}, {"a": [None, 3], "b": False, "c": 0, "d": ""}, {}, {"a": [None, 3], "b": False, "c": 0, "d": ""})
    case("object_overlay_on_scalar", {"a": 4, "b": {"c": 1}}, {"a": {"missing": None, "present": 8}, "b": {"c": None}}, {}, {"a": {"present": 8}, "b": {}})
    case("dotted_parent_replacement", {"a": 1, "b": [3]}, {}, {"a.x": 2, "b.y.z": False}, {"a": {"x": 2}, "b": {"y": {"z": False}}})
    case("deletion_does_not_create_parents", {"a": 1, "b": {"c": 2}}, {}, {"a.x": None, "missing.child": None, "b.c": None}, {"a": 1, "b": {}})
    case("override_insertion_order", {}, {}, {"a.b": 1, "a": 2, "a.c": 3, "a.d": 0}, {"a": {"c": 3, "d": 0}})
    case("object_override_replaces_leaf", {"a": {"keep": 1, "old": 2}}, {}, {"a": {"new": None, "list": [None]}}, {"a": {"new": None, "list": [None]}})
    case("unicode_keys_and_deep_path", {"地域": {"名": "旧"}}, {"地域": {"名": "新"}}, {"地域.設定.値": "ok"}, {"地域": {"名": "新", "設定": {"値": "ok"}}})

    invalid_cases = [
        ("unknown_profile", {}, {"other": {}}, {}, "chosen"),
        ("non_object_profile", {}, {"chosen": []}, {}, "chosen"),
        ("non_object_base", [], {"chosen": {}}, {}, "chosen"),
        ("non_object_profiles", {}, [], {}, "chosen"),
        ("non_object_overrides", {}, {"chosen": {}}, [], "chosen"),
        ("empty_dotted_key", {}, {"chosen": {}}, {"": 1}, "chosen"),
        ("empty_dotted_segment", {}, {"chosen": {}}, {"a..b": 1}, "chosen"),
        ("leading_dot", {}, {"chosen": {}}, {".a": 1}, "chosen"),
        ("trailing_dot", {}, {"chosen": {}}, {"a.": None}, "chosen"),
    ]
    for name, base, profiles, overrides, profile in invalid_cases:
        files = {"base.json": base, "profiles.json": profiles, "overrides.json": overrides}
        arguments = ["@base.json", "@profiles.json", profile, "@overrides.json"]
        checks.check(name, lambda files=files, arguments=arguments: checks.execute("resolve_config.py", arguments, files, invalid=True))
    malformed = {"base.json": "{broken", "profiles.json": {"chosen": {}}, "overrides.json": {}}
    checks.check("malformed_json", lambda: checks.execute("resolve_config.py", ["@base.json", "@profiles.json", "chosen", "@overrides.json"], malformed, invalid=True))


if __name__ == "__main__":
    sys.exit(main(run_checks))
