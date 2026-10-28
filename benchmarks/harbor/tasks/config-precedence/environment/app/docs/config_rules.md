# Configuration contract, version 1

The command takes five arguments: a base JSON file, a profiles JSON file, a
profile name, a dotted-overrides JSON file, and an output file. The three input
files must contain JSON objects. The selected profile must exist and be an
object. Use these stages, in order:

## 1. Recursive profile overlay

Start with an independent copy of the base object. For each profile key:

- `null` deletes that key if it exists.
- An object recursively overlays the existing object. If the previous value is
  not an object or is absent, start with an empty object for this key.
- Any other value replaces the previous value. Lists replace completely;
  they do not concatenate. False, zero, and empty strings are ordinary values.

Do not remove `null` inside a list. Deleting the last child leaves an empty
parent object; it does not delete the parent automatically.

## 2. Dotted overrides

Process the override object's keys in JSON insertion order. Split each key on
`.`. Empty segments, including an empty key, are invalid. Input object keys
otherwise use ordinary strings; there is no escaping syntax for a dot.

- A non-null override replaces the leaf value. Create missing intermediate
  objects; replace a scalar or list intermediate with an empty object.
- A null override deletes only the leaf. If its parent path is absent or blocked
  by a non-object, do nothing. Deleting must not create intermediate objects.
- An override value that is an object replaces the entire leaf, without doing
  another recursive merge. Its nested null values are ordinary JSON data.

## 3. Output and errors

Write `{"profile": PROFILE, "config": RESOLVED_OBJECT}` as JSON. Object key
order and whitespace do not matter; lists retain their order. Create the output
parent directory if needed. Do not modify any input file.

For malformed JSON, a non-object input, an unknown/non-object profile, or an
invalid dotted path, exit nonzero and do not create the output file.
