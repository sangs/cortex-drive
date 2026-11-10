"""
Persons' work domains in the routing catalog (cross-domain design 2026-11-09 §4.1, S2-78).

build_entity_catalog gives each person entry `work_domains`: the routing domains of the titled nodes the
person is directly linked to. The gateway routes "What has <person> written about X?" to career only when
the person's work includes career content — the founder yes, a podcast guest no.

Read-only against the live graph (owner tenant from .env); skipped without NEO4J_* in .env.

    .venv/bin/python -m unittest tests.mcp_server.test_person_work_domains -v
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class PersonWorkDomainsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from neo4j import GraphDatabase
        import entity_catalog
        cls.driver = GraphDatabase.driver(os.environ["NEO4J_URI"],
                                          auth=(os.environ["NEO4J_USERNAME"], os.environ["NEO4J_PASSWORD"]))
        cls.catalog = entity_catalog.build_entity_catalog(cls.driver, os.environ.get("TENANT_ID", ""))
        cls.persons = {e["name"]: e for e in cls.catalog["entries"] if e["domain"] == "person"}

    @classmethod
    def tearDownClass(cls):
        cls.driver.close()

    def test_every_person_has_work_domains(self):
        self.assertTrue(self.persons)
        for name, e in self.persons.items():
            self.assertIsInstance(e.get("work_domains"), list, name)
            self.assertNotIn("person", e["work_domains"], name)

    def test_founder_work_includes_career(self):
        founders = [e for e in self.persons.values() if e["tier"] == "PUBLIC"]
        self.assertTrue(founders, "no PUBLIC person (founder career graph)")
        self.assertTrue(any("career" in e["work_domains"] for e in founders))

    def test_podcast_guests_have_no_career_work(self):
        guests = [e for e in self.persons.values() if e["work_domains"] == ["podcast"]]
        self.assertTrue(guests, "expected at least one podcast-only person (a guest or host)")


if __name__ == "__main__":
    unittest.main()
