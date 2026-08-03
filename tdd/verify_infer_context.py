import os
import sys
import json
import inspect
import unittest
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools
from domain_registry import (
    BRIDGE_LABELS,
    CONTEXT_PER_RELATION_CAP,
    CONTEXT_RELATION_GROUP_CAP,
)


class TestInferContextOnDemand(unittest.TestCase):
    """Covers the infer_context_on_demand tool (2026-08-03) and its combined-narrative
    wiring into get_node_details. See documents/architecture/node-context-inference-2026-08-03.md."""

    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        cls.tenant_id = os.environ.get("TENANT_ID")
        cls.user_id = os.environ.get("OWNER_USER_ID")

        if not cls.tenant_id or not cls.user_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")

        cls.expert = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id=cls.user_id)
        cls.attacker = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id="user_malicious_attacker_999")
        # A node expected to have some structural neighbors — the career identity anchor.
        cls.probe_node = "Sangeetha Ramadurai"

    def test_01_bridge_label_exclusion(self):
        """ASSERT: no bridge-label neighbor (PreparatoryNote/Chunk/Source/ReferenceLink/
        __MetaContext__) ever surfaces in context_facts or context_summary (AP-19)."""
        print("\n[TDD] Testing bridge-label exclusion in infer_context_on_demand...")
        result = json.loads(self.expert.infer_context_on_demand(node_name=self.probe_node))
        self.assertIsNotNone(result.get("node"), f"Probe node '{self.probe_node}' not found — adjust probe_node.")

        leaked = []
        for group in result.get("context_facts", []):
            for n in group.get("neighbors", []):
                if n.get("type") in BRIDGE_LABELS:
                    leaked.append(f"{n['name']} ({n['type']})")
        self.assertEqual(len(leaked), 0, f"BRIDGE-LABEL LEAK in context_facts: {leaked}")

        summary = result.get("context_summary", "")
        for label in BRIDGE_LABELS:
            self.assertNotIn(f"({label}", summary, f"Bridge label '{label}' leaked into context_summary text.")
        print("✓ Bridge-label exclusion asserted.")

    def test_02_per_group_and_group_caps_respected(self):
        """ASSERT: no relationship group exceeds CONTEXT_PER_RELATION_CAP neighbors, and no
        more than CONTEXT_RELATION_GROUP_CAP groups are returned, regardless of actual degree."""
        print("\n[TDD] Testing structural-fact caps...")
        result = json.loads(self.expert.infer_context_on_demand(node_name=self.probe_node))
        facts = result.get("context_facts", [])
        self.assertLessEqual(len(facts), CONTEXT_RELATION_GROUP_CAP,
                              f"Returned {len(facts)} groups, exceeds CONTEXT_RELATION_GROUP_CAP={CONTEXT_RELATION_GROUP_CAP}")
        for group in facts:
            self.assertLessEqual(len(group["neighbors"]), CONTEXT_PER_RELATION_CAP,
                                  f"Group {group['relationship']}/{group['direction']} returned "
                                  f"{len(group['neighbors'])} neighbors, exceeds CONTEXT_PER_RELATION_CAP={CONTEXT_PER_RELATION_CAP}")
            # total_count is an honesty field — it must never be smaller than what's enumerated.
            self.assertGreaterEqual(group["total_count"], len(group["neighbors"]))
        print(f"✓ Caps respected across {len(facts)} group(s).")

    def test_03_determinism(self):
        """ASSERT: identical args, called twice, produce identical facts and summary —
        no randomness, no LLM call, no non-deterministic ordering."""
        print("\n[TDD] Testing determinism...")
        r1 = json.loads(self.expert.infer_context_on_demand(node_name=self.probe_node, query_context="career technology"))
        r2 = json.loads(self.expert.infer_context_on_demand(node_name=self.probe_node, query_context="career technology"))
        self.assertEqual(r1["context_summary"], r2["context_summary"], "context_summary not deterministic across calls.")
        self.assertEqual(r1["context_facts"], r2["context_facts"], "context_facts not deterministic across calls.")
        print("✓ Determinism asserted.")

    def test_04_sparse_and_none_tiers_use_viewer_relative_wording(self):
        """ASSERT: a node with zero visible facts renders 'sparse' wording that is
        viewer-relative ('visible in your authorized view'), never an absolute claim
        ('has no connections') — a genuine orphan and a permission-masked node must be
        indistinguishable at this layer. Also: an unresolvable node degrades to tier
        'none' without raising."""
        print("\n[TDD] Testing sparse/none tier wording and no-exception guarantee...")

        # (a) Pure rendering-contract check on _render_context_summary with an empty facts
        # list — deterministic, independent of live graph content.
        node_row = {"name": "Isolated Test Node", "labels": ["Concept"], "degree": 0}
        summary = self.expert._render_context_summary(node_row, [], set())
        self.assertIn("visible in your authorized view", summary)
        self.assertNotIn("has no connections", summary.lower())

        # (b) Unresolvable node -> tier "none", no exception.
        try:
            result = json.loads(self.expert.infer_context_on_demand(node_name="__definitely_not_a_real_node__xyz__"))
        except Exception as e:
            self.fail(f"infer_context_on_demand raised on unresolvable node: {e}")
        self.assertEqual(result["context_tier"], "none")
        self.assertIsNone(result["node"])
        print("✓ Sparse/none tier wording and no-exception guarantee asserted.")

    def test_05_get_node_details_combined_not_either_or(self):
        """ASSERT: get_node_details returns narratives/text AND context_summary TOGETHER
        for a node with both an authored note and visible structural neighbors — combined,
        not a fallback chain. Category nodes get neither."""
        print("\n[TDD] Testing combined narrative wiring in get_node_details...")
        # get_node_details wraps its single result in a list (existing contract — the
        # frontend does `Array.isArray(results) ? results[0] : ...`), so unwrap here too.
        details = json.loads(self.expert.get_node_details(node_name="Cortex-Drive"))[0]
        self.assertNotIn("error", details, f"get_node_details('Cortex-Drive') failed: {details}")

        has_narrative = bool(details.get("narratives"))
        has_context = bool(details.get("context_summary"))
        print(f"  narratives present: {has_narrative}, context_summary present: {has_context}")
        if has_narrative:
            self.assertTrue(has_context, "Authored narrative present but context_summary missing — "
                                          "should be combined, not either/or.")

        # Category nodes must get neither (structural nodes have no distinct narrative).
        cluster = json.loads(self.expert.get_cluster_context(self.probe_node, depth=2))
        categories = [n["name"] for n in cluster.get("nodes", []) if n.get("type") == "Category"]
        if categories:
            cat_details = json.loads(self.expert.get_node_details(node_name=categories[0]))[0]
            self.assertNotIn("context_summary", cat_details,
                              f"Category node '{categories[0]}' unexpectedly got context_summary.")
            print(f"✓ Category node '{categories[0]}' correctly excluded from inference.")
        else:
            print("  (no Category node found in probe cluster — skipping Category-exclusion check)")
        print("✓ Combined narrative wiring asserted.")

    def test_06_no_narrative_contamination(self):
        """ASSERT: context_summary text never appears inside narratives — guards the Q2
        writer's biographer prompt from narrating inferred facts as if authored."""
        print("\n[TDD] Testing narrative/context provenance separation...")
        details = json.loads(self.expert.get_node_details(node_name="Cortex-Drive"))[0]
        context_summary = details.get("context_summary")
        narratives = details.get("narratives") or []
        if context_summary and narratives:
            for n in narratives:
                self.assertNotIn(context_summary, n, "context_summary leaked verbatim into an authored narrative.")
            joined_narratives = "\n".join(narratives)
            self.assertNotIn(joined_narratives, context_summary, "An authored narrative leaked verbatim into context_summary.")
            print("✓ Provenance separation asserted (both present, neither contains the other).")
        else:
            print("  (no combined case available for this node — provenance separation only checkable when both exist)")

    def test_07_no_llm_call_in_layer(self):
        """ASSERT: infer_context_on_demand and its helpers contain zero LLM call sites —
        this layer computes facts only; phrasing happens downstream in the gateway."""
        print("\n[TDD] Testing no-LLM-call architectural constraint...")
        methods = [
            ExpertTools.infer_context_on_demand,
            ExpertTools._resolve_context_node,
            ExpertTools._collect_context_facts,
            ExpertTools._render_context_summary,
        ]
        forbidden = ["chat.completions", "openai.", "ChatCompletion"]
        for m in methods:
            src = inspect.getsource(m)
            for token in forbidden:
                self.assertNotIn(token, src, f"Forbidden LLM call token '{token}' found in {m.__name__}.")
        print("✓ No-LLM-call constraint asserted across all 4 methods.")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'expert'):
            cls.expert.close()
        if hasattr(cls, 'attacker'):
            cls.attacker.close()


if __name__ == "__main__":
    unittest.main()
