"""S2-94: scripts/curate_career_employer_links.py against the test tenant only (tests/test_tenant.py).

Creates its own nodes under TEST_TENANT_ID with names no real node has, runs the planner and the writer with
`tier = TEST_TENANT_ID`, and deletes everything under the test tenant afterwards, even on failure.
Checks: plan, apply, idempotent re-run, no tier change, and refusal on a name collision, a second employer,
a tier mismatch and a missing employer (nothing written when refused).
Run: .venv/bin/python tests/mcp_server/test_career_employer_links.py -v
"""
import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "src", "mcp_server"))
sys.path.insert(0, os.path.join(REPO, "scripts"))

from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant  # noqa: E402

use_test_tenant()
from dotenv import load_dotenv  # noqa: E402
load_dotenv()
from neo4j_connection import create_driver  # noqa: E402
import curate_career_employer_links as curate  # noqa: E402

P = "S294-TEST "   # name prefix no real node uses


def mapping(*links):
    return {"property": "employer_node_id", "employer_label": "Company", "required_tier": TEST_TENANT_ID,
            "links": [{"item": P + i, "item_labels": labels, "employer": P + e} for i, labels, e in links]}


class CareerEmployerLinksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.driver = create_driver()
        cleanup_test_tenant(cls.driver)

    @classmethod
    def tearDownClass(cls):
        cleanup_test_tenant(cls.driver)
        cls.driver.close()

    def setUp(self):
        cleanup_test_tenant(self.driver)
        with self.driver.session() as s:
            s.run("""
                CREATE (:Company {name: $p + 'Acme', node_id: $p + 'acme-id', tenant_id: $t})
                CREATE (:Company {name: $p + 'Other Co', node_id: $p + 'other-id', tenant_id: $t})
                CREATE (:Project:Hackathon {name: $p + 'Hack', tenant_id: $t})
                CREATE (:Publication:ThoughtLeadership {name: $p + 'Article', tenant_id: $t})
                CREATE (:ReferenceLink {name: $p + 'Article', tenant_id: $t})
            """, p=P, t=TEST_TENANT_ID)

    def links_to(self, item):
        with self.driver.session() as s:
            return s.run("MATCH (n {tenant_id: $t}) WHERE n.name = $n AND n.employer_node_id IS NOT NULL "
                         "MATCH (e:Company {node_id: n.employer_node_id}) RETURN e.name AS e, n.employer_source AS src",
                         n=P + item, t=TEST_TENANT_ID).data()

    def edge_count(self):
        with self.driver.session() as s:
            return s.run("MATCH (a {tenant_id: $t})-[r]-() RETURN count(r) AS c", t=TEST_TENANT_ID).single()["c"]

    def test_plan_apply_and_rerun(self):
        m = mapping(("Hack", ["Hackathon"], "Acme"), ("Article", ["Publication"], "Acme"))
        with self.driver.session() as s:
            plan = curate.plan_links(s, m, TEST_TENANT_ID)
            self.assertEqual(plan["errors"], [], "label filter keeps the ReferenceLink twin out")
            self.assertEqual(len(plan["to_link"]), 2)
            self.assertEqual(self.links_to("Hack"), [], "planning writes nothing")
            self.assertEqual(curate.apply_links(s, plan), 2)
            self.assertEqual(self.links_to("Hack"), [{"e": P + "Acme", "src": curate.CURATION_SOURCE}])
            again = curate.plan_links(s, m, TEST_TENANT_ID)
            self.assertEqual((len(again["to_link"]), len(again["already"])), (0, 2), "re-run is a no-op")
            self.assertEqual(curate.apply_links(s, again), 0)
            tiers = s.run("MATCH (n) WHERE n.name STARTS WITH $p RETURN collect(DISTINCT n.tenant_id) AS t", p=P).single()["t"]
            self.assertEqual(tiers, [TEST_TENANT_ID], "no tier changed")
        self.assertEqual(self.edge_count(), 0, "no relationship created: bridge search must not see employers as hubs")

    def test_refusals_write_nothing(self):
        with self.driver.session() as s:
            s.run("CREATE (:Project:Hackathon {name: $n, tenant_id: $t})", n=P + "Hack", t=TEST_TENANT_ID)   # collision
            plan = curate.plan_links(s, mapping(("Hack", ["Hackathon"], "Acme")), TEST_TENANT_ID)
            self.assertTrue(any("2 items match" in e for e in plan["errors"]))
            with self.assertRaises(RuntimeError):
                curate.apply_links(s, plan)

            plan = curate.plan_links(s, mapping(("Article", ["Publication"], "Missing Co")), TEST_TENANT_ID)
            self.assertTrue(any("0 employers match" in e for e in plan["errors"]))

            plan = curate.plan_links(s, mapping(("Article", ["Publication"], "Acme")), "PUBLIC")
            self.assertTrue(any("outside tier PUBLIC" in e for e in plan["errors"]), "tier mismatch refused")

            s.run("MATCH (e:Company {name: $e}), (n:Publication {name: $n}) CREATE (e)-[:CONTAINS]->(n)",
                  e=P + "Other Co", n=P + "Article")
            plan = curate.plan_links(s, mapping(("Article", ["Publication"], "Acme")), TEST_TENANT_ID)
            self.assertTrue(any("different employer" in e for e in plan["errors"]), "second employer refused")
        self.assertEqual(self.links_to("Article"), [], "nothing written on refusal")

    def test_real_mapping_file_is_consistent(self):
        m = curate.load_mapping()
        self.assertEqual(m["required_tier"], "PUBLIC")
        self.assertEqual(len(m["links"]), 9)
        self.assertEqual(m["property"], "employer_node_id")
        self.assertTrue(all(e["item_labels"] for e in m["links"]), "every entry names its labels (AP-13)")


if __name__ == "__main__":
    unittest.main()
