import os

from schema_guard import CORTEX_DRIVE_NODES, PROJECT_GRAPH_NODES

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

# Multiplier applied to a Dijkstra hop's weight in connect_knowledge_on_demand when the
# destination node's name literally matches a keyword extracted from the caller's query_context
# (2026-07-23 query-aware ranking). <1.0 makes query-relevant nodes cheaper to traverse, without
# making the hub-degree penalty (base weight) disappear entirely.
BRIDGE_RELEVANCE_DISCOUNT = float(os.environ.get("BRIDGE_RELEVANCE_DISCOUNT", "0.4"))

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

def get_discovery_label_string() -> str:
    """Returns a Cypher-compatible label string like 'Project|Role|Company'."""
    return "|".join(DISCOVERY_LABELS)

def get_bridge_label_string() -> str:
    """Returns a Cypher-compatible label string for bridge nodes."""
    return "|".join(BRIDGE_LABELS)

def get_visual_deny_list() -> list:
    """Returns the list of labels that should be excluded from the visual graph."""
    return VISUAL_DENY_LIST

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
    }
}

# Explicitly Private Labels (Overrides)
PRIVATE_LABELS = ["Note", "PreparatoryNote", "PrivateDraft", "Salary", "InternalReview", "ShadowState", "AccessRequest"]


def get_backbone_labels(domain: str = "all") -> list:
    """Return the labels considered 'Backbone' (landmarks) for the given domain."""
    if domain.lower() == "all":
        backbone = set()
        for manifest in DOMAIN_MANIFESTS.values():
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
