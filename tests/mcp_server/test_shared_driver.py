"""
Shared Neo4j driver and warm-up (cold-start fix, 2026-11-12).
- every ExpertTools in a process uses one driver; close() releases the instance, never the shared pool;
- warm_neo4j() opens the pool (live) and gives up after its limit when Neo4j is unreachable (never hangs startup);
- Bento serves requests concurrently; MCP, Bento and the gateway warm up before they start listening.

    .venv/bin/python -m unittest tests.mcp_server.test_shared_driver -v
"""
import os
import sys
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(os.path.join(ROOT, ".env"))
import expert_tools  # noqa: E402


class SharedDriverTest(unittest.TestCase):
    def test_one_driver_per_process_and_close_keeps_it(self):
        a = expert_tools.ExpertTools(tenant_id="t1")
        b = expert_tools.ExpertTools(tenant_id="t2", requesting_user_id="u")
        self.assertIs(a.driver, b.driver)
        shared = a.driver
        a.close()
        self.assertIsNone(a.driver)
        self.assertIs(expert_tools.get_shared_driver(), shared, "closing one instance never closes the pool")
        b.close()

    def test_warmup_gives_up_when_unreachable(self):
        import neo4j_connection   # warm-up lives in the connection factory since S2-79 (2026-11-16)
        with mock.patch.object(neo4j_connection, "get_driver") as g:
            g.return_value.verify_connectivity.side_effect = OSError("down")
            with mock.patch.object(neo4j_connection.time, "sleep", lambda s: None):
                t0 = time.monotonic()
                self.assertFalse(expert_tools.warm_neo4j(max_seconds=0.2))
                self.assertLess(time.monotonic() - t0, 5)

    @unittest.skipUnless(os.environ.get("NEO4J_URI"), "needs NEO4J_* in .env")
    def test_warmup_opens_the_pool(self):
        self.assertTrue(expert_tools.warm_neo4j(max_seconds=20))

    def test_servers_warm_before_serving(self):
        bento = open(os.path.join(ROOT, "src", "mcp_server", "cortex_os_mentalmodel_http_server.py")).read()
        mcp = open(os.path.join(ROOT, "src", "mcp_server", "cortex_os_mentalmodel_server_sse.py")).read()
        gw = open(os.path.join(ROOT, "cortex-gateway", "index.js")).read()
        self.assertIn("ThreadingHTTPServer(server_address", bento)
        self.assertLess(bento.index("warm_neo4j()"), bento.index("serve_forever()"))
        self.assertLess(mcp.rindex("warm_neo4j()"), mcp.index("asyncio.run(_serve(port))"))
        self.assertIn("warmUp().finally(() => app.listen(port", gw)
        for svc in ("gateway", "bento", "mcp"):
            script = open(os.path.join(ROOT, "scripts", f"build-deploy-{svc}.sh")).read()
            self.assertIn("--min-instances 1", script)
            # Found 2026-11-12: a comment inside the continued `gcloud run deploy` command ended it and silently dropped
            # --min-instances and every flag after it. No comment line may sit inside the command.
            start = script.index(f"gcloud run deploy cortex-{svc}")
            end = script.index("\n\n", start)
            command = script[start:end]
            self.assertFalse([l for l in command.splitlines() if l.strip().startswith("#")], f"comment inside {svc} deploy")
            self.assertTrue(all(l.rstrip().endswith("\\") for l in command.splitlines()[:-1] if l.strip()),
                            f"{svc}: every line but the last continues the command")
            # S2-84 / RV-15 part 1: each service runs as its own least-privilege account, never the default one.
            sa_var = {"gateway": "GATEWAY_SA", "bento": "BENTO_SA", "mcp": "MCP_SA"}[svc]
            self.assertIn(f'--service-account "${{{sa_var}', command)
            # Candidate mode comes from the one shared helper (no copies).
            self.assertIn('source "${REPO}/scripts/deploy-candidate.sh"', script)
            self.assertIn(f"gcloud run deploy cortex-{svc} ${{CANDIDATE_FLAGS}}", command)
            self.assertNotIn('CANDIDATE_FLAGS="--no-traffic', script)
        env = open(os.path.join(ROOT, "scripts", "cloud-env.sh")).read()
        self.assertIn('export GATEWAY_SA="cortex-gateway@${PROJECT_ID}.iam.gserviceaccount.com"', env)
        # RV-15 part 1 / S2-87: ingestion runs as the dedicated invoker, never the default Compute account (Editor).
        self.assertIn('export INGEST_INVOKER_SA="cortex-ingest-invoker@${PROJECT_ID}.iam.gserviceaccount.com"', env)
        self.assertIn('export DOCUMENT_INGEST_INVOKER_SA="${INGEST_INVOKER_SA}"', env)
        self.assertNotIn("developer.gserviceaccount.com", env, "no service runs as the default Compute account")


if __name__ == "__main__":
    unittest.main()


class ToolsOffEventLoopTest(unittest.TestCase):
    """Every MCP tool runs its Neo4j work off the event loop (2026-11-12): a synchronous `return expert.x(...)` in an
    async tool body blocks every other connection while it runs."""

    def test_no_tool_calls_expert_on_the_event_loop(self):
        import re
        src = open(os.path.join(ROOT, "src", "mcp_server", "cortex_os_mentalmodel_server_sse.py")).read()
        blocking = re.findall(r"^        return (?:json\.dumps\()?expert\.\w+\(", src, re.M)
        self.assertEqual(blocking, [], "tool bodies must use asyncio.to_thread(expert.method, ...)")

    def test_thread_pool_sized_before_serving(self):
        src = open(os.path.join(ROOT, "src", "mcp_server", "cortex_os_mentalmodel_server_sse.py")).read()
        self.assertIn("set_default_executor(", src)
        self.assertIn("asyncio.run(_serve(port))", src)
