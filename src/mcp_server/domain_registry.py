import os

from schema_guard import CORTEX_DRIVE_NODES, PROJECT_GRAPH_NODES, DOCUMENT_GRAPH_NODES, DOCUMENT_ENTITY_LABELS, SEED_BUILTIN_VOCABULARY_LABELS

# Node-metadata embedding eligibility (2026-09-04) — single source of truth for "which node
# types get a metadata_embedding" (schema_guard.EmbeddableNodeMixin) and "which types the
# :Embeddable label / nodeMetadataIndex cover". See
# documents/architecture/node-metadata-embedding-hybrid-retrieval-2026-09-04.md. Reuses the same
# content/structural split cortex-chat-ui/utils/graphConstants.ts already draws via
# isBentoEligible()/TAG_LEAF_TYPES/GRAPH_VISUAL_EXCLUDE — not a new taxonomy. Excludes Category
# (pure UI grouper), SourceSnapshot/__MetaContext__ (no name field), Chunk (already has its own,
# separate full-text embedding), PreparatoryNote (private authored notes, not a search target).
# ThoughtLeadership is embeddable in principle but has no Pydantic model in schema_guard.py's
# model_map to mix EmbeddableNodeMixin into — a pre-existing, separately-tracked Node Hydration
# Contract gap; scripts/backfill_node_embeddings.py still covers it since it reads live Neo4j
# properties directly, not through Pydantic.
EMBEDDABLE_LABELS = [
    'Technology', 'Concept', 'Company', 'Person', 'Institution', 'Skill', 'WebsiteSource',
    'ThoughtLeadership',
    # GenericProjectNode-backed labels (schema_guard.validate_upsert's model_map)
    'Project', 'Role', 'Startup', 'Hackathon', 'Certification', 'Publication',
    'OpenSource', 'SocialLearning',
]

# ExpertTools._semantic_candidate_search() tuning (2026-09-08, Phase 1 of
# node-metadata-embedding-hybrid-retrieval-2026-09-04.md). Kill switch first: disabled by
# default, mirroring intent_classifier.js's ENABLE_LLM_CLASSIFICATION pattern — this changes
# live retrieval behavior and must be instantly disable-able without a redeploy, not something
# that ships always-on. When false, _semantic_candidate_search short-circuits to an empty
# result; every caller degrades to exactly today's behavior with zero code-path difference.
ENABLE_SEMANTIC_CANDIDATE_SEARCH = os.environ.get("ENABLE_SEMANTIC_CANDIDATE_SEARCH", "false").lower() == "true"

# How many raw nearest-neighbor candidates to over-fetch from nodeMetadataIndex per requested
# top_k, before the security post-filter drops any the caller isn't authorized to see. A fixed
# constant today — see the design doc's Phase 1 "named, tracked scale risk" note: at much larger
# multi-tenant scale a fixed multiplier can under-serve a small tenant if large tenants dominate
# the global index's nearest-neighbor space; revisit before that scale is reached, not now.
SEMANTIC_OVERFETCH_MULTIPLIER = int(os.environ.get("SEMANTIC_OVERFETCH_MULTIPLIER", "5"))

# Hard similarity floor below which a semantic candidate is treated as noise, not surfaced at
# all. NOT copied from intent_classifier.js's EMBEDDING_CONFIDENCE_THRESHOLD (0.75) — tried that
# first, found live (2026-09-08) that it excludes the "Governance" node (0.7492) for the query
# "AI ethics and governance work", the exact motivating example for this feature. Domain-centroid
# similarity (Phase S: query vs. an averaged centroid of many prototypes) and single-node
# similarity (query vs. one short metadata string) are different score distributions even on the
# same model — copying the threshold across was the wrong assumption. 0.70 is set from one real
# calibration point (0.7492 true positive, 0.7067 a second plausibly-relevant node, 0.6942 and
# below a gradually-decaying tail of weaker matches) — a single data point, not a robust
# calibration; revisit with more query/target pairs before relying on this heavily.
SEMANTIC_CANDIDATE_MIN_SIMILARITY = float(os.environ.get("SEMANTIC_CANDIDATE_MIN_SIMILARITY", "0.70"))

# connect_knowledge_on_demand bridge result limits. Env-var configurable so an operator can
# tune the breadth/cost tradeoff per deployment without a code change; BRIDGE_MAX_LIMIT bounds
# how much of the authorized subgraph a single request can force Dijkstra to explore/return,
# regardless of what a caller requests.
BRIDGE_DEFAULT_LIMIT = int(os.environ.get("BRIDGE_DEFAULT_LIMIT", "10"))
BRIDGE_MAX_LIMIT = int(os.environ.get("BRIDGE_MAX_LIMIT", "25"))

def get_bridge_limit(requested: int = None) -> int:
    """Clamp a requested connect_knowledge_on_demand `limit` to [1, BRIDGE_MAX_LIMIT],
    falling back to BRIDGE_DEFAULT_LIMIT when not specified."""
    value = requested if requested else BRIDGE_DEFAULT_LIMIT
    return max(1, min(value, BRIDGE_MAX_LIMIT))

# search_enterprise_graph's per-anchor neighbor cap (2026-08-27, revised same day). Bounds how
# much of each matched node's 1-hop neighborhood the initial query returns — the frontend's
# click-to-expand UI (expandedNodes/expansionCache in dashboard/page.tsx) is the intended path
# for going deeper, not an unbounded first response. Originally applied unconditionally to every
# search_enterprise_graph call; found live to silently drop Q2's established baseline from
# 50 nodes/88 links to 26/25 (career-map neighbor sets exceeding 20 per anchor). Split into the
# same DEFAULT/SCOPED two-tier pattern as SEARCH_EXPANSION_LIMIT_* below so Q1/Q2/Q3 (which never
# set scoped_expansion) keep their exact historical Cypher parameter value and result, and only
# bridge/cross_domain queries opt into the tight "core + immediate connections" cap.
SEARCH_NEIGHBOR_LIMIT_DEFAULT = int(os.environ.get("SEARCH_NEIGHBOR_LIMIT_DEFAULT", "10000"))
SEARCH_NEIGHBOR_LIMIT_SCOPED = int(os.environ.get("SEARCH_NEIGHBOR_LIMIT_SCOPED", "20"))

# search_enterprise_graph's taxonomy-expansion anchor-fan-out cap (2026-08-27). The Cypher
# fragment always applies `[0..$expansion_limit]` to the expanded-node id list it collects — the
# SAME query text runs for every caller, only this parameter's value differs. DEFAULT is a
# practical no-op (larger than this graph's realistic per-query fan-out) so Q1/Q2/Q3's existing
# call site — which never sets scoped_expansion — gets byte-for-byte the same behavior as before
# this fix. SCOPED is the tight cap the gateway opts into deterministically (never LLM-chosen,
# AP-20 pattern) only for bridge/cross_domain entity queries, where an unbounded 0..2 hop walk
# from a broadly-matching anchor was found live to pull in ~200 nodes for one question.
# See documents/architecture/search-enterprise-graph-expansion-cap-2026-08-27.md.
SEARCH_EXPANSION_LIMIT_DEFAULT = int(os.environ.get("SEARCH_EXPANSION_LIMIT_DEFAULT", "10000"))
SEARCH_EXPANSION_LIMIT_SCOPED = int(os.environ.get("SEARCH_EXPANSION_LIMIT_SCOPED", "20"))

# search_enterprise_graph Phase 3 semantic widening (2026-09-09, node-metadata-embedding-hybrid-
# retrieval-2026-09-04.md §2.7). Dedicated flag, deliberately separate from
# ENABLE_SEMANTIC_CANDIDATE_SEARCH above — this tool carries the majority of production traffic
# (Q1/Q2/Q4, often Q3), so its blast radius is far larger than connect_knowledge_on_demand's;
# operators need to be able to roll this back independently without also disabling Phase 2's
# already-verified bridge widening. Default off — flag-off must stay byte-identical to
# pre-Phase-3 behavior.
ENABLE_SEMANTIC_SEARCH_ENTERPRISE_GRAPH = os.environ.get("ENABLE_SEMANTIC_SEARCH_ENTERPRISE_GRAPH", "false").lower() == "true"

# Cheap count()-only pre-check threshold: semantic widening only fires when the primary keyword
# match already found fewer than this many nodes — avoids paying the embedding-API round-trip
# (~50-150ms) on every call of the highest-traffic tool when keyword matching already succeeded.
# NOT calibrated against live data yet (see §2.7/§9 of the design doc) — this is a reasoned
# starting point (mirrors the "a few weak hits" scenario named as the more common failure mode
# in expert_tools.py's Chunk-only-fallback comment), not a verified number. Revisit once real
# query volume is available, the same discipline SEMANTIC_CANDIDATE_MIN_SIMILARITY's own comment
# documents for its single-data-point calibration.
SEARCH_SEMANTIC_TRIGGER_MAX_COUNT = int(os.environ.get("SEARCH_SEMANTIC_TRIGGER_MAX_COUNT", "3"))

# Multiplier applied to a Dijkstra hop's weight in connect_knowledge_on_demand when the
# destination node's name literally matches a keyword extracted from the caller's query_context
# (2026-07-23 query-aware ranking). <1.0 makes query-relevant nodes cheaper to traverse, without
# making the hub-degree penalty (base weight) disappear entirely.
BRIDGE_RELEVANCE_DISCOUNT = float(os.environ.get("BRIDGE_RELEVANCE_DISCOUNT", "0.4"))

# Minimum graph degree a node must have to be eligible as a connect_knowledge_on_demand
# candidate *target* (2026-08-28). Root-caused live: all 13 :Skill nodes in this graph have
# degree=1 (resume-seeded, one HAS_SKILL edge each) and Skill is part of the "professional"
# domain's node_set (PROJECT_GRAPH_NODES) — so every one of them is a maximally cheap Dijkstra
# target (weight = 1 + ln(2)) that can crowd a legitimate, more-distant target (e.g.
# "Cortex-Drive") out of the top-N ranking. This is a different failure mode from
# BRIDGE_RELEVANCE_DISCOUNT (§8b of bridge-discovery-shortest-path-redesign-2026-07-23.md):
# that mechanism rewards relevant nodes, this one excludes structurally-uninformative ones,
# regardless of relevance. Deliberately NOT embedding/semantic similarity — that approach was
# already considered and rejected for this tool (breaks Invariant 11 groundability, see the
# same redesign doc §8b). Default 2 clears every observed degree-1 Skill node while preserving
# degree>=3 legitimate bridge participants (e.g. "Governance"/"Explainability", degree 3).
# Does not apply to a node matching an explicit target_node_name hint — that guarantee of
# inclusion (§8a) must survive regardless of degree.
BRIDGE_MIN_CANDIDATE_DEGREE = int(os.environ.get("BRIDGE_MIN_CANDIDATE_DEGREE", "2"))

# Degree above which a node on a connect_knowledge_on_demand path is treated as a generic hub
# rather than a topical signal, when deciding whether a path is keyword-"confirmed" vs.
# "structural" (2026-09-11). Found live: a query naming a specific person ("Sangeetha's AI
# governance work...") extracts that person's own name as a relevance keyword; since that person
# is the graph's central hub — nearly every path to nearly every project passes through them —
# their name matches on virtually any path regardless of the path's real topic (confirmed live: a
# JPMorgan Chase cloud-migration project with zero relation to governance/explainability/zero-trust
# got tagged "confirmed" this way). Generic, degree-based, identity-agnostic by design (Invariant
# 1) — works for any hub node, any name, without hardcoding who today's hub happens to be. Same
# underlying principle as CONTEXT_HUB_DEGREE_THRESHOLD (infer_context_on_demand's landmark/
# specific framing) and the log-degree Dijkstra edge penalty below — kept as its own constant
# rather than reusing either, since this governs a different decision (keyword-confirmation
# eligibility, not narrative framing or path cost) that may need independent tuning. Remains
# useful even after a future question-decomposition/embedding-similarity fix for target relevance
# (tracked separately) — this specifically guards path-traversal confirmation for node types with
# no metadata_embedding (Category, PreparatoryNote, etc.), and doubles as a tie-breaker signal
# alongside any future similarity score, matching how degree already serves as a secondary
# ranking key elsewhere (see the neighbor-ranking ORDER BY in get_cluster_context).
BRIDGE_HUB_DEGREE_THRESHOLD = int(os.environ.get("BRIDGE_HUB_DEGREE_THRESHOLD", "25"))

# Minimum number of DISTINCT query keywords a connect_knowledge_on_demand path must match to be
# tiered "confirmed" rather than "structural" (2026-09-11). Found live, same investigation as
# BRIDGE_HUB_DEGREE_THRESHOLD above: a single generic technical word (e.g. "architecture") shared
# between the query and an unrelated node's description was enough to confirm a path on its own —
# in a tech-heavy graph, common nouns like this coincidentally appear across many project
# descriptions regardless of true topical relevance. Requiring multiple distinct matches is
# generic (no word-specific blocklist to maintain, unlike extending _BRIDGE_QUERY_STOPWORDS) and
# targets the actual problem: a genuinely relevant node should usually share more than one query
# concept, not just one throwaway noun. A known, real limitation of literal keyword matching that
# this doesn't fully solve — see the tracked question-decomposition/embedding-similarity fix for
# the more durable approach.
BRIDGE_RELEVANCE_MIN_KEYWORD_MATCHES = int(os.environ.get("BRIDGE_RELEVANCE_MIN_KEYWORD_MATCHES", "2"))

# infer_context_on_demand structural-fact caps (2026-08-03). Env-var configurable for the same
# reason as BRIDGE_DEFAULT_LIMIT/BRIDGE_MAX_LIMIT — bounds how much of a node's neighborhood a
# single request can return, regardless of the node's actual degree.
CONTEXT_PER_RELATION_CAP = int(os.environ.get("CONTEXT_PER_RELATION_CAP", "4"))
CONTEXT_RELATION_GROUP_CAP = int(os.environ.get("CONTEXT_RELATION_GROUP_CAP", "5"))
# A node at or above this degree is framed as a "landmark" (its centrality IS the story) rather
# than having its neighbors enumerated as if that were exhaustive.
CONTEXT_HUB_DEGREE_THRESHOLD = int(os.environ.get("CONTEXT_HUB_DEGREE_THRESHOLD", "25"))

def get_context_caps(per_relation: int = None, relation_group: int = None) -> tuple:
    """Clamp caller-supplied infer_context_on_demand caps to sane bounds, mirroring
    get_bridge_limit(). Falls back to the CONTEXT_* defaults when not specified."""
    per = per_relation if per_relation else CONTEXT_PER_RELATION_CAP
    group = relation_group if relation_group else CONTEXT_RELATION_GROUP_CAP
    return max(1, min(per, 10)), max(1, min(group, 15))

# Centralized Label Registry
DISCOVERY_LABELS = [
    "Project", "Role", "Company", "Person", "Hackathon", "ThoughtLeadership", 
    "Publication", "Institution", "Podcast", "Episode", "Topic", "Certification", 
    "Category", "Technology", "Concept", "Degree", "ProfessionalEducation", "Skill"
]

BRIDGE_LABELS = ["ReferenceLink", "Chunk", "Source", "PreparatoryNote", "__MetaContext__"]

VISUAL_DENY_LIST = BRIDGE_LABELS

# Phase B M5 (documents): the `document` domain is offered only when this flag is on (gateway +
# MCP). Off (default) = production behaviour identical to before M5 (decision M5-10, S2-19).
ENABLE_DOCUMENT_DOMAIN = os.environ.get("ENABLE_DOCUMENT_DOMAIN", "false").lower() == "true"

def get_discovery_label_string() -> str:
    """Returns a Cypher-compatible label string like 'Project|Role|Company'."""
    return "|".join(DISCOVERY_LABELS)

def get_bridge_label_string() -> str:
    """Returns a Cypher-compatible label string for bridge nodes."""
    return "|".join(BRIDGE_LABELS)

def get_visual_deny_list(domain: str = None) -> list:
    """Labels excluded from the visual graph: the global bridge labels, plus the domain's own
    `visual_deny_labels` (M5-8: ContentBlock is hidden for `document` only — its text goes to the chat
    with citations)."""
    manifest = DOMAIN_MANIFESTS.get((domain or "").lower()) if domain else None
    return VISUAL_DENY_LIST + (manifest.get("visual_deny_labels", []) if manifest else [])


def _in_universal_discovery(manifest: dict) -> bool:
    """M5-6: a manifest can opt out of the domain="all" unions (universal discovery, Flow 4)."""
    return manifest.get("universal_discovery", True)

# Authoritative Domain Manifests (The Single Source of Experience Truth)
DOMAIN_MANIFESTS = {
    "professional": {
        "persona": "professional",
        "ui_hints": {
            "impact_label": "Professional Impact",
            "tech_label": "Core Stack",
            "timeline_label": "Tenure Window",
            "narrative_label": "The \"Why\" (Professional Narrative)",
            "trace_label": "Governance Trace",
            "trace_sub_label": "Vetted Architecture",
            "placeholder": "Synthesizing professional impact metrics for this initiative..."
        },
        "node_set": PROJECT_GRAPH_NODES + ["Publication", "ThoughtLeadership", "Certification"],
        "anchor_labels": ["Project", "Company", "Skill", "Certification", "Industry", "ThoughtLeadership"],
        "backbone_labels": ["Person", "Category"],
        # Node types that qualify as cross-domain bridge SOURCES for this domain (added
        # 2026-09-14, see auth-derived-identity-and-bridge-source-config-design-2026-09-12.md
        # §4). Replaces a hardcoded "thought leadership" keyword search the LLM was
        # instructed (prompt-text only) to run before calling connect_knowledge_on_demand —
        # live-confirmed the LLM can skip that step and fabricate a source name instead.
        # enumerate_bridge_sources() matches on these labels directly, deterministically.
        "bridge_source_labels": ["ThoughtLeadership"],
        "realm": "INTERNAL"
    },
    "podcast": {
        "persona": "podcast",
        "ui_hints": {
            "impact_label": "Knowledge Takeaway",
            "tech_label": "Discussed Tech",
            "timeline_label": "Air Date",
            "narrative_label": "Episode Hook (Insight)",
            "trace_label": "Discovery Path",
            "trace_sub_label": "Knowledge Evolution",
            "placeholder": "Extracting key technical insights from this episode transcript..."
        },
        "node_set": CORTEX_DRIVE_NODES + ["Publication", "Community"],
        "anchor_labels": ["Episode", "Topic", "Concept", "Technology", "Publication", "Podcast"],
        "backbone_labels": ["Episode", "Topic", "Technology", "Publication", "Concept", "Category", "Podcast", "Source"],
        "realm": "INTERNAL"
    },
    "structural": {
        "persona": "structural",
        "ui_hints": {
            "impact_label": "Ontology",
            "tech_label": "Node Type",
            "timeline_label": "Lifespan",
            "narrative_label": "Foundation",
            "trace_label": "System Link",
            "trace_sub_label": "Graph Anchor",
            "placeholder": "Accessing structural landmarks in the public realm..."
        },
        "node_set": ["Category", "Technology", "Company", "Institution", "Skill", "Degree", "ProfessionalEducation", "Year", "Community", "ThoughtLeadership", "Podcast", "Episode"],
        "anchor_labels": ["Category", "Technology", "Skill", "Institution", "ThoughtLeadership", "Podcast", "Episode"],
        "realm": "PUBLIC" # Structural landmarks are always discoverable context
    },
    "website": {
        "persona": "website",
        "ui_hints": {
            "impact_label": "Page Summary",
            "tech_label": "Referenced Tech",
            "timeline_label": "Last Synced",
            "narrative_label": "Extracted Description",
            "trace_label": "Cross-Domain Bridge",
            "trace_sub_label": "Shared Entity",
            "placeholder": "Fetching registered web source metadata..."
        },
        # See documents/architecture/website-domain-cross-domain-routing-design-2026-08-24.md
        "node_set": ["WebsiteSource", "SourceSnapshot"],
        "anchor_labels": ["WebsiteSource"],
        "backbone_labels": ["WebsiteSource"],
        "realm": "INTERNAL"
    },
    "federated": {
        "persona": "federated",
        "ui_hints": {
            "impact_label": "Silo Strategy",
            "tech_label": "Integration Stack",
            "timeline_label": "Sync Window",
            "narrative_label": "Federated Metadata (Iceberg)",
            "trace_label": "External Bridge",
            "trace_sub_label": "Stitched Landmark",
            "placeholder": "Fetching federated metadata from external silo. This may involve cross-realm MCP discovery..."
        },
        "node_set": ["ExternalSilo", "DataLake", "GitHub", "Confluence", "TableMetadata", "PageMetadata", "Publication", "Source"],
        "anchor_labels": ["ExternalSilo", "DataLake", "TableMetadata", "Publication"],
        "realm": "INTERNAL"
    },
    # Phase B M5: documents (design: phase-b-m5-document-query-design-2026-10-21.md §1.3.1).
    # No shared entity labels in node_set (§1.3.5); not part of universal discovery (M5-6); only
    # reachable when ENABLE_DOCUMENT_DOMAIN is on.
    "document": {
        "persona": "document",
        "ui_hints": {
            "impact_label": "Document Summary",
            "tech_label": "Referenced Tech",
            "timeline_label": "Last Synced",
            "narrative_label": "Cited Passage",
            "trace_label": "Source Document",
            "trace_sub_label": "Page Citation",
            "placeholder": "Searching the document's passages..."
        },
        "node_set": list(DOCUMENT_GRAPH_NODES),
        "anchor_labels": ["DocumentSource", "Section"],
        "backbone_labels": ["DocumentSource"],
        "visual_deny_labels": ["ContentBlock"],
        "universal_discovery": False,
        "realm": "INTERNAL"
    }
}

# Explicitly Private Labels (Overrides)
PRIVATE_LABELS = ["Note", "PreparatoryNote", "PrivateDraft", "Salary", "InternalReview", "ShadowState", "AccessRequest"]


def get_backbone_labels(domain: str = "all") -> list:
    """Return the labels considered 'Backbone' (landmarks) for the given domain."""
    if domain.lower() == "all":
        backbone = set()
        for manifest in DOMAIN_MANIFESTS.values():
            if _in_universal_discovery(manifest):
                backbone.update(manifest.get("backbone_labels", []))
        return list(backbone)
    manifest = DOMAIN_MANIFESTS.get(domain.lower())
    return manifest.get("backbone_labels", []) if manifest else []

def get_authorized_labels(domain: str) -> list:
    """Return the list of labels authorized for the given domain context."""
    if domain.lower() == "all":
        return None
    manifest = DOMAIN_MANIFESTS.get(domain.lower())
    return manifest["node_set"] if manifest else []

def get_anchor_labels(domain: str) -> list:
    """Return the list of labels used as discovery anchors for the given domain."""
    if domain.lower() == "all":
        # Combine all anchors for universal discovery
        anchors = set()
        for manifest in DOMAIN_MANIFESTS.values():
            if _in_universal_discovery(manifest):
                anchors.update(manifest.get("anchor_labels", []))
        return list(anchors)
    manifest = DOMAIN_MANIFESTS.get(domain.lower())
    return manifest.get("anchor_labels", []) if manifest else []

def get_manifest_for_label(label: str) -> dict:
    """Find the manifest governing a specific node label."""
    for manifest in DOMAIN_MANIFESTS.values():
        if label in manifest["node_set"]:
            return manifest
    return DOMAIN_MANIFESTS["professional"] # Default fallback

def get_realm_for_label(label: str) -> str:
    """Return the discovery realm governing a specific node label."""
    if label in PRIVATE_LABELS:
        return "PRIVATE"
    
    manifest = get_manifest_for_label(label)
    return manifest.get("realm", "INTERNAL")


# ── Shared-entity isolation by provenance (M5-4, design §1.3.5; Invariant 7, S2-16 class) ──────────────
# Labels any content domain may create (a Technology from a PDF, a Person from a podcast). In a
# single-domain search such a node qualifies for domain D only if it is SYSTEM/PUBLIC or linked to a node
# whose label is EXCLUSIVE to D.
SHARED_ENTITY_LABELS = list(DOCUMENT_ENTITY_LABELS)
# The content domains whose node sets are compared to find each one's exclusive labels. "structural" and
# "federated" are views over other domains' labels, not content domains, so they're left out.
CONTENT_DOMAINS = ["professional", "podcast", "website", "document"]
# Never evidence of a domain: built-in vocabulary and the section headers (SYSTEM/PUBLIC landmarks).
_NOT_PROVENANCE_LABELS = set(SEED_BUILTIN_VOCABULARY_LABELS) | {"Category"}


# Routing name catalog (S2-60): the labels whose `name` routes a question to a domain by naming it (the
# gateway classifier's Phase E). Not get_exclusive_labels(): that returns nothing for career and includes
# passage-level labels (Chunk, Section, ContentBlock) nobody names. Shared labels (Concept, Technology,
# Topic, …) are excluded — they appear in several domains. Keys are gateway domain signals.
ROUTING_NAME_LABELS = {
    "career": ["Company", "Role", "Project", "Startup", "Hackathon", "ThoughtLeadership",
               "Degree", "Institution", "Certification", "OpenSource", "Team"],
    "podcast": ["Episode", "Podcast"],
    "website": ["WebsiteSource"],
    "document": ["DocumentSource"],
}
# Named-person detection (gateway classifyNamedPerson): its own section, never a routing domain.
ROUTING_PERSON_LABELS = ["Person"]
# Sources whose titles get short names (S2-60 §9).
ROUTING_SOURCE_DOMAINS = ["website", "document"]


def get_exclusive_labels(domain: str) -> list:
    """Labels that exist only in this content domain (e.g. podcast → Episode, Podcast, Chunk, Source)."""
    domain = (domain or "").lower()
    if domain not in CONTENT_DOMAINS:
        return []
    own = set(DOMAIN_MANIFESTS[domain]["node_set"])
    others = set()
    for d in CONTENT_DOMAINS:
        if d != domain:
            others |= set(DOMAIN_MANIFESTS[d]["node_set"])
    return sorted(own - others - set(SHARED_ENTITY_LABELS) - _NOT_PROVENANCE_LABELS)
