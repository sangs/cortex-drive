"""
Vocabulary consolidation (design 2026-11-09 §5.0 part A) on the TEST TENANT (writes; cleaned up before and after; no
Permify). Synthetic duplicates "Graph Databases" (Technology, linked to a project), "Graph Database" (Technology, linked
to an episode topic), "Graph Databases" (Concept, no links) and an unrelated "Kubernetes":
- the plan groups the three and leaves Kubernetes alone; the survivor is the Technology with links;
- apply moves every link to the survivor, keeps all spellings as aliases, sets name_key, deletes the duplicates, and the
  project and the episode are then connected through one node;
- rollback restores the duplicates and their links.
The script refuses any tier other than SYSTEM or a test tenant.

    .venv/bin/python -m unittest tests.mcp_server.test_consolidate_vocabulary -v
"""
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class ConsolidateVocabularyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant
        use_test_tenant()
        import consolidate_vocabulary as cv
        cls.cv, cls.tier, cls.cleanup = cv, TEST_TENANT_ID, staticmethod(cleanup_test_tenant)
        cls.d = cv.driver()
        cls.cleanup(cls.d)
        cls.d.execute_query("""
            CREATE (p:Project {name: 'cx-project', node_id: 'cx-p', tenant_id: $t})
            CREATE (e:Episode {name: 'cx-episode', node_id: 'cx-e', tenant_id: $t})
            CREATE (tp:Topic {name: 'cx-topic', node_id: 'cx-tp', tenant_id: $t})
            CREATE (a:Technology {name: 'Graph Databases', node_id: 'cx-a', tenant_id: $t})
            CREATE (b:Technology {name: 'Graph Database', node_id: 'cx-b', tenant_id: $t, description: 'from b'})
            CREATE (c:Concept {name: 'Graph Databases', node_id: 'cx-c', tenant_id: $t})
            CREATE (k:Technology {name: 'Kubernetes', node_id: 'cx-k', tenant_id: $t})
            CREATE (p)-[:USES_TOOL]->(a), (p)-[:USES_TOOL]->(k), (e)-[:HAS_TOPIC]->(tp), (tp)-[:COVERS_TECHNOLOGY]->(b),
                   (a)-[:IS_SIMILAR]->(b)
        """, t=cls.tier)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.cleanup(cls.d)
        finally:
            cls.d.close()

    def q(self, cypher, **kw):
        return self.d.execute_query(cypher, t=self.tier, **kw).records

    def test_plan_apply_rollback(self):
        p = self.cv.plan(self.tier)
        self.assertEqual([g["key"] for g in p["groups"]], ["graph database"], "Kubernetes untouched")
        g = p["groups"][0]
        self.assertEqual(g["survivor"]["node_id"] in ("cx-a", "cx-b"), True)
        self.assertTrue(g["mixed_labels"], "Technology + Concept flagged")
        path = os.path.join(ROOT, "logs", "test_vocab_plan.json")
        json.dump(p, open(path, "w"))

        self.cv.apply(path)
        nodes = self.q("MATCH (n {tenant_id: $t}) WHERE toLower(n.name) STARTS WITH 'graph database' "
                       "RETURN n.node_id AS id, n.aliases AS aliases, n.name_key AS key, n.description AS d")
        self.assertEqual(len(nodes), 1, "one node per concept")
        self.assertEqual(nodes[0]["key"], "graph database")
        self.assertTrue({"Graph Database", "Graph Databases"} & set(nodes[0]["aliases"]))
        self.assertEqual(nodes[0]["d"], "from b", "missing description taken from a duplicate")
        path_ok = self.q("MATCH (p {node_id: 'cx-p'})-[:USES_TOOL]->(g)<-[:COVERS_TECHNOLOGY]-(:Topic)<-[:HAS_TOPIC]-(e {node_id: 'cx-e'}) "
                         "RETURN count(*) AS c")[0]["c"]
        self.assertEqual(path_ok, 1, "project and episode now meet at one node")
        self.assertEqual(self.q("MATCH (g)-[r]-(g) RETURN count(r) AS c")[0]["c"], 0, "no self-loops")

        backups = sorted(f for f in os.listdir(os.path.join(ROOT, "logs")) if f.startswith("vocab_consolidation_backup_"))
        self.cv.rollback(os.path.join(ROOT, "logs", backups[-1]))
        back = self.q("MATCH (n {tenant_id: $t}) WHERE toLower(n.name) STARTS WITH 'graph database' RETURN n.node_id AS id")
        self.assertEqual(sorted(r["id"] for r in back), ["cx-a", "cx-b", "cx-c"], "duplicates restored")
        self.assertEqual(self.q("MATCH ({node_id: 'cx-tp'})-[:COVERS_TECHNOLOGY]->(b {node_id: 'cx-b'}) RETURN count(*) AS c")[0]["c"], 1,
                         "links restored")

    def test_refuses_organization_tiers(self):
        with self.assertRaises(SystemExit):
            self.cv.plan("org_3E0FtIXiFM6DHwXg05sEVvq2mi0")


if __name__ == "__main__":
    unittest.main()
