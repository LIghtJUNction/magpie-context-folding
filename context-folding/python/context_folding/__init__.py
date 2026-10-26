"""Host-neutral reversible context folding SDK."""
from .core import Client, FoldingError
from .annotations import fold_regions

__all__ = ["Client", "FoldingError", "fold_regions"]
