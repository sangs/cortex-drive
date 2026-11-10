"""
Bridges v2 (cross-domain discovery design 2026-11-09 §4.3, Phase 1b).

- Unit: ranking (specificity, length decay, similarity and hub-connector penalties, diversification) and path
  reconstruction. No database.
- Live, read-only (owner graph from .env): the demo bridges appear; no path walks through a hub or through
  SYSTEM/PUBLIC vocabulary; at most one similarity link per path; the talk → author path is collapsed (P4);
  a member with an empty allowlist sees only SYSTEM/PUBLIC nodes (security on every hop); within the time budget.
- Live, TEST TENANT (writes, cleaned up before and after; no Permify): a synthetic hub with 5,000 links is
  reached and used as the last connector only, its degree is counted only up to the threshold + 1, and the
  one-hop query's database hits stay bounded (PROFILE).

    .venv/bin/python -m unittest tests.mcp_server.test_bridges_v2 -v
"""
import json
import math
import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))

import domain_registry as reg  # noqa: E402
from schema_guard import SEED_BUILTIN_VOCABULARY_LABELS, SIMILARITY_RELATIONSHIPS  # noqa: E402
from expert_tools import ExpertTools  # noqa: E402

HUB = reg.BRIDGE_HUB_DEGREE_THRESHOLD


def spec(d):
    return 1 / math.log(2 + d)


class RankingTest(unittest.TestCase):
    def info(self, **degrees):
        return {k: {"degree": v, "is_hub": v > HUB} for k, v in degrees.items()}

    def test_specific_endpoint_beats_generic_one(self):
        ni = self.info(s=1, a=2, b=20)
        r = ExpertTools._rank_bridge_paths({"a": (["s", "a"], ["R"], False), "b": (["s", "b"], ["R"], False)}, ni)
        self.assertEqual(list(r), ["a", "b"])

    def test_length_decay_and_connector_specificity(self):
        ni = self.info(s=1, a=3, c=3, t=3)
        r = ExpertTools._rank_bridge_paths({"a": (["s", "a"], ["R"], False),
                                            "t": (["s", "c", "t"], ["R", "R"], False)}, ni)
        self.assertEqual(list(r), ["a", "t"])

    def test_similarity_and_hub_connector_penalties(self):
        ni = self.info(s=1, c=3, h=HUB + 1, t1=3, t2=3, t3=3)
        paths = {"t1": (["s", "c", "t1"], ["R", "R"], False),
                 "t2": (["s", "c", "t2"], ["IS_SIMILAR", "R"], True),
                 "t3": (["s", "h", "t3"], ["R", "R"], False)}
        r = ExpertTools._rank_bridge_paths(paths, ni)
        self.assertEqual(list(r)[0], "t1")
        # similarity: 0.5 × same path; hub connector: 0.25 × spec(26)/spec(3) — both below t1
        self.assertLess(list(r).index("t1"), list(r).index("t2"))
        self.assertLess(list(r).index("t1"), list(r).index("t3"))

    def test_diversification_moves_repeated_connectors_back(self):
        ni = self.info(s=1, c=2, d=9, t1=2, t2=2, t3=9)
        paths = {"t1": (["s", "c", "t1"], ["R", "R"], False),
                 "t2": (["s", "c", "t2"], ["R", "R"], False),   # same connector as t1
                 "t3": (["s", "d", "t3"], ["R", "R"], False)}   # worse score, fresh connector
        self.assertEqual(list(ExpertTools._rank_bridge_paths(paths, ni)), ["t1", "t3", "t2"])

    def test_weights_ascend_in_rank_order(self):
        ni = self.info(s=1, a=2, b=5, c=8)
        r = ExpertTools._rank_bridge_paths({k: (["s", k], ["R"], False) for k in "abc"}, ni)
        weights = [w for w, _, _ in r.values()]
        self.assertEqual(weights, sorted(weights))

    def test_path_reconstruction(self):
        parent = {"a": ("s", "R1", False, 1), "b": ("a", "IS_SIMILAR", True, 2)}
        self.assertEqual(ExpertTools._bridge_path(parent, "b"), (["s", "a", "b"], ["R1", "IS_SIMILAR"], True))


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class LiveBridgesTest(unittest.TestCase):
    """Read-only, internal (whole-tenant) call on the founder graph."""

    @classmethod
    def setUpClass(cls):
        cls.tools = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""))
        cls.tools._exec_query("RETURN 1")   # open the connection first: production keeps a warm driver
        cls.cache = {}

    @classmethod
    def tearDownClass(cls):
        cls.tools.close()

    def node(self, cypher):
        rec = self.tools._exec_query(cypher + " RETURN n.node_id AS id LIMIT 1").records
        if not rec:
            self.skipTest(f"no node for {cypher}")
        return rec[0]["id"]

    def bridges(self, cypher, tools=None):
        key = (cypher, id(tools))
        if key not in self.cache:
            t0 = time.monotonic()
            out = json.loads((tools or self.tools).connect_knowledge_on_demand(
                source_node_id=self.node(cypher), target_domains=["auto"]))
            out["_ms"] = (time.monotonic() - t0) * 1000
            self.cache[key] = out
        return self.cache[key]

    def node_facts(self, ids):
        rows = self.tools._exec_query(
            f"""MATCH (n) WHERE elementId(n) IN $ids
                RETURN elementId(n) AS id, labels(n) AS labels, n.tenant_id AS tenant,
                       COUNT {{ (n)-[r]-(m) WHERE NOT type(r) IN $sim AND NOT m:{reg.get_bridge_label_string()} }} AS sdeg""",
            ids=list(ids), sim=SIMILARITY_RELATIONSHIPS).records
        return {r["id"]: r for r in rows}

    SOURCES = [
        "MATCH (n:Technology) WHERE toLower(n.name) = 'neo4j'",
        "MATCH (n:WebsiteSource {name: 'Apache Iceberg'})",
        "MATCH (n:Episode) WHERE n.name CONTAINS 'Model Context'",
        "MATCH (n:Project {name: 'Cortex-Drive'})",
        "MATCH (n:ThoughtLeadership) WHERE coalesce(n.name, n.title) STARTS WITH 'InfoQ'",
    ]

    def test_demo_bridges_from_neo4j(self):
        names = {n["name"] for n in self.bridges(self.SOURCES[0])["nodes"] if n.get("bridge_reason")}
        self.assertIn("Global Hackathons @ JPMorgan Chase", names)
        self.assertIn("Cortex-Drive", names)

    def test_no_path_walks_through_a_hub_or_vocabulary(self):
        vocab = set(SEED_BUILTIN_VOCABULARY_LABELS)
        for src in self.SOURCES:
            out = self.bridges(src)
            links = out["virtual_links"]
            nodes = {n["id"]: n for n in out["nodes"]}
            # rebuild each path: links are emitted hop by hop from the source
            outgoing = {}
            for l in links:
                outgoing.setdefault(l["source"], set()).add(l["target"])
            connectors = {nid for nid, n in nodes.items() if n.get("is_bridge")}
            facts = self.node_facts(connectors)
            for c in connectors:
                f = facts[c]
                self.assertFalse(f["tenant"] in ("SYSTEM", "PUBLIC") and set(f["labels"]) & vocab,
                                 f"{src}: vocabulary node used as a connector")
                if f["sdeg"] > HUB:
                    # a hub may only be the last connector: everything after it is an endpoint
                    for nxt in outgoing.get(c, ()):
                        self.assertFalse(nodes[nxt].get("is_bridge"), f"{src}: walked through a hub")

    def test_at_most_one_similarity_link_per_path(self):
        for src in self.SOURCES:
            for n in self.bridges(src)["nodes"]:
                if n.get("bridge_reason"):
                    rels = n["bridge_reason"].replace("Connected via: ", "").split(" → ")
                    self.assertLessEqual(sum(r in SIMILARITY_RELATIONSHIPS for r in rels),
                                         reg.BRIDGE_MAX_SIMILARITY_LINKS_PER_PATH, (src, n["name"]))

    def test_talk_to_author_is_collapsed(self):
        out = self.bridges(self.SOURCES[4])
        self.assertTrue(out["search"]["same_author"], out["bridge_summary"])
        author = out["search"]["same_author"][0]
        self.assertNotIn(author, {n["name"] for n in out["nodes"] if n.get("bridge_reason") or n.get("is_bridge")})
        self.assertIn(author, out["bridge_summary"])

    def test_within_budget_and_bounded(self):
        for src in self.SOURCES:
            out = self.bridges(src)
            self.assertLessEqual(out["search"]["hops"], reg.BRIDGE_DEEPENING_MAX_HOPS)
            self.assertLess(out["_ms"], 2000, src)

    def test_time_budget_gives_a_labelled_partial_result(self):
        from unittest import mock
        with mock.patch.object(reg, "BRIDGE_TIME_BUDGET_MS", 0):
            out = json.loads(self.tools.connect_knowledge_on_demand(source_node_id=self.node(self.SOURCES[0]),
                                                                    target_domains=["auto"]))
        self.assertTrue(out["search"]["partial"])
        self.assertEqual(out["search"]["hops"], 1, "the first hop always runs")
        self.assertIn("Partial result", out["bridge_summary"])

    def test_member_sees_only_what_they_may(self):
        member = ExpertTools(tenant_id=os.environ.get("TENANT_ID", ""), requesting_user_id="user_test_member_no_shares",
                             allowed_ids=[])
        try:
            out = self.bridges(self.SOURCES[0], tools=member)
            ids = {n["id"] for n in out["nodes"]}
            facts = self.node_facts(ids)
            hidden = [facts[i]["tenant"] for i in ids if facts[i]["tenant"] not in ("SYSTEM", "PUBLIC")]
            self.assertEqual(hidden, [], "member with no shares saw org nodes")
        finally:
            member.close()


@unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
class SyntheticHubTest(unittest.TestCase):
    """TEST TENANT only: source → hub (5,000 links) → target; source → a → b → c (chain)."""
    LEAVES = 5000

    @classmethod
    def setUpClass(cls):
        from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant
        use_test_tenant()
        cls.tenant = TEST_TENANT_ID
        cls.cleanup = staticmethod(cleanup_test_tenant)
        cls.tools = ExpertTools(tenant_id=TEST_TENANT_ID)
        cls.cleanup(cls.tools.driver)
        cls.tools.driver.execute_query(
            """
            CREATE (s:Project {name: 'cx-src', node_id: 'cx-src', tenant_id: $t})
            CREATE (h:Person {name: 'cx-hub', node_id: 'cx-hub', tenant_id: $t})
            CREATE (e:Episode {name: 'cx-episode', node_id: 'cx-episode', tenant_id: $t})
            CREATE (x:Episode {name: 'cx-beyond', node_id: 'cx-beyond', tenant_id: $t})
            CREATE (s)-[:MENTIONS]->(h), (h)-[:GUEST_ON]->(e), (e)-[:HAS_TOPIC]->(:Topic {name: 'cx-topic', node_id: 'cx-topic', tenant_id: $t})
            CREATE (e)-[:HAS_EPISODE]->(x), (e)-[:HAS_EPISODE]->(:Podcast {name: 'cx-podcast', node_id: 'cx-podcast', tenant_id: $t})
            WITH h
            UNWIND range(1, $n) AS i
            CREATE (h)-[:HAS_SKILL]->(:Skill {name: 'cx-leaf-' + i, node_id: 'cx-leaf-' + i, tenant_id: $t})
            """, t=cls.tenant, n=cls.LEAVES)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.cleanup(cls.tools.driver)
        finally:
            cls.tools.close()

    def eid(self, node_id):
        return self.tools._exec_query("MATCH (n {node_id: $i, tenant_id: $t}) RETURN elementId(n) AS e",
                                      i=node_id, t=self.tenant).records[0]["e"]

    def test_hub_degree_is_capped_and_hub_is_last_connector(self):
        out = json.loads(self.tools.connect_knowledge_on_demand(source_node_id="cx-src", target_domains=["podcast"]))
        names = {n["name"]: n for n in out["nodes"]}
        self.assertIn("cx-episode", names, out.get("bridge_summary"))       # reached through the hub
        self.assertIn("MENTIONS → GUEST_ON", names["cx-episode"]["bridge_reason"])   # hub as the last connector
        self.assertNotIn("cx-beyond", names, "walked through a hub")         # two steps past the hub
        self.assertNotIn("cx-podcast", names, "walked through a hub")

    def test_one_hop_from_the_hub_is_bounded(self):
        query_rows = self.tools._bridge_bfs_layer([{"id": self.eid("cx-hub"), "sim_used": False}], [])
        self.assertLessEqual(len(query_rows), reg.BRIDGE_NEIGHBOURS_PER_NODE_MAX)
        hub_row = self.tools._bridge_bfs_layer([{"id": self.eid("cx-src"), "sim_used": False}], [])
        self.assertEqual(max(r["sdeg"] for r in hub_row), HUB + 1, "degree counted only up to threshold + 1")

    def test_profile_db_hits_bounded(self):
        hub = self.eid("cx-src")
        bl = reg.get_bridge_label_string()
        sec_b, sec_x = self.tools._get_security_clause("b"), self.tools._get_security_clause("x")
        result = self.tools.driver.execute_query(
            f"""PROFILE
            MATCH (a) WHERE elementId(a) = $id
            CALL (a) {{ MATCH (a)-[r]-(b) WHERE NOT b:{bl} AND ({sec_b}) RETURN r, b LIMIT $per_node }}
            WITH r, b
            CALL (b) {{ MATCH (b)-[r2]-(x) WHERE NOT type(r2) IN $sim AND NOT x:{bl} AND ({sec_x})
                    WITH x LIMIT $cap RETURN count(x) AS sdeg }}
            RETURN count(*) AS rows""",
            id=hub, per_node=reg.BRIDGE_NEIGHBOURS_PER_NODE_MAX, sim=SIMILARITY_RELATIONSHIPS, cap=HUB + 1,
            tenant_id=self.tenant)

        def hits(p):
            return p.get("dbHits", 0) + sum(hits(c) for c in p.get("children", []))
        total = hits(result.summary.profile)
        print(f"\n[PROFILE] one hop from the source of a {self.LEAVES}-link hub: {total} db hits")
        self.assertLess(total, self.LEAVES, "counting the hub's degree read all of its links")


if __name__ == "__main__":
    unittest.main()
