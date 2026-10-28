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



    def test_global_location_and_home_fallback(self):
        self.assertEqual(global_config_path(), self.global_path)
        fallback = self.home / ".config" / "context-folding" / "config.toml"
        self.write(fallback, "[folding]\ndelay_requests=20\n")
        for xdg in (None, ""):
            with self.subTest(xdg=xdg), patch.dict(os.environ):
                if xdg is None:
                    os.environ.pop("XDG_CONFIG_HOME", None)
                else:
                    os.environ["XDG_CONFIG_HOME"] = xdg
                self.assertEqual(global_config_path(), fallback)
                self.assertEqual(self.load()["folding"]["delay_requests"], 20)


    def test_only_nearest_project_file_is_loaded(self):
        self.write(self.project_path, "[folding]\ndelay_requests=20\nreserve_output_tokens=100\n")
        child = self.project / "nested"
        child.mkdir()
        nearest = self.write(child / ".context-folding.toml", "[folding]\ndelay_requests=30\n")
        grandchild = child / "deep"
        grandchild.mkdir()
        self.assertEqual(project_config_path(grandchild), nearest)
        settings = load_config(grandchild)
        self.assertEqual(settings["folding"]["delay_requests"], 30)
        self.assertEqual(settings["folding"]["reserve_output_tokens"], 0)

    def test_git_root_checked_but_never_its_parent_for_git_directory_or_file(self):
        self.write(self.root / ".context-folding.toml", "[folding]\ndelay_requests=999\n")
        child = self.project / "nested"
        child.mkdir()
        for kind in ("directory", "file"):
            with self.subTest(kind=kind):
                marker = self.project / ".git"
                if kind == "file":
                    marker.rmdir()
                    marker.write_text("gitdir: /unused\n", encoding="utf-8")
                self.assertIsNone(project_config_path(child))
                self.assertEqual(load_config(child)["folding"]["delay_requests"], 1)
                self.write(self.project_path, "[folding]\ndelay_requests=20\n")
                self.assertEqual(load_config(child)["folding"]["delay_requests"], 20)
                self.project_path.unlink()

    def test_cwd_is_default_start_directory(self):
        self.write(self.project_path, "[folding]\nenabled=false\n")
        with patch("context_folding.config.Path.cwd", return_value=self.project):
            self.assertFalse(load_config()["folding"]["enabled"])

    def test_without_git_root_searches_parents(self):
        (self.project / ".git").rmdir()
        self.write(self.root / ".context-folding.toml", "[folding]\ndelay_requests=42\n")
        self.assertEqual(self.load()["folding"]["delay_requests"], 42)

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


    def test_invalid_global_not_hidden_by_valid_override(self):
        self.write(self.global_path, '[folding]\ndelay_requests="invalid"\n')
        with self.assertRaisesRegex(ConfigError, "folding.delay_requests"):
            self.load({"folding": {"delay_requests": 30}})




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


    def test_annotation_only_defaults_and_input_isolation(self):
        settings = self.load()
        self.assertEqual(settings["folding"], {"enabled": True, "delay_requests": 1,
                         "max_session_bytes": 67108864, "reserve_output_tokens": 0})
        self.assertEqual(set(settings), {"folding", "annotations", "gc", "magpie"})
        self.assertNotIn("context_window_tokens", settings["folding"])
        settings["annotations"]["keep"].append("changed")
        self.assertEqual(self.load()["annotations"]["keep"], [])
        self.assertFalse(self.global_path.exists())
        self.assertFalse(self.project_path.exists())

    def test_budget_and_delay_merge_without_changing_inputs(self):
        self.write(self.global_path, "[folding]\ndelay_requests=2\ncontext_window_tokens=128000\n")
        self.write(self.project_path, "[folding]\ndelay_requests=3\nreserve_output_tokens=8000\n")
        overrides = {"folding": {"delay_requests": 1}, "annotations": {"keep": ["result"]}}
        original = copy.deepcopy(overrides)
        settings = self.load(overrides)
        self.assertEqual(settings["folding"]["context_window_tokens"], 128000)
        self.assertEqual(settings["folding"]["reserve_output_tokens"], 8000)
        self.assertEqual(settings["folding"]["delay_requests"], 1)
        settings["annotations"]["keep"].append("other")
        self.assertEqual(overrides, original)

    def test_removed_strategies_and_policy_report_migration(self):
        for field in ("mode", "threshold_tokens", "head_chars", "keep_recent_messages", "minimum_saving_usd"):
            with self.subTest(field=field), self.assertRaisesRegex(ConfigError, "removed"):
                self.load({"folding": {field: "economy"}})
        for config in ({"policy": {}}, {"magpie": {"accounting": {"url": "secret"}}}):
            with self.assertRaisesRegex(ConfigError, "removed") as raised:
                self.load(config)
            self.assertNotIn("secret", str(raised.exception))

    def test_strict_types_unknown_fields_and_safe_ranges(self):
        invalid = {"folding.delay_requests": [True, -1, 0.5, 9007199254740992],
                   "folding.context_window_tokens": [False, 0, -1, 1.5],
                   "folding.reserve_output_tokens": [True, -1, 1.5],
                   "folding.max_session_bytes": [False, 0, 67108865],
                   "folding.enabled": ["true", 1], "annotations.keep": [[""], ["a\0b"], "a"],
                   "magpie.gateway_timeout_ms": [99, 10001],
                   "magpie.file_access": ["true", 0, None]}
        for key, values in invalid.items():
            section, field = key.split(".")
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ConfigError):
                    self.load({section: {field: value}})
        for config in ({"surprise": {}}, {"folding": {"unknown": 1}}, {"folding": []}, []):
            with self.assertRaises(ConfigError):
                self.load(config)
        valid = self.load({"folding": {"delay_requests": 0, "context_window_tokens": 1,
                            "reserve_output_tokens": 0, "max_session_bytes": 1},
                           "magpie": {"file_access": True, "gateway_timeout_ms": 100}})
        self.assertEqual(valid["folding"]["delay_requests"], 0)


if __name__ == "__main__":
    unittest.main()
