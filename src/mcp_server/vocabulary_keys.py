"""
Vocabulary name keys (cross-domain discovery design 2026-11-09 §5.0). One normalization for both the one-off
consolidation of SYSTEM duplicates (scripts/consolidate_vocabulary.py) and the find-or-create of vocabulary on write
(seed scripts, ingestion), so the two can never disagree on what "the same name" is.

    base_key("Graph database")  -> "graph database"
    group_keys(["Graph Databases", "Graph Database", "Kubernetes"])
        -> {"Graph Databases": "graph database", "Graph Database": "graph database", "Kubernetes": "kubernetes"}
"""
import re

from domain_registry import VOCABULARY_DO_NOT_SINGULARIZE

_PUNCT = re.compile(r"[^a-z0-9+#]+")
_DO_NOT = set(VOCABULARY_DO_NOT_SINGULARIZE)


def base_key(name: str) -> str:
    """Lowercase; punctuation other than + and # becomes a space; spaces collapsed."""
    return " ".join(_PUNCT.sub(" ", str(name or "").lower()).split())


def _singular(key: str) -> str:
    words = key.split()
    if not words or key in _DO_NOT:
        return key
    last = words[-1]
    if len(last) > 3 and last.endswith("s") and not last.endswith("ss"):
        return " ".join(words[:-1] + [last[:-1]])
    return key


def group_keys(names) -> dict:
    """name → key. A trailing plural "s" is dropped only when the singular form is also among the names (so a name
    that merely ends in "s" — "Kubernetes", "Redis" — is never altered), and never for VOCABULARY_DO_NOT_SINGULARIZE."""
    bases = {n: base_key(n) for n in names}
    present = set(bases.values())
    out = {}
    for n, b in bases.items():
        s = _singular(b)
        out[n] = s if s != b and s in present else b
    return out


def name_key(name: str, known_keys=None) -> str:
    """The key to store on write. With `known_keys` (existing keys), a plural that has a known singular maps to it."""
    b = base_key(name)
    s = _singular(b)
    return s if known_keys is not None and s != b and s in known_keys else b
