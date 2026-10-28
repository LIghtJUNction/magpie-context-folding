#!/usr/bin/env python3
"""Claude post-compaction entry point, usable directly from the plugin folder."""
from pathlib import Path
import runpy

# Run the stdlib-only hook directly, without importing the archive package or
# its optional Python 3.10 configuration dependency through __init__.py.
runpy.run_path(str(Path(__file__).resolve().parents[1] / "python/context_folding/post_compaction.py"),
               run_name="__main__")
