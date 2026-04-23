import re
with open('src/mcp_server/expert_tools.py', 'r') as f:
    text = f.read()

# 1. Update search_episodes_by_question Cypher
q1_old = """                MATCH (episode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                RETURN
                    episode.name AS EpisodeTitle,
                    episode.number AS EpisodeNumber,
                    chunk.text AS ChunkContent, 
                    score AS SimilarityScore
                ORDER BY
                    SimilarityScore DESC"""
q1_new = """                MATCH (episode:Episode {tenant_id: $tenant_id})-[:HAS_SOURCE]->(s:Source)-[:CONTAINS]->(chunk)
                OPTIONAL MATCH (episode)-[:HAS_TOPIC]->(t:Topic)
                OPTIONAL MATCH (p:Person)-[]-(episode)
                RETURN
                    episode.name AS EpisodeTitle,
                    episode.number AS EpisodeNumber,
                    chunk.text AS ChunkContent, 
                    score AS SimilarityScore,
                    collect(DISTINCT t.name) AS Topics,
                    collect(DISTINCT p.name) AS People
                ORDER BY
                    SimilarityScore DESC"""
text = text.replace(q1_old, q1_new)

m1_old = """                    'ChunkContent': record['ChunkContent'],
                    'SimilarityScore': float(record['SimilarityScore']) if record['SimilarityScore'] else None"""

m1_new = """                    'ChunkContent': record['ChunkContent'],
                    'Topics': record['Topics'],
                    'People': record['People'],
                    'SimilarityScore': float(record['SimilarityScore']) if record['SimilarityScore'] else None"""
text = text.replace(m1_old, m1_new)

# 2. Rename search_resume_graph and update domain_intent
s_old = """    def search_resume_graph(self, keyword: str, requesting_user_id: str = "", wants_visual_map: bool = False) -> str:
        \"\"\"
        Search for entities across the Interactive Resume Graph dynamically.
        \"\"\""""

s_new = """    def _inject_federated_demo_boost(self) -> str:
        return "WHEN 'ExternalSilo' IN labels(node) AND any(w IN keywords WHERE w IN ['silo', 'silos', 'external', 'lakehouse', 'iceberg']) THEN 1000"

    def search_enterprise_graph(self, keyword: str, requesting_user_id: str = "", wants_visual_map: bool = False, domain_intent: str = "all") -> str:
        \"\"\"
        Search for entities across the Universal Enterprise Graph dynamically, explicitly crossing boundaries between domains (Podcast/Resume/Federated).
        \"\"\""""
text = text.replace(s_old, s_new)

text = text.replace('fetch embedding for search_resume_graph', 'fetch embedding for search_enterprise_graph')

al_old = """            from domain_registry import get_authorized_labels, DOMAIN_MANIFESTS
            allowed_labels = get_authorized_labels("professional")
            print(f"[SEARCH] Running resume search for user: {requesting_user_id}")"""

al_new = """            from domain_registry import get_authorized_labels, DOMAIN_MANIFESTS
            if domain_intent.lower() == "all":
                allowed_labels = get_authorized_labels("professional") + get_authorized_labels("podcast") + get_authorized_labels("federated") + get_authorized_labels("structural")
            else:
                allowed_labels = get_authorized_labels(domain_intent)
                
            print(f"[SEARCH] Running '{domain_intent}' enterprise search for user: {requesting_user_id}")"""
text = text.replace(al_old, al_new)

# 3. Add Demo Boost parameter
boost_old = """             (CASE 
                WHEN node.name CONTAINS "1997" OR node.name CONTAINS "NIT Bhopal" THEN 500
                WHEN node.name CONTAINS "JPMC" OR node.name CONTAINS "2025" THEN 200
                ELSE 0 
             END) AS range_boost"""

boost_new = """             (CASE 
                WHEN node.name CONTAINS "1997" OR node.name CONTAINS "NIT Bhopal" THEN 500
                WHEN node.name CONTAINS "JPMC" OR node.name CONTAINS "2025" THEN 200
                " + self._inject_federated_demo_boost() + "
                ELSE 0 
             END) AS range_boost"""
text = text.replace(boost_old, boost_new)

with open('src/mcp_server/expert_tools.py', 'w') as f:
    f.write(text)

