"""
Vocabulary name keys (design 2026-11-09 §5.0). No database.

    .venv/bin/python -m unittest tests.mcp_server.test_vocabulary_keys -v
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src", "mcp_server"))

from vocabulary_keys import base_key, group_keys, name_key  # noqa: E402


class VocabularyKeysTest(unittest.TestCase):
    def test_case_and_punctuation(self):
        self.assertEqual(base_key("Graph database"), "graph database")
        self.assertEqual(base_key("  Elastic-Search "), "elastic search")
        self.assertEqual(base_key("C++"), "c++")
        self.assertEqual(base_key("C#"), "c#")

    def test_plural_merges_only_when_the_singular_exists(self):
        g = group_keys(["Graph Databases", "Graph Database", "Graph database", "Kubernetes", "Redis", "Analytics"])
        self.assertEqual({g["Graph Databases"], g["Graph Database"], g["Graph database"]}, {"graph database"})
        self.assertEqual(g["Kubernetes"], "kubernetes")
        self.assertEqual(g["Redis"], "redis")
        self.assertEqual(g["Analytics"], "analytics")

    def test_do_not_singularize_list(self):
        g = group_keys(["Kafka Streams", "Kafka Stream"])
        self.assertNotEqual(g["Kafka Streams"], g["Kafka Stream"])

    def test_short_and_double_s_words_unchanged(self):
        g = group_keys(["AWS", "Glass", "Gas", "ACID transactions", "ACID transaction"])
        self.assertEqual(g["AWS"], "aws")
        self.assertEqual(g["Glass"], "glass")
        self.assertEqual(g["ACID transactions"], g["ACID transaction"])

    def test_name_key_on_write(self):
        self.assertEqual(name_key("Graph Databases", known_keys={"graph database"}), "graph database")
        self.assertEqual(name_key("Graph Databases", known_keys=set()), "graph databases")
        # Protected product names stay as they are even if a singular-looking key exists.
        self.assertEqual(name_key("Kubernetes", known_keys={"kubernete"}), "kubernetes")


if __name__ == "__main__":
    unittest.main()
