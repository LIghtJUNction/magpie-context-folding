import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from context_folding.annotations import discover_source
from context_folding.javascript import annotate_javascript_functions, parse_source, _syntax


import importlib.util

PARSERS_AVAILABLE = all(importlib.util.find_spec(module) for module in
                        ('tree_sitter', 'tree_sitter_javascript', 'tree_sitter_typescript'))


@unittest.skipUnless(PARSERS_AVAILABLE, 'Install the optional javascript extra for parser tests')
class JavascriptFunctionTests(unittest.TestCase):
    def test_declarations_methods_arrows_nested_and_idempotence(self):
        source = '''#!/usr/bin/env node
"use strict";
// @ts-expect-error retained next to declaration
export async function outer(value) {
  const nested = (x) => {
    return /[{}]/.test(x) ? `${x} }` : "{";
  };
  return nested(value);
}
class Example {
  *method() {
    yield 1;
  }
  get value() {
    return 2;
  }
}
const obj = {
  method() {
    return 3;
  },
};
'''
        result = annotate_javascript_functions(source)
        self.assertEqual(4, len(result['added']))
        self.assertEqual(source, ''.join(line for line in result['text'].splitlines(keepends=True)
                                         if '// @context-fold ' not in line))
        self.assertEqual([], annotate_javascript_functions(result['text'])['added'])
        regions = discover_source(result['text'], 'javascript')['regions']
        self.assertEqual(4, len(regions))
        self.assertTrue(all(region['parentId'] is None for region in regions))
        before, data = parse_source(source, 'javascript')
        after, output = parse_source(result['text'], 'javascript')
        self.assertEqual(_syntax(before, data), _syntax(after, output))

    def test_skip_inline_expression_empty_and_inline_closing(self):
        source = '''function one() { return 1; }
const expr = (x) => x + 1;
function inline(
  x
) { return x; }
function partly() {
  return 1; }
function empty() {
}
'''
        result = annotate_javascript_functions(source)
        self.assertEqual(source, result['text'])
        self.assertEqual([], result['added'])
        self.assertEqual(5, len(result['skipped']))

    def test_typescript_tsx_jsx_and_unicode_crlf(self):
        examples = {
            'typescript': '''interface I { run(): number; }
function overloaded(x: string): string;
function overloaded(x: string): string {
  return x;
}
class C {
  constructor(private value: number) {
    console.log(value);
  }
  async method<T>(arg: T): Promise<T> {
    return arg;
  }
}
const 箭头 = <T>(value: T): T => {
  return value;
};''',
            'tsx': '''const View = <T,>(props: {value: T}) => {
  return <div title="}">{String(props.value)}</div>;
};''',
            'jsx': '''function View() {
  return <div>{"{"}</div>;
}''',
        }
        for language, source in examples.items():
            for ending in ('\n', '\r\n'):
                with self.subTest(language=language, ending=ending):
                    original = source.replace('\n', ending)
                    result = annotate_javascript_functions(original, language)
                    self.assertTrue(result['added'])
                    self.assertEqual(original, ''.join(line for line in result['text'].splitlines(keepends=True)
                                                       if '// @context-fold ' not in line))
                    self.assertEqual(result['text'], annotate_javascript_functions(result['text'], language)['text'])
                    self.assertEqual(len(result['added']), len(discover_source(result['text'], language)['regions']))

    def test_strings_jsx_and_block_comments_are_not_markers(self):
        source = '''const template = `
// @context-fold begin fake
// @context-fold end fake
`;
/*
// @context-fold begin fake
*/
const View = () => <div>
// @context-fold end fake
</div>;
function valid() {
  return template;
}
'''
        self.assertEqual([], discover_source(source, 'tsx')['regions'])
        self.assertEqual(1, len(annotate_javascript_functions(source, 'tsx')['added']))

    def test_block_markers_and_duplicate_method_names(self):
        explicit = 'function f() {\n  /* @context-fold begin old */\n  return 1;\n  /* @context-fold end old */\n}\n'
        self.assertEqual(1, len(discover_source(explicit, 'javascript')['regions']))
        self.assertEqual([], annotate_javascript_functions(explicit)['added'])
        source = 'class A {\n  run() {\n    return 1;\n  }\n}\nclass B {\n  run() {\n    return 2;\n  }\n}\n'
        result = annotate_javascript_functions(source)
        names = [item['name'] for item in result['added']]
        self.assertEqual(2, len(set(names)))
        self.assertEqual([], annotate_javascript_functions(result['text'])['added'])

    def test_template_line_with_real_inline_comment_is_not_a_marker(self):
        source = '''const value = `
// @context-fold begin fake ${1 // comment
}
// @context-fold end fake ${2 // comment
}
`;
function actual() {
  return value;
}
'''
        self.assertEqual([], discover_source(source, 'javascript')['regions'])
        marked = annotate_javascript_functions(source)['text']
        self.assertEqual(1, len(discover_source(marked, 'javascript')['regions']))

    def test_fail_closed_on_invalid_syntax_markers_and_line_separators(self):
        for source in ('function broken( {', '// @context-fold begin missing\n',
                       'function f() {\r  return 1;\r}',
                       'function f() {\n return " ";\n}',
                       '// @context-fold bogus x\n'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                annotate_javascript_functions(source)

    def test_optional_parser_missing_fails_clearly(self):
        with patch.dict(sys.modules, {'tree_sitter': None}):
            with self.assertRaisesRegex(ValueError, 'optional.*javascript'):
                annotate_javascript_functions('function f() {\n  return 1;\n}')
            self.assertEqual('python-comments', discover_source('def f():\n    return 1\n', 'python')['parser'])
            self.assertEqual('explicit-regions', discover_source('hello', 'text')['parser'])

    def test_runtime_behavior_including_asi_and_templates(self):
        from shutil import which
        if not which('node'):
            self.skipTest('Node is unavailable')
        source = '''function compute() {
  const template = `line one
line two }`;
  return
  { value: template };
}
async function main() {
  const fn = async (x) => {
    return x * 2;
  };
  console.log(JSON.stringify([compute(), await fn(4)]));
}
main();
'''
        marked = annotate_javascript_functions(source)['text']
        def execute(text):
            return subprocess.run(['node', '--input-type=module'], input=text,
                                  text=True, capture_output=True, check=True).stdout
        self.assertEqual(execute(source), execute(marked))

    def test_client_roundtrip_and_legacy_archive_without_parser(self):
        from context_folding import Client
        from context_folding.annotations import discover_source as real_discover
        source = '// @context-fold begin legacy\n' + ''.join(
            f'const value{i} = "payload {i} ' + 'x' * 80 + '";\n' for i in range(15)
        ) + '// @context-fold end legacy\n'
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / 'state.sqlite'
            # Reproduce a pre-parser snapshot using the actual generic discovery
            # format, but the original recorded JavaScript language metadata.
            def legacy_discover(text, language=None, path=None, styles=None):
                result = real_discover(text, 'explicit', path, styles)
                result['language'] = 'javascript'
                return result
            with Client(state, config={"folding": {"delay_requests": 0}}) as client:
                with patch('context_folding.annotations.discover_source', side_effect=legacy_discover):
                    old = client.read_source('legacy', text=source, language='javascript')
                marked = annotate_javascript_functions('function f() {\n' + ''.join(
                    f'  const value{i} = "' + 'x' * 80 + '";\n' for i in range(15)
                ) + '}\n')['text']
                current = client.read_source('new', text=marked, language='javascript')
                self.assertTrue(current['foldedRegions'])
                self.assertEqual(marked, client.resolve('new', current['text'])['value'])
            with patch.dict(sys.modules, {'tree_sitter': None}), Client(state) as client:
                self.assertEqual(source, client.read('legacy', old['id'], mode='original')['text'])
                reused = client.read_source('legacy', id=old['id'])
                self.assertEqual('explicit-regions', reused['parser'])
                self.assertEqual(source, client.resolve('legacy', reused['text'])['value'])
                self.assertEqual(source, client.read('legacy', old['id'], expand=['legacy'])['text'])
                self.assertEqual(marked, client.read('new', current['id'], mode='original')['text'])
                self.assertEqual(marked, client.resolve('new', client.read_source('new', id=current['id'])['text'])['value'])

    def test_project_cli_preview_apply_and_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ts = root / 'main.ts'
            tsx = root / 'view.tsx'
            original = 'function f(): number {\n  return 1;\n}\n'
            ts.write_text(original)
            tsx.write_text('const View = () => {\n  return <div />;\n};\n')
            (root / 'ignored.js').write_text('function invalid( {')
            command = [sys.executable, '-m', 'context_folding', 'annotate-functions', str(root),
                       '--language', 'typescript']
            preview = subprocess.run(command, text=True, capture_output=True, check=True)
            self.assertEqual(2, json.loads(preview.stdout)['result']['changedFiles'])
            self.assertEqual(original, ts.read_text())
            bad = root / 'bad.ts'
            bad.write_text('function invalid( {')
            failed = subprocess.run(command + ['--apply'], text=True, capture_output=True)
            self.assertEqual(1, failed.returncode)
            self.assertEqual(original, ts.read_text())
            bad.unlink()
            subprocess.run(command + ['--apply'], text=True, capture_output=True, check=True)
            self.assertIn('// @context-fold begin', ts.read_text())
            self.assertEqual(0, json.loads(subprocess.run(command, text=True, capture_output=True,
                                                       check=True).stdout)['result']['changedFiles'])


if __name__ == '__main__':
    unittest.main()
