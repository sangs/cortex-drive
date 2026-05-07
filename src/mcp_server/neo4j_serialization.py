"""
neo4j_serialization.py — JSON serialization helpers for Neo4j query results.

Neo4j driver returns native temporal/spatial types (Date, DateTime, Duration, Time)
and numpy arrays (from embedding vectors) that Python's stdlib json encoder cannot
handle. Use neo4j_json_dumps() wherever json.dumps() is called on raw Neo4j data,
or pass neo4j_default as the `default=` argument to json.dumps() directly.
"""

import json
import numpy as np
from neo4j.time import Date, DateTime, Duration, Time


def neo4j_default(obj):
    """Fallback encoder for types stdlib json cannot serialize from Neo4j results."""
    if isinstance(obj, (Date, DateTime, Time)):
        return obj.iso_format()
    if isinstance(obj, Duration):
        return str(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def neo4j_json_dumps(obj, **kwargs) -> str:
    """Drop-in replacement for json.dumps that handles Neo4j native types."""
    kwargs.setdefault("default", neo4j_default)
    return json.dumps(obj, **kwargs)
