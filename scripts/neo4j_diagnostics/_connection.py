#!/usr/bin/env python3
"""Shared Neo4j connection helper for scripts/neo4j_diagnostics/.

Uses the same environment variables as src/mcp_server/expert_tools.py
(NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD) so these scripts talk to the same
database as the running application.
"""
import os
from contextlib import contextmanager

from dotenv import load_dotenv
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '../../src/mcp_server'))
from neo4j_connection import create_driver  # noqa: E402 — the one driver factory (S2-79)

load_dotenv()


def get_driver():
    return create_driver()


@contextmanager
def neo4j_session():
    """Yields a Neo4j session; closes the driver on exit."""
    driver = get_driver()
    try:
        with driver.session() as session:
            yield session
    finally:
        driver.close()
