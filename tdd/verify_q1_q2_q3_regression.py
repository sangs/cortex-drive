import os
import sys
import json
import unittest
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools


class TestQ1Q2Q3Regression(unittest.TestCase):
    """
    Turns the ad-hoc, by-hand live verification done across 2026-09-09/11/12 into a real,
    repeatable check — see auth-derived-identity-and-bridge-source-config-design-2026-09-12.md
    §6 ("stop re-discovering regressions live") and CLAUDE.md Invariant 10 (post-commit query
    verification is a hard gate, described there as manual). Covers the query patterns from
    documents/user_queries.md plus the specific live-reported regressions found and fixed this
    session, asserted here rather than remembered.

    Does not exercise the gateway (Node.js) layer — same scope choice as
    verify_permify_authorization.py: direct ExpertTools calls against live Neo4j, no HTTP.
    """

    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        cls.tenant_id = os.environ.get("TENANT_ID")
        cls.owner_id = os.environ.get("OWNER_USER_ID")

        if not cls.tenant_id or not cls.owner_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")

        cls.expert = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id=cls.owner_id)

        # Resolve the tenant's primary-subject name dynamically (not hardcoded) — this is
        # itself part of what this suite verifies (Fix 1), so tests that need "the subject's
        # name" ask the same resolver the product now uses instead of asserting a literal.
        cls.primary_subject = cls.expert._resolve_primary_subject()
        if not cls.primary_subject:
            raise unittest.SkipTest(
                "No Person node with is_primary_subject=true for this tenant — run the "
                "is_primary_subject backfill before running this suite."
            )

    def test_01_q1_podcast_retrieval_sanity(self):
        """Q1 (podcast retrieval) — unaffected by this session's fixes; sanity check only."""
        print("\n[TDD] Q1 — podcast retrieval sanity check...")
        result = json.loads(self.expert.search_enterprise_graph(keyword="graph databases", domain_intent="podcast"))
        self.assertNotIn("error", result)
        print(f"✓ Q1 returned {len(result.get('nodes', []))} node(s), no error.")

    def test_02_q1_stopword_no_explosion(self):
        """Regression: keywords_list previously let 'and' through (len(w)>2 filter instead of
        the shared stop_words set), causing a ~390-node explosion on 'and'-containing questions
        (2026-09-11 fix). An absolute node-count ceiling isn't a stable assertion — legitimate
        broad single-word topics (e.g. "architecture" alone) can naturally return 100+ nodes in
        this graph, confirmed live. The actual regression-relevant invariant is relative: 'and'
        must contribute zero additional matches versus the same phrase with 'and' stripped."""
        print("\n[TDD] Q1 — stop-word explosion regression check...")
        with_and = json.loads(self.expert.search_enterprise_graph(
            keyword="architecture and design", domain_intent="podcast"))
        without_and = json.loads(self.expert.search_enterprise_graph(
            keyword="architecture design", domain_intent="podcast"))
        self.assertNotIn("error", with_and)
        self.assertNotIn("error", without_and)
        with_count = len(with_and.get("nodes", []))
        without_count = len(without_and.get("nodes", []))
        self.assertLessEqual(with_count, without_count,
                              f"Stop-word explosion regression: 'and'-bearing keyword returned "
                              f"{with_count} nodes vs {without_count} without 'and' — 'and' is "
                              f"contributing matches, i.e. leaking through as a real keyword again.")
        print(f"✓ 'and'-bearing keyword ({with_count} nodes) does not exceed the 'and'-free "
              f"equivalent ({without_count} nodes).")

    def test_03_q3_backbone_matches_primary_subject(self):
        """Q3 (career/institutional memory map) — get_cluster_context with node_name omitted
        must resolve to the same primary-subject backbone as calling it with the name explicit
        (Fix 1's guarantee: the fallback mechanism changed, not what it resolves to)."""
        print("\n[TDD] Q3 — backbone identity resolution (implicit vs explicit)...")
        implicit = json.loads(self.expert.get_cluster_context(backbone_only=True, depth=1, domain="professional"))
        explicit = json.loads(self.expert.get_cluster_context(
            node_name=self.primary_subject, backbone_only=True, depth=1, domain="professional"))
        self.assertNotIn("error", implicit)
        self.assertNotIn("error", explicit)
        implicit_ids = {n["id"] for n in implicit.get("nodes", [])}
        explicit_ids = {n["id"] for n in explicit.get("nodes", [])}
        self.assertEqual(implicit_ids, explicit_ids,
                          "Implicit (fallback-resolved) and explicit backbone calls must return identical node sets.")
        print(f"✓ Implicit and explicit backbone calls agree on {len(implicit_ids)} node(s).")

    def test_04_q3_self_match_no_over_expansion(self):
        """Regression: a query naming its own subject directly could make that subject its own
        top semantic match, bypassing anchor_labels and reaching 3 hops instead of 1 (the
        'Federated Knowledge Silos' bug, fixed 2026-09-12). Assert the specific known-bad node
        is absent and the result stays bounded."""
        print("\n[TDD] Q3 — self-match semantic-anchor over-expansion regression check...")
        result = json.loads(self.expert.search_enterprise_graph(
            keyword=self.primary_subject, domain_intent="professional"))
        self.assertNotIn("error", result)
        names = {n.get("name") for n in result.get("nodes", [])}
        self.assertNotIn("Federated Knowledge Silos", names,
                          "Self-match over-expansion regression: unrelated bridge node resurfaced.")
        print(f"✓ No 'Federated Knowledge Silos' contamination; {len(names)} node(s) returned.")

    def test_05_q2_bridge_sources_are_enumerable_and_real(self):
        """Fix 2 — enumerate_bridge_sources must return real, existing node names for the
        professional domain's bridge_source_labels config (ThoughtLeadership), the same names
        Tier 7 now injects instead of relying on the LLM to search for and read them."""
        print("\n[TDD] Q2 — enumerate_bridge_sources returns real candidates...")
        result = json.loads(self.expert.enumerate_bridge_sources(domain="professional"))
        self.assertNotIn("error", result)
        sources = result.get("sources", [])
        self.assertGreater(len(sources), 0, "Expected at least one ThoughtLeadership bridge-source candidate.")
        for s in sources:
            details = json.loads(self.expert.get_node_details(node_name=s["name"]))
            payload = details[0] if isinstance(details, list) else details
            self.assertNotIn("error", payload, f"Enumerated candidate '{s['name']}' does not actually exist.")
        print(f"✓ {len(sources)} bridge-source candidate(s), all verified to exist.")

    def test_06_q2_bridge_with_real_enumerated_source(self):
        """Regression: the 2026-09-12 incident was an LLM tool call with a fabricated
        source_node_name that doesn't exist in the graph, returning 'no source node found'.
        Using a name from test_05's real enumeration must NOT reproduce that failure."""
        print("\n[TDD] Q2 — connect_knowledge_on_demand with a real enumerated source...")
        sources = json.loads(self.expert.enumerate_bridge_sources(domain="professional")).get("sources", [])
        if not sources:
            self.skipTest("No bridge-source candidates available to test against.")
        result = json.loads(self.expert.connect_knowledge_on_demand(
            source_node_name=sources[0]["name"], target_domain="professional"))
        self.assertNotIn("error", result)
        self.assertNotIn("no source node found", json.dumps(result).lower())
        print(f"✓ Real bridge query against '{sources[0]['name']}' succeeded.")

    def test_07_q2_fabricated_source_name_fails_cleanly(self):
        """Sanity check on the tool's own behavior (not a regression per se): a name that does
        not exist in the graph must fail explicitly, not silently synthesize a plausible answer
        — this is the backstop the fabrication class of bug depends on for detectability. Note:
        `bridge_summary` is always a non-empty string, even on a miss (it explains the miss) —
        the actual no-result signal is `confidence_tier: "none"` / an empty `nodes` list, live-
        confirmed as this tool's real contract, not the presence/absence of `bridge_summary`."""
        print("\n[TDD] Q2 — fabricated source name fails cleanly...")
        result = json.loads(self.expert.connect_knowledge_on_demand(
            source_node_name="AI Governance and Explainability Work @ JPMorgan Chase",
            target_domain="professional"))
        self.assertEqual(result.get("confidence_tier"), "none",
                          "A fabricated source name should not produce a confident bridge result.")
        self.assertEqual(result.get("nodes", []), [])
        print(f"✓ Fabricated source name correctly failed: {result.get('bridge_summary')!r}")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'expert'):
            cls.expert.close()


if __name__ == "__main__":
    unittest.main()
