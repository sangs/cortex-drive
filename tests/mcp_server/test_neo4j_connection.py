"""
Neo4j connection factory (neo4j-connection-factory-design-2026-11-16.md, tracker S2-79).
- the only `GraphDatabase.driver(` in the code base is in neo4j_connection.py (one named legacy exception, below);
- trust store: certifi (default) | system | absolute PEM path; anything else refused;
- neo4j+s:// → neo4j:// + encrypted + trust store; +ssc refused; plain neo4j:// / bolt:// passed as is;
- one pool per process; failures classified (tls | auth | network | unavailable);
- live: the pinned certifi bundle verifies Aura's chain (skipped without NEO4J_* settings).

    .venv/bin/python -m unittest tests.mcp_server.test_neo4j_connection -v
"""
import glob
import os
import ssl
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
from neo4j import TrustCustomCAs, TrustSystemCAs  # noqa: E402
from neo4j.exceptions import AuthError, ServiceUnavailable  # noqa: E402
import neo4j_connection as nc  # noqa: E402
import domain_registry as reg  # noqa: E402

# Empty since S2-82 (2026-11-16): the last legacy script now uses the factory and the test tenant only.
LEGACY_EXCEPTIONS: set = set()


class LegacyYearsScriptTest(unittest.TestCase):
    """S2-82: scripts/migrate_geometric_years.py reads and writes only the shared test tenant."""

    def test_test_tenant_only(self):
        src = open(os.path.join(ROOT, "scripts", "migrate_geometric_years.py"), encoding="utf-8").read()
        src = src.split('"""', 2)[2]   # code only: the docstring describes the old queries
        self.assertIn("from tests.test_tenant import TEST_TENANT_ID", src)
        self.assertIn("create_driver()", src)
        self.assertNotIn("password", src.lower().replace("no credentials", ""))
        self.assertNotIn("--tenant", src, "no option to point the script at another tenant")
        for query in ("MATCH (n {tenant_id: $tenant})", "MATCH (y:Year {tenant_id: $tenant, created_by: $tag})"):
            self.assertIn(query, src)
        self.assertNotIn("MATCH (y:Year) DETACH DELETE", src)


class OneFactoryTest(unittest.TestCase):
    def test_no_driver_construction_elsewhere(self):
        offenders = []
        for path in glob.glob(os.path.join(ROOT, "**", "*.py"), recursive=True):
            rel = os.path.relpath(path, ROOT)
            if rel.startswith((".venv", "node_modules")) or "/node_modules/" in rel or rel in LEGACY_EXCEPTIONS:
                continue
            if rel in (os.path.join("src", "mcp_server", "neo4j_connection.py"), os.path.relpath(__file__, ROOT)):
                continue
            if rel.startswith(("src", "scripts", "tests")) and "GraphDatabase.driver(" in open(path, encoding="utf-8").read():
                offenders.append(rel)
        self.assertEqual(offenders, [], "create drivers with neo4j_connection.get_driver() / create_driver()")


class TrustTest(unittest.TestCase):
    def test_default_is_certifi(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NEO4J_TRUST", None)
            self.assertEqual(nc.trust_setting(), reg.NEO4J_TRUST_DEFAULT)
        self.assertEqual(reg.NEO4J_TRUST_DEFAULT, "certifi")

    def test_trust_values(self):
        import certifi
        self.assertIsInstance(nc.trusted_certificates("certifi"), TrustCustomCAs)
        self.assertIsInstance(nc.trusted_certificates("system"), TrustSystemCAs)
        self.assertIsInstance(nc.trusted_certificates(certifi.where()), TrustCustomCAs)
        for bad in ("", "Certifi", "relative/ca.pem", "/no/such/ca.pem", "anything"):
            with self.assertRaises(ValueError, msg=bad):
                nc.trusted_certificates(bad)

    def test_schemes(self):
        uri, kw = nc.driver_arguments("neo4j+s://abc.databases.neo4j.io", "certifi")
        self.assertEqual(uri, "neo4j://abc.databases.neo4j.io")
        self.assertTrue(kw["encrypted"])
        self.assertIsInstance(kw["trusted_certificates"], TrustCustomCAs)
        self.assertEqual(nc.driver_arguments("bolt+s://h:7687", "system")[0], "bolt://h:7687")
        self.assertEqual(nc.driver_arguments("neo4j://localhost:7687", "certifi"), ("neo4j://localhost:7687", {}))
        for bad in ("neo4j+ssc://h", "bolt+ssc://h", "http://h", "no-scheme"):
            with self.assertRaises(ValueError, msg=bad):
                nc.driver_arguments(bad, "certifi")

    def test_driver_built_with_explicit_settings(self):
        env = {"NEO4J_URI": "neo4j+s://abc.databases.neo4j.io", "NEO4J_USERNAME": "u", "NEO4J_PASSWORD": "p",
               "NEO4J_TRUST": "certifi"}
        with mock.patch.dict(os.environ, env), mock.patch.object(nc.GraphDatabase, "driver") as drv:
            nc.create_driver()
        args, kw = drv.call_args
        self.assertEqual(args[0], "neo4j://abc.databases.neo4j.io")
        self.assertEqual(kw["auth"], ("u", "p"))
        self.assertEqual(kw["max_connection_pool_size"], reg.NEO4J_MAX_POOL_SIZE)
        self.assertEqual(kw["liveness_check_timeout"], reg.NEO4J_LIVENESS_CHECK_S)
        self.assertTrue(kw["encrypted"])


class PoolTest(unittest.TestCase):
    def test_one_pool_per_process_recreated_on_settings_change(self):
        env = {"NEO4J_URI": "neo4j://a:7687", "NEO4J_USERNAME": "u", "NEO4J_PASSWORD": "p", "NEO4J_TRUST": "certifi"}
        with mock.patch.dict(os.environ, env), mock.patch.object(nc, "create_driver",
                                                                 side_effect=lambda **k: mock.MagicMock()):
            nc.close_driver()
            a = nc.get_driver()
            self.assertIs(nc.get_driver(), a)
            os.environ["NEO4J_URI"] = "neo4j://b:7687"
            b = nc.get_driver()
            self.assertIsNot(a, b)
            a.close.assert_called_once()
            nc.close_driver()


class ErrorCauseTest(unittest.TestCase):
    def _wrapped(self, inner):
        try:
            try:
                raise inner
            except Exception as e:
                raise ServiceUnavailable("Unable to retrieve routing information") from e
        except ServiceUnavailable as outer:
            return outer

    def test_causes(self):
        self.assertEqual(nc.classify_error(self._wrapped(ssl.SSLCertVerificationError("self-signed"))), nc.CAUSE_TLS)
        self.assertEqual(nc.classify_error(AuthError("bad")), nc.CAUSE_AUTH)
        self.assertEqual(nc.classify_error(self._wrapped(ConnectionRefusedError())), nc.CAUSE_NETWORK)
        self.assertEqual(nc.classify_error(ServiceUnavailable("x")), nc.CAUSE_UNAVAILABLE)

    def test_check_reports_cause_without_secrets(self):
        drv = mock.MagicMock()
        drv.verify_connectivity.side_effect = self._wrapped(ssl.SSLCertVerificationError("chain"))
        with mock.patch.object(nc, "get_driver", return_value=drv):
            out = nc.connection_check()
        self.assertEqual(out, {"ok": False, "cause": nc.CAUSE_TLS, "detail": "ServiceUnavailable"})


class PinnedCertifiTest(unittest.TestCase):
    def test_same_pinned_certifi_everywhere(self):
        pins = set()
        for f in ("requirements.txt", os.path.join("src", "mcp_server", "requirements-docker.txt"),
                  os.path.join("src", "mcp_server", "requirements-worker.txt"),
                  os.path.join("src", "mcp_server", "constraints-docker.txt"),
                  os.path.join("src", "mcp_server", "constraints-worker.txt")):
            lines = [l.strip() for l in open(os.path.join(ROOT, f)) if l.strip().startswith("certifi")]
            self.assertEqual(len(lines), 1, f)
            self.assertIn("==", lines[0], f"{f}: certifi must be pinned (RV-8)")
            pins.add(lines[0])
        self.assertEqual(len(pins), 1, f"one certifi version for laptop, MCP/Bento and worker, requirements and constraints: {pins}")


@unittest.skipUnless(os.environ.get("NEO4J_URI", "").startswith("neo4j+s://"), "needs Aura NEO4J_* in .env")
class LiveTest(unittest.TestCase):
    def test_certifi_verifies_aura(self):
        with mock.patch.dict(os.environ, {"NEO4J_TRUST": "certifi"}):
            nc.close_driver()
            self.assertEqual(nc.connection_check(timeout_s=reg.NEO4J_HEALTH_CHECK_TIMEOUT_S)["ok"], True)
            nc.close_driver()


if __name__ == "__main__":
    unittest.main()
