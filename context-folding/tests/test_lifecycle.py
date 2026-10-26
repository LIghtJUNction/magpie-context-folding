import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from context_folding.lifecycle import dispatch_lifecycle, maintain_lifecycle


NOW = 100 * 86400


def entry(key, **fields):
    result = dict(id=key, text="private archive " + key, role="tool", createdAt=0,
                  lastUsedAt=0, reads=0, folds=0, mark={"disposition": "unmarked"})
    result.update(fields)
    return result


def snapshot(*entries, groups=None, roots=None):
    return dict(entries=list(entries), groups=groups or [], roots=roots or [], config={})


def dispatch(state, action="gc", **request):
    return dispatch_lifecycle(state, dict(action=action, **request), now=NOW)


class LifecycleTests(unittest.TestCase):
    def test_collect_reachability_versions_and_unreachable_cycles(self):
        state = snapshot(
            entry("live", version={"series": "s", "number": 2, "previousId": "old"}),
            entry("old"), entry("unused"), entry("cycle-leaf"),
            groups=[
                {"id": "root", "children": ["nested"], "enabled": True},
                {"id": "nested", "children": ["live", "root"], "enabled": True},
                {"id": "cycle-a", "createdAt": 0, "children": ["cycle-b", "cycle-leaf"]},
                {"id": "cycle-b", "createdAt": 0, "children": ["cycle-a"]},
            ], roots=["root"],
        )
        result = dispatch(state, mode="collect")
        self.assertEqual(result["trashed"], ["cycle-a", "cycle-b", "cycle-leaf", "unused"])
        self.assertEqual(dispatch(state, mode="status")["protected"], ["live", "nested", "old", "root"])

    def test_implicit_roots_and_enabled_group_is_collectable(self):
        state = snapshot(entry("pin", pinned=True), entry("keep", mark={"disposition": "keep"}),
                         entry("fold", folded="reference"), entry("manual", manual=True),
                         entry("child"), groups=[
                             {"id": "fold-group", "folded": "reference", "children": ["child"]},
                             {"id": "unused-group", "createdAt": 0, "enabled": True, "children": []},
                         ])
        self.assertEqual(dispatch(state, mode="collect")["trashed"], ["manual", "unused-group"])

    def test_age_uses_and_unknown_age(self):
        unknown = entry("unknown")
        del unknown["createdAt"]
        del unknown["lastUsedAt"]
        state = snapshot(entry("cold"), entry("recent", lastUsedAt=NOW - 1),
                         entry("busy", reads=2, folds=1), entry("edge", reads=2), unknown)
        self.assertEqual(dispatch(state, mode="collect")["trashed"], ["cold", "edge"])
        self.assertEqual(state["entries"][0]["text"], "private archive cold")
        self.assertEqual(state["entries"][0]["trashedAt"], NOW)

    def test_config_presets_overrides_and_off(self):
        state = snapshot(entry("x"))
        self.assertEqual(dispatch(state, mode="status")["config"]["strength"], "conservative")
        result = dispatch(state, mode="configure", config={"strength": "balanced", "idleSeconds": 10,
                                                          "autoPurge": True})
        self.assertEqual(result["config"]["maxUses"], 5)
        self.assertEqual(result["config"]["idleSeconds"], 10)
        result = dispatch(state, mode="configure", config={"strength": "aggressive"})
        self.assertEqual(result["config"]["idleSeconds"], 86400)
        self.assertTrue(result["config"]["autoPurge"])
        dispatch(state, mode="configure", config={"strength": "off"})
        self.assertEqual(dispatch(state, mode="collect"), {"trashed": [], "restored": [], "purged": []})
        self.assertEqual(dispatch(state, mode="trash", ids=["x"])["trashed"], ["x"])

    def test_invalid_configuration_does_not_mutate(self):
        values = [{"strength": "invalid"}, {"idleSeconds": -1}, {"maxUses": True},
                  {"retentionSeconds": float("inf")}, {"autoPurge": 1}, {"unknown": 1}, [], False, None]
        for config in values:
            with self.subTest(config=config):
                state = snapshot(entry("x"))
                before = copy.deepcopy(state)
                with self.assertRaisesRegex(ValueError, "^Invalid lifecycle configuration$"):
                    dispatch(state, mode="configure", config=config)
                self.assertEqual(state, before)

    def test_explicit_trash_preserves_text_and_live_items(self):
        state = snapshot(entry("live"), entry("other"), roots=["live"])
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, "Cannot trash live"):
            dispatch(state, mode="trash", ids=["other", "live"])
        self.assertEqual(state, before)
        dispatch(state, mode="trash", ids=["other"])
        self.assertEqual(dispatch(state, mode="restore", ids=["other"])["restored"], ["other"])
        self.assertEqual(state, before)

    def test_roots_exact_replacement_and_pin_restore_dependencies(self):
        state = snapshot(entry("a", trashedAt=1, version={"previousId": "b"}),
                         entry("b", trashedAt=1), entry("c"), roots=["c"])
        result = dispatch(state, action="roots", ids=["a", "a"])
        self.assertEqual(result, {"roots": ["a"], "restored": ["a", "b"]})
        self.assertEqual(dispatch(state, mode="collect")["trashed"], ["c"])
        self.assertEqual(dispatch(state, action="pin", id="c", pinned=True)["restored"], ["c"])
        dispatch(state, action="roots", ids=[])
        self.assertEqual(dispatch(state, mode="status")["protected"], ["c"])
        dispatch(state, action="pin", id="c", pinned=False)
        self.assertEqual(dispatch(state, mode="status")["protected"], [])

    def test_restore_group_restores_transitive_cycle(self):
        state = snapshot(entry("leaf", trashedAt=1), groups=[
            {"id": "a", "children": ["b"], "trashedAt": 1},
            {"id": "b", "children": ["a", "leaf"], "trashedAt": 1},
        ])
        self.assertEqual(dispatch(state, mode="restore", ids=["a"])["restored"], ["a", "b", "leaf"])

    def test_retained_recent_records_protect_cold_dependencies(self):
        state = snapshot(entry("old"), entry("new", lastUsedAt=NOW, version={"previousId": "old"}),
                         entry("child"), groups=[{"id": "group", "createdAt": NOW, "children": ["child"]}])
        self.assertEqual(dispatch(state, mode="collect")["trashed"], [])
        for ids in (["old"], ["child"]):
            with self.assertRaisesRegex(ValueError, "Cannot trash referenced"):
                dispatch(state, mode="trash", ids=ids)
        self.assertEqual(dispatch(state, mode="trash", ids=["old", "new"])["trashed"], ["new", "old"])

    def test_purge_retained_refs_and_whole_cycles(self):
        state = snapshot(entry("old", trashedAt=1),
                         entry("new", trashedAt=1, version={"previousId": "old"}))
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, "Cannot purge referenced"):
            dispatch(state, mode="purge", ids=["old"])
        self.assertEqual(state, before)
        self.assertEqual(dispatch(state, mode="purge")["purged"], ["new", "old"])
        state = snapshot(groups=[{"id": "a", "children": ["b"], "trashedAt": 1},
                                 {"id": "b", "children": ["a"], "trashedAt": 1}])
        self.assertEqual(dispatch(state, mode="purge")["purged"], ["a", "b"])

    def test_purge_refuses_live_trash_and_active_records(self):
        for item, roots in [(entry("x"), []), (entry("x", trashedAt=1), ["x"])]:
            state = snapshot(item, roots=roots)
            before = copy.deepcopy(state)
            with self.assertRaisesRegex(ValueError, "Cannot purge active"):
                dispatch(state, mode="purge", ids=["x"])
            self.assertEqual(state, before)

    def test_expiry_retains_dependencies_of_young_trash(self):
        state = snapshot(entry("old", trashedAt=1),
                         entry("young", trashedAt=NOW - 1, version={"previousId": "old"}),
                         entry("expired", trashedAt=1), entry("cold"))
        dispatch(state, mode="configure", config={"autoPurge": True, "retentionSeconds": 60})
        result = dispatch(state, mode="collect")
        self.assertEqual(result["purged"], ["expired"])
        self.assertEqual(result["trashed"], ["cold"])
        result = dispatch_lifecycle(state, {"action": "gc", "mode": "collect"}, now=NOW + 61)
        self.assertEqual(result["purged"], ["cold", "old", "young"])

    def test_maintenance_opt_in_and_live_dependency_repair(self):
        state = snapshot(entry("live", version={"previousId": "old"}),
                         entry("old", trashedAt=1), entry("cold"), roots=["live"])
        self.assertEqual(maintain_lifecycle(state, NOW),
                         {"restored": ["old"], "trashed": [], "purged": []})
        dispatch(state, mode="configure", config={"strength": "balanced"})
        self.assertEqual(maintain_lifecycle(state, NOW)["trashed"], ["cold"])
        dispatch(state, mode="restore", ids=["cold"])
        self.assertEqual(maintain_lifecycle(state, NOW, collect=False)["trashed"], [])
        self.assertNotIn("trashedAt", state["entries"][2])
        state["entries"][1]["trashedAt"] = 1
        dispatch(state, mode="configure", config={"strength": "off"})
        self.assertEqual(maintain_lifecycle(state, NOW)["restored"], ["old"])

    def test_zero_retention_expiry_and_fresh_records(self):
        state = snapshot(entry("old"), entry("fresh", createdAt=NOW, lastUsedAt=NOW))
        dispatch(state, mode="configure", config={"strength": "aggressive", "retentionSeconds": 0,
                                                  "autoPurge": True})
        result = dispatch(state, mode="collect")
        self.assertEqual(result["purged"], ["old"])
        self.assertEqual([item["id"] for item in state["entries"]], ["fresh"])

    def test_candidates_are_deterministic_and_exclude_original_content(self):
        state = snapshot(entry("z", reads=3), entry("a", folds=3), entry("b", reads=3),
                         entry("low", reads=2, folds=2), entry("trash", folds=10, trashedAt=1))
        before = copy.deepcopy(state)
        result = dispatch(state, action="skills", mode="candidates")
        self.assertEqual([item["id"] for item in result["candidates"]], ["a", "b", "z"])
        self.assertNotIn("private archive", json.dumps(result))
        self.assertEqual(state, before)

    def test_export_explicit_body_and_source_evidence(self):
        item = entry("source", text="DO NOT COPY THIS AS INSTRUCTIONS", reads=3,
                     source={"path": "evidence.txt", "range": "full"}, version={"series": "s", "number": 1})
        state = snapshot(item)
        before = copy.deepcopy(state)
        with tempfile.TemporaryDirectory() as temporary:
            path = str(Path(temporary) / "skill")
            result = dispatch(state, action="skills", mode="export", id="source", path=path,
                              name="review-evidence", description="Review evidence carefully.",
                              body="# Procedure\nExplicitly authored instructions.")
            self.assertEqual(result["path"], path + "/SKILL.md")
            content = Path(result["path"]).read_text()
            self.assertIn("Explicitly authored instructions.", content)
            self.assertNotIn(item["text"], content)
            self.assertEqual(list(Path(path).iterdir()), [Path(path) / "SKILL.md"])
            metadata = json.loads(next(line for line in content.splitlines() if line.startswith("source_manifest: "))[17:])
            self.assertEqual(metadata["sha256"], hashlib.sha256(item["text"].encode()).hexdigest())
            self.assertEqual(metadata["source"], item["source"])
            self.assertEqual(metadata["version"], item["version"])
            with self.assertRaisesRegex(ValueError, "^Skill export failed$"):
                dispatch(state, action="skills", mode="export", id="source", path=path,
                         name="new-name", description="changed", body="changed")
            self.assertEqual(Path(result["path"]).read_text(), content)
        self.assertEqual(state, before)

    def test_group_candidates_and_explicit_group_export(self):
        state = snapshot(entry("child"), groups=[
            {"id": "group", "children": ["child"], "summary": "private group evidence", "folds": 3},
        ])
        candidates = dispatch(state, action="skills", mode="candidates")["candidates"]
        self.assertEqual([item["id"] for item in candidates], ["group"])
        self.assertNotIn("private", json.dumps(candidates))
        with tempfile.TemporaryDirectory() as temporary:
            result = dispatch(state, action="skills", mode="export", id="group", path=temporary + "/group",
                              name="group-procedure", description="Explicit group skill", body="Use evidence.")
            self.assertEqual(result["sourceManifest"]["kind"], "group")
            self.assertEqual(result["sourceManifest"]["children"], ["child"])
            self.assertNotIn("private group evidence", Path(result["path"]).read_text())

    def test_export_validation_and_no_overwrite_or_symlink(self):
        state = snapshot(entry("x"))
        with tempfile.TemporaryDirectory() as temporary:
            base = dict(action="skills", mode="export", id="x", path=temporary + "/new",
                        name="safe-name", description="Explicit description", body="Explicit body")
            for fields in ({"name": "../bad"}, {"name": "Upper"}, {"path": "relative"},
                           {"path": temporary + "/../bad"}, {"body": ""}, {"body": None},
                           {"description": ""}, {"path": temporary + "/secret\x00value"}):
                with self.subTest(fields=fields), self.assertRaises(ValueError):
                    dispatch_lifecycle(state, dict(base, **fields), now=NOW)
            self.assertFalse(Path(base["path"]).exists())
            Path(temporary, "link").symlink_to(temporary, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "^Skill export failed$"):
                dispatch_lifecycle(state, dict(base, path=temporary + "/link/new"), now=NOW)
            self.assertFalse(Path(base["path"]).exists())
            with self.assertRaisesRegex(ValueError, "^Skill export failed$"):
                dispatch_lifecycle(state, dict(base, path=temporary), now=NOW)

    def test_invalid_ids_and_malformed_graph_are_atomic_and_safe(self):
        for request in ({"action": "roots", "ids": ["unknown-private-secret"]},
                        {"action": "pin", "id": [], "pinned": True},
                        {"action": "gc", "mode": "trash"},
                        {"action": "gc", "mode": "collect", "ids": []},
                        {"action": "gc", "mode": "restore", "ids": "x"}):
            state = snapshot(entry("x"))
            before = copy.deepcopy(state)
            with self.subTest(request=request), self.assertRaises(ValueError) as raised:
                dispatch_lifecycle(state, request, now=NOW)
            self.assertNotIn("secret", str(raised.exception))
            self.assertEqual(state, before)
        for state in (snapshot(entry("x", version={"previousId": "missing"})),
                      snapshot(entry("x"), entry("x")), snapshot(entry("x", createdAt=-1)),
                      snapshot(entry("x", reads=True)), snapshot(entry("x", lastUsedAt=10 ** 1000))):
            with self.assertRaisesRegex(ValueError, "^Invalid lifecycle snapshot$"):
                dispatch(state, mode="collect")


if __name__ == "__main__":
    unittest.main()
