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
        with mock.patch.object(expert_tools, "get_shared_driver") as g:
            g.return_value.verify_connectivity.side_effect = OSError("down")
            with mock.patch.object(expert_tools.time if hasattr(expert_tools, "time") else time, "sleep", lambda s: None):
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
        self.assertLess(mcp.index("warm_neo4j()"), mcp.index("uvicorn.run(app"))
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


if __name__ == "__main__":
    unittest.main()
