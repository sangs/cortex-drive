"""
Shared test tenant for every test that writes to Neo4j (user decision, 2026-10-06).

There is one Neo4j Aura instance, so isolation is by tenant: tests write ONLY under
TEST_TENANT_ID and delete everything under it when they finish, even on failure. Tests never
write Permify/OpenFGA tuples (PERMIFY_API_URL is removed from the environment).

Usage:
    from tests.test_tenant import TEST_TENANT_ID, use_test_tenant, cleanup_test_tenant, count_test_tenant_nodes
    use_test_tenant()          # call BEFORE importing ingestion/schema modules
    ...
    cleanup_test_tenant(driver)   # in tearDown / tearDownClass
"""
import os

# Distinct from the legacy `test_org_123` / `test-tenant` values: verified 0 nodes before first use
# (2026-10-06), so cleanup can only ever delete what these tests created.
TEST_TENANT_ID = "cortex-test-tenant"
_SAFE_PREFIX = "cortex-test-"


def use_test_tenant() -> str:
    """Point schema validation at the test tenant and disable Permify writes."""
    os.environ["TEST_TENANT"] = TEST_TENANT_ID     # schema_guard's tenant validator accepts TEST_TENANT
    os.environ.pop("PERMIFY_API_URL", None)        # IngestionEngine skips Permify (and the Redis perm_version bump)
    return TEST_TENANT_ID


def _check(tenant_id: str) -> None:
    if not tenant_id.startswith(_SAFE_PREFIX):
        raise RuntimeError(f"refusing to clean up non-test tenant {tenant_id!r}")


def count_test_tenant_nodes(driver, tenant_id: str = TEST_TENANT_ID) -> int:
    _check(tenant_id)
    with driver.session() as session:
        return session.run("MATCH (n {tenant_id: $t}) RETURN count(n) AS c", t=tenant_id).single()["c"]


def cleanup_test_tenant(driver, tenant_id: str = TEST_TENANT_ID) -> int:
    """Delete every node (and its relationships) under the test tenant. Returns the count deleted."""
    _check(tenant_id)
    with driver.session() as session:
        return session.run("MATCH (n {tenant_id: $t}) DETACH DELETE n RETURN count(n) AS c",
                           t=tenant_id).single()["c"]
