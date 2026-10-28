import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from context_folding.claude_read import ENV, binding, client, expand, fold, key, start


SOURCE = ('# @context-fold begin work\ndef work():\n'
          + ''.join(f'    value_{i} = {i!r}  # enough source content\n' for i in range(100))
          + '    return value_99\n# @context-fold end work\n\nprint(work())\n')


def event(text=SOURCE):
    return {'hook_event_name': 'PostToolUse', 'tool_name': 'Read', 'session_id': 'session-a',
            'cwd': os.getcwd(), 'tool_input': {'file_path': '/nonexistent.py'},
            'tool_response': {'type': 'text', 'extra': {'preserve': True}, 'file': {
                'filePath': '/nonexistent.py', 'content': text, 'numLines': len(text.splitlines()),
                'startLine': 1, 'totalLines': len(text.splitlines()), 'extra': 42}}}


class ClaudeReadTests(unittest.TestCase):
    def setUp(self):
        self.config_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.config_dir.cleanup)
        root = Path(self.config_dir.name)
        config = root / "context-folding" / "config.toml"
        config.parent.mkdir()
        config.write_text("[folding]\ndelay_requests=0\n")
        setting = patch.dict(os.environ, {"XDG_CONFIG_HOME": str(root)})
        setting.start()
        self.addCleanup(setting.stop)

    def test_default_delay_preserves_post_tool_output_without_host_cycles(self):
        config = Path(self.config_dir.name) / "context-folding" / "config.toml"
        config.write_text("[folding]\ndelay_requests=1\n")
        with tempfile.TemporaryDirectory() as directory, client(Path(directory), 'test', os.getcwd()) as archive:
            for _ in range(3):
                self.assertEqual(fold(event(), archive, 'test'), {})

    def test_fold_metadata_lines_and_exact_region_recovery(self):
        for newline in ('\n', '\r\n', '\r'):
            with self.subTest(newline=newline), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                original = event(SOURCE.replace('\n', newline))
                untouched = copy.deepcopy(original)
                token = binding(key(root), original['session_id'], original['cwd'])
                with patch.dict(os.environ, {'CLAUDE_ENV_FILE': str(root / 'env')}):
                    start(original, root)
                with client(root, token, original['cwd']) as archive:
                    output = fold(original, archive, token)
                response = output['hookSpecificOutput']['updatedToolOutput']
                text = response['file']['content']
                self.assertLess(len(text), len(original['tool_response']['file']['content']))
                self.assertEqual(len(text.splitlines()), original['tool_response']['file']['numLines'])
                self.assertEqual(text.splitlines()[-1], 'print(work())')
                self.assertIn('NOT SOURCE', text)
                self.assertEqual(response['extra'], original['tool_response']['extra'])
                for name in ('numLines', 'totalLines', 'startLine', 'extra'):
                    self.assertEqual(response['file'][name], original['tool_response']['file'][name])
                self.assertEqual(original, untouched)
                identifier, region = re.search(r' expand (\S+) ([0-9a-f]+)\]', text).groups()
                with patch.dict(os.environ, {ENV: token}), patch('os.getcwd', return_value='/tmp'):
                    self.assertEqual(expand(root, identifier), original['tool_response'])
                    recovered = expand(root, identifier, region)
                    self.assertEqual(recovered['file']['startLine'], 2)
                    self.assertEqual(recovered['file']['content'], ''.join(original['tool_response']['file']['content'].splitlines(keepends=True)[1:103]))
                other = binding(key(root), 'session-b', original['cwd'])
                with patch.dict(os.environ, {ENV: other}), self.assertRaises(Exception):
                    expand(root, identifier)
                with patch.dict(os.environ, {ENV: ''}), self.assertRaises(ValueError):
                    expand(root, identifier)

    def test_selective_sibling_expansion_preserves_response_and_recovery(self):
        source = "".join(f"# @context-fold begin {name}\n" + (f"{name} = '" + "x" * 80 + "'\n") * 40
                         + f"# @context-fold end {name}\n" for name in ("left", "right"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = event(source)
            token = binding(key(root), original['session_id'], original['cwd'])
            with patch.dict(os.environ, {'CLAUDE_ENV_FILE': str(root / 'env'), ENV: token}):
                start(original, root)
                with client(root, token, original['cwd']) as archive:
                    output = fold(original, archive, token)
                text = output['hookSpecificOutput']['updatedToolOutput']['file']['content']
                identifier = re.search(r' expand ([0-9a-f]{24}) ', text).group(1)
                selected = expand(root, identifier, ['left'], 'single')
                self.assertIn("left =", selected['file']['content'])
                self.assertNotIn("right =", selected['file']['content'])
                self.assertEqual(len(selected['file']['content'].splitlines()), len(source.splitlines()))
                self.assertEqual(selected['extra'], original['tool_response']['extra'])
                self.assertEqual(expand(root, identifier), original['tool_response'])
                self.assertEqual(expand(root, identifier, ['*'], 'recursive'), original['tool_response'])
                with self.assertRaises(Exception):
                    expand(root, identifier, ['unknown'], 'single')

    def test_unsafe_schema_partial_source_and_non_python_unchanged(self):
        with tempfile.TemporaryDirectory() as directory, client(Path(directory), 'test', os.getcwd()) as archive:
            cases = []
            for field, value in [('startLine', 2), ('numLines', 7), ('totalLines', 999), ('filePath', '/sample.js')]:
                candidate = event()
                candidate['tool_response']['file'][field] = value
                cases.append(candidate)
            candidate = event()
            candidate['tool_name'] = 'Edit'
            cases.append(candidate)
            candidate = event()
            candidate['tool_response'] = 'unknown schema'
            cases.append(candidate)
            cases.extend([event('value = """\n# @context-fold begin fake\nhello\n# @context-fold end fake\n"""\n'), event('x = 1\n')])
            for candidate in cases:
                self.assertEqual(fold(candidate, archive, 'test'), {})
            self.assertEqual(fold(event('    return 1\n'), archive, 'test'), {})

    def test_plugin_subprocess_start_hook_recovery_and_fail_open(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/claude-read.py'
        with tempfile.TemporaryDirectory() as directory:
            environment = {**os.environ, 'XDG_STATE_HOME': directory, 'CLAUDE_ENV_FILE': directory + '/env'}
            def run(args, payload=None):
                return subprocess.run([sys.executable, str(script), *args], input=json.dumps(payload) if payload is not None else None,
                                      text=True, capture_output=True, env=environment)
            original = event()
            self.assertEqual(run(['hook'], original).stdout, '')
            started = run(['start'], {**original, 'hook_event_name': 'SessionStart'})
            self.assertEqual(started.returncode, 0)
            environment[ENV] = Path(directory + '/env').read_text().strip().split('=', 1)[1]
            result = run(['hook'], original)
            self.assertEqual(result.returncode, 0)
            output = json.loads(result.stdout)['hookSpecificOutput']['updatedToolOutput']
            identifier = re.search(r' expand ([0-9a-f]{24}) ', output['file']['content']).group(1)
            restored = run(['expand', identifier])
            self.assertEqual(restored.returncode, 0, restored.stderr)
            self.assertEqual(json.loads(restored.stdout), original['tool_response'])
            selective = run(['expand', identifier, '*', '--expand-mode', 'single'])
            self.assertEqual(selective.returncode, 0, selective.stderr)
            self.assertEqual(json.loads(selective.stdout), original['tool_response'])
            for args in ([identifier, 'unknown', '--expand-mode', 'recursive'],
                         [identifier, '*', '--expand-mode', 'invalid'],
                         [identifier, '*', 'work']):
                self.assertNotEqual(run(['expand', *args]).returncode, 0)
            for candidate in ({**original, 'session_id': ''}, {**original, 'cwd': ''}, event('def broken(:\n')):
                self.assertEqual(run(['hook'], candidate).stdout, '')
            environment[ENV] = '0' * 64
            self.assertEqual(run(['expand', identifier]).returncode, 1)


if __name__ == '__main__':
    unittest.main()
