import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from context_folding.config import (
    ConfigError,
    MAX_CONFIG_BYTES,
    global_config_path,
    load_config,
    project_config_path,
)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.xdg = self.root / "xdg"
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / ".git").mkdir()
        self.env = patch.dict(os.environ, {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.xdg)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.global_path = self.xdg / "context-folding" / "config.toml"
        self.project_path = self.project / ".context-folding.toml"

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def load(self, overrides=None):
        return load_config(self.project, overrides)

    def test_missing_sources_return_independent_defaults_without_writing(self):
        settings = self.load()
        self.assertEqual(set(settings), {"folding", "annotations", "gc", "magpie", "policy"})
        self.assertEqual(settings["policy"], {"mode": "cost", "auto_roles": [],
                                             "min_chars": 4096, "minimum_saving_usd": 0.000001})
        self.assertEqual(settings["folding"], {
            "enabled": True, "threshold_tokens": 32000, "keep_recent_messages": 4,
            "head_chars": 160, "max_session_bytes": 67108864,
            "minimum_saving_usd": 0.000001,
        })
        self.assertEqual(settings["annotations"], {"enabled": True, "default_fold": True, "keep": []})
        self.assertEqual(settings["gc"], {
            "enabled": False, "strength": "conservative", "idle_seconds": 2592000,
            "max_uses": 2, "retention_seconds": 2592000, "auto_purge": False,
        })
        self.assertEqual(settings["magpie"], {})
        settings["annotations"]["keep"].append("changed")
        self.assertEqual(self.load()["annotations"]["keep"], [])
        self.assertFalse(self.global_path.exists())
        self.assertFalse(self.project_path.exists())
        self.assertFalse(self.xdg.exists())

    def test_model_capacity_cannot_be_set_by_shared_configuration(self):
        self.assertNotIn("context_window_tokens", self.load()["folding"])
        with self.assertRaises(ConfigError):
            self.load({"folding": {"context_window_tokens": 128000}})
        self.write(self.global_path, "[folding]\ncontext_window_tokens=128000\n")
        with self.assertRaises(ConfigError):
            self.load()
        self.global_path.unlink()
        self.write(self.project_path, "[folding]\ncontext_window_tokens=1\n")
        with self.assertRaises(ConfigError):
            self.load()

    def test_global_location_and_home_fallback(self):
        self.assertEqual(global_config_path(), self.global_path)
        fallback = self.home / ".config" / "context-folding" / "config.toml"
        self.write(fallback, "[folding]\nhead_chars=20\n")
        for xdg in (None, ""):
            with self.subTest(xdg=xdg), patch.dict(os.environ):
                if xdg is None:
                    os.environ.pop("XDG_CONFIG_HOME", None)
                else:
                    os.environ["XDG_CONFIG_HOME"] = xdg
                self.assertEqual(global_config_path(), fallback)
                self.assertEqual(self.load()["folding"]["head_chars"], 20)

    def test_precedence_deep_merge_and_inputs_are_not_mutated(self):
        self.write(self.global_path, 'version=1\n[folding]\nhead_chars=10\nthreshold_tokens=100\n'
                   '[magpie.accounting]\nurl="https://example.test/cost"\ntimeout_ms=700\n')
        self.write(self.project_path, '[folding]\nhead_chars=20\n'
                   '[magpie.accounting]\ntimeout_ms=800\n')
        overrides = {"folding": {"head_chars": 30}, "annotations": {"keep": ["*.keep"]},
                     "magpie": {"accounting": {"timeout_ms": 900}}}
        before = copy.deepcopy(overrides)
        settings = self.load(overrides)
        self.assertEqual(settings["folding"]["head_chars"], 30)
        self.assertEqual(settings["folding"]["threshold_tokens"], 100)
        self.assertEqual(settings["magpie"]["accounting"], {
            "url": "https://example.test/cost", "timeout_ms": 900,
        })
        settings["annotations"]["keep"].append("other")
        self.assertEqual(overrides, before)
        self.assertNotIn("version", settings)

    def test_only_nearest_project_file_is_loaded(self):
        self.write(self.project_path, "[folding]\nhead_chars=20\nthreshold_tokens=100\n")
        child = self.project / "nested"
        child.mkdir()
        nearest = self.write(child / ".context-folding.toml", "[folding]\nhead_chars=30\n")
        grandchild = child / "deep"
        grandchild.mkdir()
        self.assertEqual(project_config_path(grandchild), nearest)
        settings = load_config(grandchild)
        self.assertEqual(settings["folding"]["head_chars"], 30)
        self.assertEqual(settings["folding"]["threshold_tokens"], 32000)

    def test_git_root_checked_but_never_its_parent_for_git_directory_or_file(self):
        self.write(self.root / ".context-folding.toml", "[folding]\nhead_chars=999\n")
        child = self.project / "nested"
        child.mkdir()
        for kind in ("directory", "file"):
            with self.subTest(kind=kind):
                marker = self.project / ".git"
                if kind == "file":
                    marker.rmdir()
                    marker.write_text("gitdir: /unused\n", encoding="utf-8")
                self.assertIsNone(project_config_path(child))
                self.assertEqual(load_config(child)["folding"]["head_chars"], 160)
                self.write(self.project_path, "[folding]\nhead_chars=20\n")
                self.assertEqual(load_config(child)["folding"]["head_chars"], 20)
                self.project_path.unlink()

    def test_cwd_is_default_start_directory(self):
        self.write(self.project_path, "[folding]\nenabled=false\n")
        with patch("context_folding.config.Path.cwd", return_value=self.project):
            self.assertFalse(load_config()["folding"]["enabled"])

    def test_without_git_root_searches_parents(self):
        (self.project / ".git").rmdir()
        self.write(self.root / ".context-folding.toml", "[folding]\nhead_chars=42\n")
        self.assertEqual(self.load()["folding"]["head_chars"], 42)

    def test_invalid_toml_utf8_and_version_include_source_path(self):
        for text in ("broken = [", "version=2", "version=true", 'version="1"', "version=1.0",
                     "version=" + "9" * 5000):
            with self.subTest(text=text):
                self.write(self.global_path, text)
                with self.assertRaises(ConfigError) as raised:
                    self.load()
                self.assertIn(str(self.global_path), str(raised.exception))
        self.global_path.write_bytes(b"\xff")
        with self.assertRaisesRegex(ConfigError, "TOML"):
            self.load()

    def test_unknown_sections_keys_and_table_types_include_source_path(self):
        for text, key in (
            ("unknown=1", "unknown"),
            ("[folding]\nunknown=1", "folding.unknown"),
            ("folding=false", "folding"),
            ("[magpie.accounting]\nsecret='no'", "magpie.accounting.secret"),
            ("[magpie]\naccounting='url'", "magpie.accounting"),
            ("[annotations]\nkeep=[1]", "annotations.keep"),
        ):
            with self.subTest(text=text):
                self.write(self.project_path, text)
                with self.assertRaises(ConfigError) as raised:
                    self.load()
                self.assertIn(str(self.project_path), str(raised.exception))
                self.assertIn(key, str(raised.exception))

    def test_invalid_global_not_hidden_by_valid_override(self):
        self.write(self.global_path, '[folding]\nhead_chars="invalid"\n')
        with self.assertRaisesRegex(ConfigError, "folding.head_chars"):
            self.load({"folding": {"head_chars": 30}})

    def test_override_validation_rejects_wrong_types_and_out_of_range_values(self):
        invalid = {
            "folding.enabled": [0, "true", None],
            "folding.threshold_tokens": [True, 0, -1, 1.0],
            "folding.keep_recent_messages": [False, -1, 2.5],
            "folding.head_chars": [-1, 1001, True, 10.0],
            "folding.max_session_bytes": [0, 67108865, False],
            "folding.minimum_saving_usd": [-0.1, True, float("inf"), float("nan")],
            "annotations.enabled": [1],
            "annotations.default_fold": ["false"],
            "annotations.keep": ["name", [1], [""], ["bad\x00name"]],
            "gc.enabled": [1],
            "gc.strength": ["invalid", 1, []],
            "gc.idle_seconds": [-1, 315576001, float("inf"), True],
            "gc.retention_seconds": [-1, 315576001, float("nan"), False],
            "gc.max_uses": [-1, 1000000001, 1.0, True],
            "gc.auto_purge": [0],
            "magpie.gateway_timeout_ms": [99, 10001, 500.0, True],
        }
        for name, values in invalid.items():
            section, key = name.split(".")
            for value in values:
                with self.subTest(name=name, value=value):
                    with self.assertRaises(ConfigError) as raised:
                        self.load({section: {key: value}})
                    self.assertIn("<overrides>", str(raised.exception))
                    self.assertIn(name, str(raised.exception))
        for value in (False, [], "bad", {"version": True}, {"folding": []}, {"unknown": {}}):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                self.load(value)

    def test_valid_boundaries(self):
        settings = self.load({
            "folding": {"threshold_tokens": 1, "keep_recent_messages": 0, "head_chars": 0,
                        "max_session_bytes": 1, "minimum_saving_usd": 0},
            "gc": {"idle_seconds": 0.5, "retention_seconds": 315576000, "max_uses": 1000000000},
            "magpie": {"gateway_timeout_ms": 100},
        })
        self.assertEqual(settings["gc"]["idle_seconds"], 0.5)
        self.assertEqual(self.load({"folding": {"head_chars": 1000}})["folding"]["head_chars"], 1000)
        self.assertEqual(self.load({"magpie": {"gateway_timeout_ms": 10000}})["magpie"]["gateway_timeout_ms"], 10000)

    def test_accounting_optional_defaults_and_partial_merge(self):
        self.assertNotIn("accounting", self.load()["magpie"])
        for url in ("http://localhost:8080/cost", "https://example.test/cost", "http://[::1]/"):
            with self.subTest(url=url):
                self.assertEqual(self.load({"magpie": {"accounting": {"url": url}}})["magpie"]["accounting"],
                                 {"url": url, "timeout_ms": 500})
        for timeout in (50, 10000):
            settings = self.load({"magpie": {"accounting": {"url": "https://example.test", "timeout_ms": timeout}}})
            self.assertEqual(settings["magpie"]["accounting"]["timeout_ms"], timeout)
        for value in (None, {}, {"timeout_ms": 500}, {"url": ""}, {"url": "ftp://example.test"},
                      {"url": "https:///path"}, {"url": "https://exa mple.test"}, {"url": 5},
                      {"url": "https://[broken"}, {"url": "https://example.test", "timeout_ms": True},
                      {"url": "https://example.test", "timeout_ms": 49},
                      {"url": "https://example.test", "timeout_ms": 10001}):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                self.load({"magpie": {"accounting": value}})
        self.write(self.project_path, "[magpie.accounting]\ntimeout_ms=500\n")
        with self.assertRaises(ConfigError) as raised:
            self.load()
        self.assertIn(str(self.project_path), str(raised.exception))

    def test_strength_and_numeric_gc_settings_merge_independently(self):
        self.write(self.global_path, "[gc]\nidle_seconds=123\n")
        self.write(self.project_path, "[gc]\nstrength='balanced'\nretention_seconds=9\n")
        settings = self.load()["gc"]
        self.assertEqual(settings["strength"], "balanced")
        self.assertEqual(settings["idle_seconds"], 123)
        self.assertEqual(settings["max_uses"], 2)
        self.assertEqual(settings["retention_seconds"], 9)
        settings = self.load({"gc": {"strength": "aggressive", "max_uses": 11}})["gc"]
        self.assertEqual(settings["strength"], "aggressive")
        self.assertEqual(settings["idle_seconds"], 123)
        self.assertEqual(settings["max_uses"], 11)
        self.assertEqual(settings["retention_seconds"], 9)
        self.assertFalse(settings["enabled"])
        self.assertEqual(self.load({"gc": {"strength": "off"}})["gc"]["idle_seconds"], 123)

    def test_policy_nested_merge_defaults_and_minimum_inheritance(self):
        self.write(self.global_path, '[folding]\nminimum_saving_usd=0.2\n'
                   '[policy]\nauto_roles=["assistant","tool"]\n'
                   '[policy.cost.input]\nlower=2\nupper=4\n'
                   '[policy.cost.cache_read]\nlower=0.1\nupper=0.2\n'
                   '[policy.cost.cache_write]\nlower=2\nupper=4\n'
                   '[policy.script]\ncommand=["/usr/bin/node","--secret=hidden-token"]\n')
        self.write(self.project_path, '[policy.cost.input]\nupper=5\n')
        policy = self.load({"policy": {"min_chars": 30, "cost": {"overhead_usd": 0.01}}})["policy"]
        self.assertEqual(policy["minimum_saving_usd"], 0.2)
        self.assertEqual(policy["cost"]["input"], {"lower": 2, "upper": 5})
        self.assertEqual(policy["cost"]["bytes_per_token_upper"], 8)
        self.assertEqual(policy["script"]["timeout_ms"], 1000)
        self.assertEqual(policy["min_chars"], 30)
        self.assertEqual(self.load({"folding": {"minimum_saving_usd": 0.4}})["policy"]["minimum_saving_usd"], 0.4)
        self.assertEqual(self.load({"policy": {"minimum_saving_usd": 0}})["policy"]["minimum_saving_usd"], 0)
        self.write(self.project_path, '[policy]\nminimum_saving_usd=0.3\n')
        self.assertEqual(self.load({"folding": {"minimum_saving_usd": 0.9}})["policy"]["minimum_saving_usd"], 0.3)

    def test_policy_validation_never_executes_commands_or_echoes_values(self):
        invalid = [
            {"mode": "hidden-token"}, {"auto_roles": ["tool", "tool"]},
            {"auto_roles": [{}]}, {"min_chars": True}, {"min_chars": 9007199254740992},
            {"minimum_saving_usd": float("nan")}, {"cost": {}},
            {"cost": {"input": {"lower": 2, "upper": 1}}},
            {"script": {}}, {"script": {"command": ["relative", "hidden-token"]}},
            {"script": {"command": ["/not/executed", "bad\x00argument"]}},
            {"certificate_script": {"command": ["/not/executed"], "timeout_ms": 0}},
            {"script": {"unknown": "hidden-token"}},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ConfigError) as raised:
                self.load({"policy": value})
            self.assertIn("<overrides>", str(raised.exception))
            self.assertNotIn("hidden-token", str(raised.exception))
        policy = self.load({"policy": {"script": {"command": ["/not/executed", ""]}}})["policy"]
        self.assertEqual(policy["script"]["max_summary_chars"], 2000)
        self.write(self.project_path, '[policy.script]\ntimeout_ms=100\n')
        with self.assertRaises(ConfigError) as raised:
            self.load()
        self.assertIn(str(self.project_path), str(raised.exception))
        self.write(self.project_path, 'hidden-token = [')
        with self.assertRaises(ConfigError) as raised:
            self.load()
        self.assertNotIn("hidden-token", str(raised.exception))

    def test_file_limit_and_read_errors(self):
        self.global_path.parent.mkdir(parents=True)
        self.global_path.write_bytes(b"#" + b" " * (MAX_CONFIG_BYTES - 1))
        self.load()
        self.global_path.write_bytes(b"#" + b" " * MAX_CONFIG_BYTES)
        with self.assertRaisesRegex(ConfigError, "exceed"):
            self.load()
        self.global_path.unlink()
        self.global_path.mkdir()
        with self.assertRaises(ConfigError) as raised:
            self.load()
        self.assertIn(str(self.global_path), str(raised.exception))
        self.assertIn("cannot read", str(raised.exception))

    def test_permission_errors_are_not_treated_as_missing_files(self):
        with patch("context_folding.config.Path.open", side_effect=PermissionError("denied")):
            with self.assertRaises(ConfigError) as raised:
                self.load()
            self.assertIn(str(self.global_path), str(raised.exception))
            self.assertIn("denied", str(raised.exception))
        with patch("context_folding.config.Path.stat", side_effect=PermissionError("denied")):
            with self.assertRaises(ConfigError):
                project_config_path(self.project)


if __name__ == "__main__":
    unittest.main()
