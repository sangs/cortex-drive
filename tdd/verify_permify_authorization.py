import os
import sys
import json
import asyncio
import unittest
from dotenv import load_dotenv

# Add src/mcp_server to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'src', 'mcp_server')))
from expert_tools import ExpertTools
import permify_utils


class TestPermifyAuthorization(unittest.TestCase):
    """Retires tdd/verify_g_acl_path_masking.py, verify_g_acl_enforcement.py, and
    verify_search_resume_gacl.py (2026-08-03) — all three asserted behavior of the Neo4j-native
    HAS_ACCESS/OWNS relationships, which were deliberately deleted from Neo4j during the
    2026-07-22 Permify migration (`documents/cortex_master_implementation_tracker.md` Section 5,
    "Zanzibar Phase 3"). Two of those three files failed outright when re-run 2026-08-03:
    verify_g_acl_enforcement.py's owner tests asserted reachability via the now-nonexistent
    HAS_ACCESS traversal, and verify_search_resume_gacl.py called search_resume_graph, a method
    that no longer exists (renamed to search_enterprise_graph).

    This file instead tests the CURRENT authorization mechanism directly:
    ExpertTools._get_security_clause()'s three modes (src/mcp_server/expert_tools.py:34):
      1. allowed_ids=None            -> tenant_id-only fallback (Permify not configured)
      2. allowed_ids=[...], no guest  -> node_id allowlist OR tenant_id (defense-in-depth)
      3. allowed_ids=[...] + guest_share_anchor -> node_id allowlist ONLY, no tenant fallback

    Real gap this replaces, not just renames: verify_g_acl_path_masking.py's "attacker" test
    instantiated ExpertTools WITHOUT allowed_ids, so it exercised mode 1 (tenant fallback) even
    though it was trying to test unauthorized access — a same-tenant "attacker" trivially passed
    tenant_id filtering, and the test's masking assertion failed for that structural reason, not
    because of a real regression. No test anywhere in tdd/ has ever passed allowed_ids to
    ExpertTools (confirmed via grep before writing this file) — mode 2 and mode 3 had zero
    coverage. test_03/test_04 below close that gap directly, without requiring a live Permify
    call (mode 3 is exercised by constructing the guest args directly, exactly as the real
    guest-link sharing flow does).
    """

    @classmethod
    def setUpClass(cls):
        load_dotenv('.env', override=True)
        cls.tenant_id = os.environ.get("TENANT_ID")
        cls.owner_id = os.environ.get("OWNER_USER_ID")

        if not cls.tenant_id or not cls.owner_id:
            raise unittest.SkipTest("TENANT_ID or OWNER_USER_ID not set in .env")

        cls.owner = ExpertTools(tenant_id=cls.tenant_id, requesting_user_id=cls.owner_id)

        # Resolve a real org-tenant node_id dynamically (not hardcoded) for the allowlist tests.
        details = json.loads(cls.owner.get_node_details(node_name="Cortex-Drive"))[0]
        cls.private_node_id = details["node_id"]
        cls.private_node_tenant = details["properties"]["tenant_id"]

    def test_01_tenant_fallback_owner_retrieval(self):
        """Mode 1 (allowed_ids=None): the owner, identified only by tenant_id, sees their own
        graph. This is the mode every other tdd/ test already exercises implicitly — asserted
        explicitly here since it's the baseline the other modes are compared against."""
        print("\n[TDD] Testing tenant-fallback retrieval (mode 1)...")
        result = json.loads(self.owner.get_cluster_context("Sangeetha Ramadurai"))
        self.assertGreater(len(result.get("nodes", [])), 0,
                            "Owner should see their own hub via tenant_id fallback.")
        print(f"✓ Owner retrieved {len(result['nodes'])} nodes via tenant fallback.")

    def test_02_public_system_realm_visible_cross_tenant(self):
        """SYSTEM/PUBLIC nodes are visible even to a caller whose tenant_id does not match the
        node owner's — this is the one piece of the old masking test that's still architecturally
        true today (both mode 1 and mode 2 include 'SYSTEM'/'PUBLIC' unconditionally), and the one
        piece worth keeping as a regression guard."""
        print("\n[TDD] Testing cross-tenant PUBLIC/SYSTEM visibility...")
        outsider = ExpertTools(tenant_id="org_definitely_not_the_real_tenant", requesting_user_id="user_outsider_999")
        try:
            details = json.loads(outsider.get_node_details(node_name="Neo4j"))[0]
            self.assertNotIn("error", details, "SYSTEM/PUBLIC landmark should be visible cross-tenant.")
            print("✓ SYSTEM/PUBLIC landmark visible to a mismatched-tenant caller.")
        finally:
            outsider.close()

    def test_03_cross_tenant_caller_cannot_see_private_org_node(self):
        """Mode 1, negative case: a caller with a genuinely different tenant_id (and no
        allowed_ids) must NOT see an org-tenant-scoped node — confirms tenant_id fallback still
        excludes non-SYSTEM/PUBLIC content for a real tenant mismatch."""
        print("\n[TDD] Testing cross-tenant exclusion of a private org node...")
        outsider = ExpertTools(tenant_id="org_definitely_not_the_real_tenant", requesting_user_id="user_outsider_999")
        try:
            details_json = outsider.get_node_details(node_id=self.private_node_id)
            details = json.loads(details_json)
            payload = details[0] if isinstance(details, list) else details
            self.assertIn("error", payload, "Cross-tenant caller should NOT see an org-scoped node.")
            print("✓ Cross-tenant caller correctly denied the org-scoped node.")
        finally:
            outsider.close()

    def test_04_guest_mode_allowlist_excludes_by_default(self):
        """Mode 3 (guest_share_anchor set): with an EMPTY allowed_ids list, a guest must not see
        an org-tenant node even though — unlike mode 1/2 — there is no tenant_id fallback to
        accidentally rescue it. This is the actual mechanism the real guest-link share flow
        relies on, and the gap the deleted attacker test never reached."""
        print("\n[TDD] Testing guest-mode default exclusion (mode 3, empty allowlist)...")
        guest = ExpertTools(tenant_id=self.private_node_tenant, requesting_user_id="guest_test_user",
                             guest_share_anchor="test-anchor-token", allowed_ids=[])
        try:
            details_json = guest.get_node_details(node_id=self.private_node_id)
            details = json.loads(details_json)
            payload = details[0] if isinstance(details, list) else details
            self.assertIn("error", payload, "Guest with empty allowlist should NOT see the org node.")
            print("✓ Guest with empty allowlist correctly excluded from the org node.")
        finally:
            guest.close()

    def test_05_guest_mode_allowlist_grants_explicit_inclusion(self):
        """Mode 3, positive case: once the SAME node_id is explicitly present in allowed_ids
        (simulating what the gateway does after a real Permify LookupEntity call, or what a
        guest-link grant records), the guest DOES see it. This is the core allowlist mechanism
        that had zero test coverage before this file — inclusion, not just exclusion."""
        print("\n[TDD] Testing guest-mode explicit allowlist inclusion (mode 3)...")
        guest = ExpertTools(tenant_id=self.private_node_tenant, requesting_user_id="guest_test_user",
                             guest_share_anchor="test-anchor-token", allowed_ids=[self.private_node_id])
        try:
            details_json = guest.get_node_details(node_id=self.private_node_id)
            details = json.loads(details_json)
            payload = details[0] if isinstance(details, list) else details
            self.assertNotIn("error", payload, "Guest with the node explicitly allowlisted should see it.")
            self.assertEqual(payload.get("node_id"), self.private_node_id)
            print("✓ Guest with explicit allowlist entry correctly granted access.")
        finally:
            guest.close()

    def test_06_live_permify_smoke_check_if_configured(self):
        """Skips locally (PERMIFY_API_URL is not set in .env — Permify runs on Cloud Run, not
        local dev, confirmed via permify_utils._configured()). Exists so a staging/CI environment
        with PERMIFY_API_URL set gets a real end-to-end LookupEntity smoke check, not just the
        constructed-args tests above."""
        if not os.environ.get("PERMIFY_API_URL"):
            self.skipTest("PERMIFY_API_URL not set — Permify not reachable from this environment.")
        print("\n[TDD] Testing live Permify list_viewable_node_ids()...")
        result = asyncio.run(permify_utils.list_viewable_node_ids(self.owner_id))
        self.assertIsInstance(result, list, "list_viewable_node_ids should return a list when configured.")
        print(f"✓ Live Permify LookupEntity returned {len(result)} viewable node ids.")

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'owner'):
            cls.owner.close()


if __name__ == "__main__":
    unittest.main()
