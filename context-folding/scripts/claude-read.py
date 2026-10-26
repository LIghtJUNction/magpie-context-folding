#!/usr/bin/env python3
"""Plugin-local entry point; no package installation or cwd change required."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from context_folding.claude_read import main

raise SystemExit(main())
