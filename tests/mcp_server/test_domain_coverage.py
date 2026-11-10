"""
Routing v2 coverage check (cross-domain discovery design 2026-11-09 §4.1 rule 3): ExpertTools.domain_coverage.

Live, read-only (owner graph from .env), with the document domain on as in production:
- a topic covered in several domains is found in each; whole words only; plural tolerant;
- linked vocabulary counts when its name contains the term ("zero trust" → "Zero Trust Architecture");
- a member with no shares sees coverage only from SYSTEM/PUBLIC content (never reveals org content);
- a term found nowhere covers nothing.

    .venv/bin/python -m unittest tests.mcp_server.test_domain_coverage -v
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))

import domain_registry as reg  # noqa: E402


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class DomainCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.flag = mock.patch.dict(reg.DOMAIN_FEATURE_FLAGS, {"document": True})
        cls.flag.start()
        from expert_tools import ExpertTools
        cls.owner = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""))
        cls.member = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""), requesting_user_id="user_test_member_no_shares",
                                 allowed_ids=[])

    @classmethod
    def tearDownClass(cls):
        cls.owner.close()
        cls.member.close()
        cls.flag.stop()

    def covered(self, tools, term):
        return {d for d, hit in tools.domain_coverage([term]).items() if hit}

    def test_topic_in_several_domains(self):
        self.assertEqual(self.covered(self.owner, "graph databases"), {"professional", "podcast", "website"})

    def test_plural_tolerant(self):
        self.assertEqual(self.covered(self.owner, "graph database"), self.covered(self.owner, "graph databases"))

    def test_document_only_topic(self):
        self.assertEqual(self.covered(self.owner, "self-attention"), {"document"})

    def test_linked_vocabulary_name_contains_the_term(self):
        self.assertIn("professional", self.covered(self.owner, "zero trust"))

    def test_unknown_term_covers_nothing(self):
        self.assertEqual(self.covered(self.owner, "quantum computing"), set())
        self.assertEqual(self.covered(self.owner, ""), set())

    def test_member_without_shares_sees_only_public_coverage(self):
        # The founder's career graph is PUBLIC (Cortex-Drive → Graph Databases); the org podcast and website are not.
        self.assertEqual(self.covered(self.member, "graph databases"), {"professional"})
        self.assertEqual(self.covered(self.member, "self-attention"), set())


if __name__ == "__main__":
    unittest.main()
