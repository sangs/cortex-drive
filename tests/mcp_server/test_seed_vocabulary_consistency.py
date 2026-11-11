"""
Seed ↔ live consistency for the vocabulary review of 2026-11-10 (daily log 2026-11-10 §11).

The seed (scripts/seed_resume_graph.py) is the source of truth for a rebuild; the live graph was corrected by
scripts/migrate_career_vocabulary.py. This test keeps the two in step for the reviewed nodes:
- Cortex-Drive: USES_TOOL = the seed's §3b technologies + §9 tools; DISCUSSES ⊇ the seed's §3b concepts;
- the InfoQ article: DISCUSSES = the seed's §16 concepts; no USES_TOOL;
- the InfoQ certification: no topic tags of its own.
Unit part (seed parsing) needs no database; the live part is read-only.

    .venv/bin/python -m unittest tests.mcp_server.test_seed_vocabulary_consistency -v
"""
import ast
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
SEED = open(os.path.join(ROOT, "scripts", "seed_resume_graph.py")).read()
INFOQ = "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI"
CERT = "[2026] InfoQ Certified Architect"


def _list_before(marker: str) -> set:
    """The Cypher list literal immediately before `marker` (e.g. '] AS tech')."""
    end = SEED.index(marker)
    start = SEED.rindex("[", 0, end)
    return set(ast.literal_eval(SEED[start:end + 1]))


def seed_lists() -> dict:
    cortex_tools = set(ast.literal_eval(re.search(r"cortex:\s*(\[[^\]]*\])", SEED).group(1)))
    return {
        "cortex_uses": _list_before("] AS tech") | cortex_tools,
        "cortex_discusses": _list_before("] AS concept"),
        "infoq_discusses": set(ast.literal_eval(re.search(r"WITH\s*(\[[^\]]*\])\s*AS concepts", SEED).group(1))),
    }


class SeedListsTest(unittest.TestCase):
    def test_reviewed_tools_are_gone_from_the_seed(self):
        lists = seed_lists()
        removed = {"LangGraph", "Langflow", "FastAPI", "Supabase", "Railway", "Google Antigravity", "Claude Code",
                   "AI", "Software architecture", "AI Agent", "AI Architecture", "Explainability", "Governance"}
        self.assertFalse(lists["cortex_uses"] & removed, lists["cortex_uses"] & removed)
        self.assertTrue({"AI Agent", "Explainability", "Governance", "AI Architecture"} <= lists["cortex_discusses"])
        self.assertEqual(lists["infoq_discusses"], {"Software Architecture", "AI", "C4 Model", "Explainability",
                                                    "Governance", "Platform Engineering"})

    def test_certification_has_no_topic_tags_in_the_seed(self):
        self.assertNotIn("infoq_cert", SEED)


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class LiveMatchesSeedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from neo4j import GraphDatabase
        cls.driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                          auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))

    @classmethod
    def tearDownClass(cls):
        cls.driver.close()

    def links(self, name, rel):
        rows = self.driver.execute_query(
            f"MATCH (n {{name: $n}})-[:{rel}]->(m) WHERE NOT n:ReferenceLink RETURN DISTINCT m.name AS m", n=name).records
        return {r["m"] for r in rows}

    def test_cortex_drive(self):
        lists = seed_lists()
        self.assertEqual(self.links("Cortex-Drive", "USES_TOOL"), lists["cortex_uses"])
        self.assertTrue(lists["cortex_discusses"] <= self.links("Cortex-Drive", "DISCUSSES"))

    def test_infoq_article(self):
        self.assertEqual(self.links(INFOQ, "DISCUSSES"), seed_lists()["infoq_discusses"])
        self.assertEqual(self.links(INFOQ, "USES_TOOL"), set())

    def test_certification(self):
        self.assertEqual(self.links(CERT, "USES_TOOL") | self.links(CERT, "DISCUSSES"), set())


if __name__ == "__main__":
    unittest.main()
