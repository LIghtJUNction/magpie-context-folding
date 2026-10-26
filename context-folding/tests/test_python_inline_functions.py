import unittest

from context_folding.annotations import annotate_python_functions, discover_source


class InlineFunctionTests(unittest.TestCase):
    def test_inline_suites_are_not_folded_or_marked(self):
        source = '''\
def signature(
    value: dict[str, int] = {"key: value": 1},
): return value

async def async_signature(
    value,
): return value

def multiline_string(): return """first:
second"""

def colon_in_annotation(
    value: tuple[int, int],
) -> dict[str, int]: return {"x": 1}
'''
        regions = discover_source(source, "python")["regions"]
        self.assertEqual([], [r for r in regions if r["kind"] in ("FunctionDef", "AsyncFunctionDef")])
        result = annotate_python_functions(source)
        self.assertEqual(source, result["text"])
        self.assertEqual([], result["added"])

    def test_multiline_suites_still_fold_with_nested_colons(self):
        source = '''\
@decorator("foo: bar")
def ordinary(
    value: dict[str, int] = {"key": 1},
):  # comment
    return value

async def async_function():
    return """first
second"""

def lambda_annotation() -> lambda x: x:
    return 1
'''
        regions = discover_source(source, "python")["regions"]
        self.assertEqual(["ordinary", "async_function", "lambda_annotation"], [r["name"] for r in regions])
        result = annotate_python_functions(source)
        self.assertEqual(["ordinary", "async_function", "lambda_annotation"], [r["name"] for r in result["added"]])
        self.assertEqual([], annotate_python_functions(result["text"])["added"])


if __name__ == "__main__":
    unittest.main()
