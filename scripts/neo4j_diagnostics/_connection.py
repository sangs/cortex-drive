#!/usr/bin/env python3
"""Shared Neo4j connection helper for scripts/neo4j_diagnostics/.

Uses the same environment variables as src/mcp_server/expert_tools.py
(NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD) so these scripts talk to the same
database as the running application.
"""
import os
from contextlib import contextmanager

from dotenv import load_dotenv
from neo4j import GraphDatabase

load_dotenv()


def get_driver():
    return GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]),
    )


@contextmanager
def neo4j_session():
    """Yields a Neo4j session; closes the driver on exit."""
    driver = get_driver()
    try:
        with driver.session() as session:
            yield session
    finally:
        driver.close()
