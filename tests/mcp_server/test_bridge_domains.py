"""
Bridge target domains (bridge-discovery-and-bento-panel-design-2026-11-03.md §1). No network.
    .venv/bin/python -m unittest tests.mcp_server.test_bridge_domains -v
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

import domain_registry as reg  # noqa: E402
from expert_tools import ExpertTools  # noqa: E402


def _with_documents(enabled: bool):
    return mock.patch.dict(reg.DOMAIN_FEATURE_FLAGS, {"document": enabled})


class TargetDomainsTest(unittest.TestCase):
    def test_document_domain_follows_feature_flag(self):
        with _with_documents(False):
            self.assertNotIn("document", reg.get_bridge_target_domains())
        with _with_documents(True):
            self.assertIn("document", reg.get_bridge_target_domains())

    def test_structural_and_federated_are_never_targets(self):
        with _with_documents(True):
            offered = reg.get_bridge_target_domains()
        self.assertNotIn("structural", offered)
        self.assertNotIn("federated", offered)

    def test_auto_excludes_the_source_domain(self):
        with _with_documents(True):
            self.assertNotIn("document", reg.resolve_bridge_target_domains(["auto"], ["DocumentSource"]))
            self.assertNotIn("podcast", reg.resolve_bridge_target_domains(["auto"], ["Episode"]))
            self.assertNotIn("professional", reg.resolve_bridge_target_domains(["auto"], ["ThoughtLeadership"]))

    def test_auto_for_a_shared_only_source_is_every_domain(self):
        with _with_documents(True):
            self.assertEqual(reg.resolve_bridge_target_domains(["auto"], ["Concept"]), reg.get_bridge_target_domains())

    def test_named_domains_kept_unknown_dropped(self):
        with _with_documents(False):
            self.assertEqual(reg.resolve_bridge_target_domains(["podcast", "bogus", "document"], ["Episode"]), ["podcast"])

    def test_default_is_auto(self):
        with _with_documents(True):
            self.assertEqual(reg.resolve_bridge_target_domains(None, ["DocumentSource"]),
                             reg.resolve_bridge_target_domains(["auto"], ["DocumentSource"]))


class CandidateRuleTest(unittest.TestCase):
    def test_exclusive_label_qualifies(self):
        self.assertEqual(reg.classify_bridge_candidate(["Episode"], "podcast"), "yes")

    def test_shared_label_needs_provenance_everywhere(self):
        for d in reg.CONTENT_DOMAINS:
            self.assertEqual(reg.classify_bridge_candidate(["Concept"], d), "provenance", d)

    def test_other_domains_exclusive_label_disqualifies(self):
        # ThoughtLeadership+Publication is career, even though Publication is in podcast's node set.
        self.assertEqual(reg.classify_bridge_candidate(["ThoughtLeadership", "Publication"], "podcast"), "no")
        self.assertEqual(reg.classify_bridge_candidate(["ThoughtLeadership", "Publication"], "professional"), "yes")

    def test_hidden_labels_never_qualify(self):
        self.assertEqual(reg.classify_bridge_candidate(["ContentBlock"], "document"), "no")
        self.assertEqual(reg.classify_bridge_candidate(["Chunk"], "podcast"), "no")

    def test_unrelated_label_does_not_qualify(self):
        self.assertEqual(reg.classify_bridge_candidate(["Episode"], "professional"), "no")


class SplitAcrossDomainsTest(unittest.TestCase):
    def _items(self, domains):
        return [(f"n{i}", (float(i), [], [])) for i in range(len(domains))], {f"n{i}": d for i, d in enumerate(domains)}

    def test_each_domain_gets_its_share(self):
        items, domain_of = self._items(["podcast"] * 8 + ["website"] * 3)
        chosen = ExpertTools._select_bridges_by_domain(items, domain_of, ["podcast", "website"], 4)
        self.assertEqual([domain_of[t] for t, _ in chosen].count("website"), 2)
        self.assertEqual(len(chosen), 4)

    def test_unused_slots_go_to_next_best(self):
        items, domain_of = self._items(["podcast"] * 8 + ["website"])
        chosen = ExpertTools._select_bridges_by_domain(items, domain_of, ["podcast", "website"], 6)
        self.assertEqual(len(chosen), 6)
        self.assertEqual([domain_of[t] for t, _ in chosen].count("website"), 1)

    def test_ranking_order_preserved(self):
        items, domain_of = self._items(["podcast"] * 5 + ["website"] * 5)
        chosen = ExpertTools._select_bridges_by_domain(items, domain_of, ["podcast", "website"], 4)
        ids = [t for t, _ in chosen]
        self.assertEqual(ids, sorted(ids, key=lambda t: int(t[1:])))

    def test_every_domain_shown_when_slots_are_scarce(self):
        # Summary cap 5 across 4 domains: the 4th-ranked domain must still get a line.
        items, domain_of = self._items(["podcast"] * 3 + ["website"] * 3 + ["document"] * 3 + ["professional"])
        chosen = ExpertTools._select_bridges_by_domain(
            items, domain_of, ["podcast", "website", "document", "professional"], reg.BRIDGE_SUMMARY_MAX_CLAUSES)
        self.assertEqual({domain_of[t] for t, _ in chosen}, {"podcast", "website", "document", "professional"})
        self.assertEqual(len(chosen), reg.BRIDGE_SUMMARY_MAX_CLAUSES)

    def test_summary_names_every_domain_that_found_a_bridge(self):
        # Production case 2026-11-03: Podcast 9, Websites 1 — Websites was missing from the summary.
        items, domain_of = self._items(["podcast"] * 9 + ["website"])
        chosen = ExpertTools._select_bridges_by_domain(
            items, domain_of, ["podcast", "website"], reg.BRIDGE_SUMMARY_MAX_CLAUSES)
        self.assertIn("website", [domain_of[t] for t, _ in chosen])


if __name__ == "__main__":
    unittest.main()
