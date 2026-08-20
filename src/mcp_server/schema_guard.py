from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict, Any
from datetime import datetime
import os

# --- Schema Constants ---

CORTEX_DRIVE_NODES = [
    'Podcast', 'Episode', 'Chunk', 'Topic', 
    'Concept', 'ReferenceLink', 'Person', 'Technology', 'Source'
]

PROJECT_GRAPH_NODES = [
    'Project', 'Purpose', 'Objective', 'Value', 'Benefit', 'Metric',
    'Outcome', 'SuccessCriteria', 'MeasurableResult', 'Approach',
    'Plan', 'Method', 'MethodStep', 'Tool', 'Timeline', 'Milestone',
    'Team', 'Role', 'Responsibility', 'Task', 'Deliverable', 'TeamMember',
    'Company', 'Degree', 'Institution', 'Skill', 'Category', 'PreparatoryNote',
    'Startup', 'Hackathon', 'Certification', 'Publication', 'OpenSource', 'SocialLearning',
    'ProfessionalEducation', 'Year',
    # Federated Knowledge Labels
    'ExternalSilo', 'DataLake', 'GitHub', 'Confluence', 'TableMetadata', 'PageMetadata',
    # Thought leadership and community nodes created by the resume seeder
    'ThoughtLeadership', 'Community', 'Person'
]

SYSTEM_NODES = [
    '__MetaContext__'
]

# --- Universal Source Connector Constants (Phase A+) ---
# See documents/architecture/source-metadata-template-2026-08-19.md for the full design.
# NOTE: the design doc's Cypher sketches use a shared `:Source` label across all 5 source
# types. That label is already taken by SourceNode below (podcast/episode ingestion
# provenance — a different, narrower concept: "which file/URL/video did THIS transcript
# come from," 1:1 with an Episode). Reusing it here would collide. Each source-connector
# type is registered under its OWN distinct label instead; SOURCE_CONNECTOR_LABELS is the
# named list a query uses to address "any registered source" collectively, replacing what
# the design docs' shared label would have done. Only 'WebsiteSource' is implemented as of
# Phase A — the other four are named here so the full taxonomy is visible in one place, per
# Invariant 1 (named constants, not inline), even though their Pydantic models don't exist
# yet.
SOURCE_CONNECTOR_TYPES = ['database', 'website', 'doc_store', 'media', 'document_url']

SOURCE_CONNECTOR_LABELS = [
    'DatabaseSource', 'WebsiteSource', 'DocStoreSource', 'MediaSource', 'DocumentSource'
]

SOURCE_CONNECTOR_STATUSES = ['active', 'paused', 'error', 'deprecated']

# --- Discovery Logic Constants (Landmarks) ---
# High-Fidelity backbone nodes that serve as the primary landmarks in discovery.
# These appear as prominent "Sun" nodes in the initial graph expansion.
BACKBONE_LANDMARKS = [
    'Category', 
    'Company', 
    'Startup', 
    'Hackathon', 
    'ThoughtLeadership', 
    'Institution', 
    'Degree', 
    'Certification', 
    'Podcast', 
    'Publication',
    'Role',
    'Year'
]

CORTEX_DRIVE_RELATIONSHIPS = [
    'BELONGS_TO_EPISODE', 'COVERED_BY_EPISODE', 'COVERS_CONCEPT',
    'COVERS_TECHNOLOGY', 'GUEST_ON', 'HAS_CHUNK', 'HAS_EPISODE',
    'HAS_REFERENCE_LINK', 'HAS_TOPIC', 'HOSTS', 'INTERVIEWED_BY',
    'IS_SIMILAR', 'LEARNING_FROM',
    # Deprecated: 'IS_A_GUEST' replaced by 'GUEST_ON'
    # Deprecated: 'IS_A_HOST' replaced by 'HOSTS'
    'LISTENS_TO', 'LISTENS_TO_EPISODE', 'MENTIONED',
    'SEMANTICALLY_SIMILAR_KNN', 'SIMILAR', 'SUBSCRIBES_TO',
    'HAS_SOURCE', 'CONTAINS', 'BELONGS_TO_SOURCE'
]

# Relationships permitted in neighbor-traversal Cypher queries (used in _fragment_neighbor_aggregation
# and expand_node_topology). Add new relationship types here — never hardcode them in expert_tools.py.
TRAVERSAL_RELATIONSHIPS = [
    # Career domain — HAS_ACCESS removed: authorization is now Permify-only (Invariant 9)
    'HELD_ROLE', 'AT', 'CONTRIBUTED_TO', 'PARTICIPATED_IN',
    'EARNED_DEGREE', 'FROM_INSTITUTION', 'HAS_SKILL', 'CONTAINS',
    'HAS_REFERENCE', 'BUILT_DURING', 'FEATURE_GUEST',
    'AUTHORED', 'CO_AUTHORED', 'PUBLISHED_BY',
    # Private notes — traversable by owner; Permify is_private attribute enforces non-owner exclusion
    'HAS_PRIVATE_NOTE',
    # Current work — CURRENTLY_BUILDING connects Person to the active Project node (e.g. Cortex-Drive)
    'CURRENTLY_BUILDING',
    # Education relationships (used by seeder for Degree / Certification / ProfessionalEducation)
    'GRADUATED_FROM', 'STUDIED_AT', 'CERTIFIED_BY',
    # Certification -> the ThoughtLeadership/Publication it was awarded for (distinct credential,
    # cross-referenced so the two entities aren't structurally disconnected)
    'AWARDED_FOR',
    # Similarity / cross-domain
    'SIMILAR', 'IS_SIMILAR', 'DISCUSSES', 'MENTIONS', 'COVERS',
    # Podcast domain
    'HAS_TOPIC', 'COVERS_TECHNOLOGY', 'DISCUSSES_CONCEPT',
    'HAS_EPISODE', 'HOSTS', 'GUEST_ON', 'INTERVIEWED_BY',
    # Leadership / portfolio
    'LED', 'HAS_PORTFOLIO',
]

PROJECT_GRAPH_RELATIONSHIPS = [
    'HAS_PURPOSE', 'DELIVERS', 'USES_TECH', 'USES_APPROACH', 'INVOLVES',
    'HAS_OBJECTIVE', 'DEFINES_OUTCOMES', 'HAS_BENEFIT', 'MEASURED_BY',
    'HAS_CRITERIA', 'HAS_RESULTS', 'HAS_PLAN', 'USES_METHOD', 'USES_TOOL',
    'HAS_TIMELINE', 'HAS_MILESTONES', 'HAS_STEP', 'HAS_ROLE', 'INCLUDES',
    'RESPONSIBLE_FOR', 'HAS_TASK', 'HAS_DELIVERABLE',
    'HELD_ROLE', 'AT', 'CONTRIBUTED_TO', 'WORKED_AT',
    'EARNED_DEGREE', 'FROM_INSTITUTION', 'HAS_SKILL',
    'PARTICIPATED_IN', 'BUILT_DURING', 'AUTHORED', 'CO_AUTHORED', 'EARNED', 'LED',
    'DERIVED_FROM', 'ACTIVE_DURING',
    # Private notes — composition edge from Project/TL/Hackathon to PreparatoryNote
    'HAS_PRIVATE_NOTE',
    # Federated Discovery Relationships
    'STORES', 'FEDERATED_TO', 'DOCUMENTED_BY'
]

# Subset of relationships that carry downward permission inheritance in Permify.
# Test: "If the parent node is deleted, should the child cease to exist?"
# Only YES answers belong here. Back-edges, activity links, and semantic refs are excluded.
# Used by: bootstrap_parent_tuples.py, ingestion_engine._register_parent_tuples(),
#          POST /api/share/infer BFS traversal.
# Source of truth: documents/daily_logs/daily_log-2026-06-29.md (Phase 0 query results)
COMPOSITION_RELATIONSHIPS = [
    # Podcast domain — downward content hierarchy
    'HAS_EPISODE',       # Podcast → Episode (6 live edges)
    'HAS_SOURCE',        # Episode → Source (6 live edges)
    'CONTAINS',          # Source → Chunk (208 org-tenant edges); SYSTEM-parent edges excluded by bootstrap guard
    # Owned reference/note content — ceases to exist without parent
    'HAS_REFERENCE',     # ThoughtLeadership/Project/Hackathon → ReferenceLink (5 live edges)
    'HAS_PRIVATE_NOTE',  # Project/ThoughtLeadership/Hackathon → PreparatoryNote (24 live org edges)
]

# Relationships confirmed as NON-composition. Listed explicitly so future code review
# can verify no new composition edge has been silently added to TRAVERSAL_RELATIONSHIPS.
NON_COMPOSITION_RELATIONSHIPS = [
    # Back-edge — reverse direction of CONTAINS, never carries downward inheritance
    'BELONGS_TO_SOURCE',
    # Activity/participation — actor exists independently of subject
    'CONTRIBUTED_TO', 'PARTICIPATED_IN', 'HELD_ROLE', 'AUTHORED', 'CO_AUTHORED',
    'LED', 'CREATED', 'CURRENTLY_BUILDING', 'WORKED_AT',
    # Career achievement — achievement node exists independently of the person
    'GRADUATED_FROM', 'CERTIFIED_BY', 'STUDIED_AT',
    # Semantic/reference — cross-domain, never ownership
    'SIMILAR', 'IS_SIMILAR', 'SEMANTICALLY_SIMILAR_KNN', 'DISCUSSES',
    'COVERS_TECHNOLOGY', 'HAS_TOPIC', 'MENTIONED', 'COVERS', 'IS_A',
    # Navigation/identity — structural identity, not ownership
    'HAS_PORTFOLIO', 'REPRESENTS', 'AT', 'FEATURE_GUEST',
    'HOSTS', 'GUEST_ON', 'INTERVIEWED_BY',
]

class Neo4jBaseModel(BaseModel):
    """Base model for all entries in CortexDrive Neo4j database."""
    tenant_id: str = Field(..., description="The Clerk Organization ID for data isolation.")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Generic metadata store.")

    @validator('tenant_id')
    def tenant_id_must_be_clerk_org(cls, v):
        primary_tenant = os.environ.get("TENANT_ID")
        fallback_tenant = os.environ.get("TEST_TENANT", "test-tenant")
        
        # Allow if it's a Clerk ID, or matches the primary config, or matches the fallback config
        if v.startswith('org_'):
            return v
        if v == primary_tenant or v == fallback_tenant or v == "test-tenant":
            return v
            
        raise ValueError(
            f"tenant_id must be a valid Clerk Organization ID (org_...) or match configured IDs. "
            f"Current primary: {primary_tenant}, fallback: {fallback_tenant}"
        )

class EpisodeNode(Neo4jBaseModel):
    """Schema for Episode nodes."""
    name: str = Field(..., description="The title of the podcast episode.")
    number: int = Field(..., description="Episode number.")
    link: Optional[str] = Field(None, description="URL to the episode source.")
    description: Optional[str] = None
    published_date: Optional[str] = Field(None, description="Date the episode was published.")

class ChunkNode(Neo4jBaseModel):
    """Schema for text chunks extracted from transcripts."""
    text: str = Field(..., min_length=1, description="The transcript text segment.")
    embedding: List[float] = Field(..., description="Vector representation of the chunk text.")
    order: int = Field(..., description="Sequence order within the episode.")
    startTime: Optional[int] = Field(None, description="Start time offset in seconds.")
    endTime: Optional[int] = Field(None, description="End time offset in seconds.")
    
    @validator('embedding')
    def validate_embedding_dimensions(cls, v):
        # standard text-embedding-ada-002 is 1536
        if len(v) != 1536:
            # We log a warning but allow it for other models (e.g. Gemini)
            # but usually, inconsistency here breaks kNN
            pass
        return v
    
class SourceNode(Neo4jBaseModel):
    """Schema for data sources (Local files, URLs, YouTube videos, etc)."""
    type: str = Field(..., description="Adapter source type e.g., LocalFile, URL, YouTube")
    fileName: Optional[str] = Field(None, description="Original file name if applicable.")
    fileSource: Optional[str] = Field(None, description="Origin source identifier (e.g. ep1654).")
    ingestedAt: Optional[str] = Field(None, description="Datetime of ingestion.")
    url: Optional[str] = Field(None, description="Web URL if ingested from web.")
    videoId: Optional[str] = Field(None, description="YouTube Video ID if applicable.")
    

class TopicNode(Neo4jBaseModel):
    """Schema for inferred Topics."""
    name: str = Field(..., description="Name of the topic/theme.")
    summary: Optional[str] = None
    importance: float = Field(0.0, description="Inferred importance score.")

class PersonNode(Neo4jBaseModel):
    """Schema for Hosts/Guests/Listeners."""
    name: str = Field(..., description="Full name of the person.")
    role: Optional[str] = None # Host, Guest, Researcher

class PodcastNode(Neo4jBaseModel):
    """Schema for Podcast nodes."""
    title: str = Field(..., description="The title of the podcast.")
    id: str = Field(..., description="Unique ID for the podcast.")

class ReferenceLinkNode(Neo4jBaseModel):
    """Schema for ReferenceLink nodes."""
    text: str = Field(..., description="Link display text.")
    url: str = Field(..., description="The actual URL.")

class TechnologyNode(Neo4jBaseModel):
    """Schema for Technology mentioned in episodes."""
    name: str = Field(..., description="Name of the technology.")

class ConceptNode(Neo4jBaseModel):
    """Schema for Concepts mentioned in episodes."""
    name: str = Field(..., description="Name of the concept.")
    description: Optional[str] = None

class GenericProjectNode(Neo4jBaseModel):
    """Generic schema for project-related components."""
    text: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    link: Optional[str] = None

class InfrastructureNode(Neo4jBaseModel):
    """Schema for system/infrastructure nodes like __MetaContext__."""
    useCase: Optional[str] = None
    context: Optional[str] = None
    version: Optional[int] = None

class CompanyNode(Neo4jBaseModel):
    """Schema for Company or Organization nodes."""
    name: str = Field(..., description="Name of the company or organization.")
    industry: Optional[str] = None
    description: Optional[str] = None

class InstitutionNode(Neo4jBaseModel):
    """Schema for Educational Institutions."""
    name: str = Field(..., description="Name of the university/institution.")
    location: Optional[str] = None

class DegreeNode(Neo4jBaseModel):
    """Schema for degrees earned."""
    name: str = Field(..., description="Name of the degree.")
    year: str = Field(..., description="Graduation year.")

class SkillNode(Neo4jBaseModel):
    """Schema for technical and soft skills."""
    name: str = Field(..., description="Name of the skill.")
    category: Optional[str] = None

class ExternalSiloNode(Neo4jBaseModel):
    """Schema for External Silos (S3, GitHub, Confluence)."""
    name: str = Field(..., description="The unique identifier or URL of the silo.")
    type: str = Field(..., description="The type of silo (e.g., ObjectStore, VCS, Wiki).")
    provider: Optional[str] = None
    region: Optional[str] = None
    description: Optional[str] = None
    isIceberg: bool = Field(False, description="Whether this silo follows the Iceberg metadata pattern.")

class TableMetadataNode(Neo4jBaseModel):
    """Schema for Iceberg Table Metadata."""
    name: str = Field(..., description="The table name.")
    format: str = Field("Iceberg")
    partitioning: Optional[str] = None

class PageMetadataNode(Neo4jBaseModel):
    """Schema for Wiki/Page Metadata."""
    name: str = Field(..., description="The page title.")
    pageId: Optional[str] = None
    status: Optional[str] = None

# --- Universal Source Connector Models (Phase A+) ---
# See documents/architecture/source-metadata-template-2026-08-19.md §2 and
# documents/architecture/phase-a-web-url-adapter-design-2026-08-19.md for the full design.
# SourceBaseModel is NOT its own Neo4j label — each concrete type below inherits its
# fields via Python class inheritance and is registered under its own single Neo4j label
# (see SOURCE_CONNECTOR_LABELS above for why, not a shared `:Source` label).

class SourceBaseModel(Neo4jBaseModel):
    """Shared fields for every Universal Source Connector type. Not instantiated directly —
    each concrete <Type>Source class below inherits these fields.

    NOTE: no `source_id`/identity field is declared here, by design — matching this
    repo's established convention (EpisodeNode, CompanyNode, etc. don't declare `node_id`
    in Pydantic either). `node_id` is a stable UUID set at the Cypher level via
    `ON CREATE SET s.node_id = randomUUID()`, entirely outside Pydantic validation, and is
    what every ID-based lookup in expert_tools.py (get_node_details, get_cluster_context,
    connect_knowledge_on_demand — all match on literal `n.node_id`) actually keys on. An
    earlier draft of this model declared `source_id` as a required Pydantic field, which
    would have made these nodes invisible to every existing ID-based lookup tool — caught
    and corrected before the write path was built against it."""
    source_type: str = Field(..., description=f"One of {SOURCE_CONNECTOR_TYPES}.")
    name: str = Field(..., description="Human-readable label.")
    description: Optional[str] = None
    uri: str = Field(..., description="Canonical locator (connection alias, URL, file path). Never a raw credential or connection string with embedded secrets.")
    owner_id: str = Field(..., description="Clerk user ID of the registering user.")
    status: str = Field("active", description=f"One of {SOURCE_CONNECTOR_STATUSES}.")
    metadata_schema_version: int = Field(1, description="Version of this Pydantic template shape — bumped when a Layer 1/2 model gains or loses a field.")
    current_snapshot_id: Optional[str] = Field(None, description="Pointer to the current SourceSnapshot's node_id — the Iceberg 'current' pointer.")
    credential_ref_id: Optional[str] = Field(None, description="Pointer to a CredentialRef node. Null if the source needs no auth.")
    primary_content_category: Optional[str] = Field(None, description="Coarse content-classification hint, set at registration time if known upfront. Fine-grained per-document classification is a later phase, not populated by Phase A.")
    last_synced_at: Optional[str] = Field(None, description="ISO datetime of the last successful sync.")
    sync_frequency: Optional[str] = Field(None, description="For scheduled sources only.")
    error_message: Optional[str] = Field(None, description="Last error, only populated when status = error.")

    @validator('source_type')
    def source_type_must_be_known(cls, v):
        if v not in SOURCE_CONNECTOR_TYPES:
            raise ValueError(f"source_type must be one of {SOURCE_CONNECTOR_TYPES}, got '{v}'")
        return v

    @validator('status')
    def status_must_be_known(cls, v):
        if v not in SOURCE_CONNECTOR_STATUSES:
            raise ValueError(f"status must be one of {SOURCE_CONNECTOR_STATUSES}, got '{v}'")
        return v

class WebsiteSource(SourceBaseModel):
    """Schema for Phase A (unauthenticated) / Phase A.5 (authenticated) web URL sources."""
    base_url: str = Field(..., description="The registered URL.")
    requires_auth: bool = Field(False, description="False for Phase A; True distinguishes Phase A.5 sources.")
    auth_type: Optional[str] = Field(None, description="none | basic | oauth | session_cookie — null for Phase A.")
    crawl_scope: str = Field("single_page", description="single_page | subdomain | allowlist")
    content_type_hint: Optional[str] = Field(None, description="article | wiki | dashboard | spa")
    extraction_method: str = Field("trafilatura", description="trafilatura | firecrawl | jina_reader")
    robots_txt_compliant: bool = Field(True)

    @validator('crawl_scope')
    def crawl_scope_must_be_known(cls, v):
        allowed = ['single_page', 'subdomain', 'allowlist']
        if v not in allowed:
            raise ValueError(f"crawl_scope must be one of {allowed}, got '{v}'")
        return v

    @validator('extraction_method')
    def extraction_method_must_be_known(cls, v):
        allowed = ['trafilatura', 'firecrawl', 'jina_reader']
        if v not in allowed:
            raise ValueError(f"extraction_method must be one of {allowed}, got '{v}'")
        return v

class SourceSnapshot(Neo4jBaseModel):
    """Iceberg-style content versioning for Universal Source Connector sources — one node
    per fetch that actually changed content, linked via HAS_SNAPSHOT. Exactly one
    is_current=True snapshot per source at any time.

    No `snapshot_id` field, by the same convention as SourceBaseModel above — identity is
    `node_id`, set via `ON CREATE SET snap.node_id = randomUUID()` at the Cypher level."""
    content_hash: str = Field(..., description="SHA-256 of the extracted/parsed content.")
    metadata_schema_version: int = Field(..., description="Which SourceBaseModel/WebsiteSource template version this snapshot conforms to.")
    fetched_at: str = Field(..., description="ISO datetime of this fetch.")
    is_current: bool = Field(..., description="Exactly one True per source at any time.")
    change_summary: Optional[str] = Field(None, description="Optional human-readable note on what changed.")

def validate_upsert(label: str, data: Dict[str, Any]):
    """
    Validation gate to be called before any Neo4j CREATE/MERGE.
    """
    model_map = {
        'Podcast': PodcastNode,
        'Episode': EpisodeNode,
        'Chunk': ChunkNode,
        'Topic': TopicNode,
        'Person': PersonNode,
        'ReferenceLink': ReferenceLinkNode,
        'Technology': TechnologyNode,
        'Concept': ConceptNode,
        'Source': SourceNode,
        # Project Graph Labels
        'Project': GenericProjectNode,
        'Purpose': GenericProjectNode,
        'Objective': GenericProjectNode,
        'Value': GenericProjectNode,
        'Benefit': GenericProjectNode,
        'Metric': GenericProjectNode,
        'Outcome': GenericProjectNode,
        'SuccessCriteria': GenericProjectNode,
        'MeasurableResult': GenericProjectNode,
        'Approach': GenericProjectNode,
        'Plan': GenericProjectNode,
        'Method': GenericProjectNode,
        'MethodStep': GenericProjectNode,
        'Tool': GenericProjectNode,
        'Timeline': GenericProjectNode,
        'Milestone': GenericProjectNode,
        'Team': GenericProjectNode,
        'Role': GenericProjectNode,
        'Responsibility': GenericProjectNode,
        'Task': GenericProjectNode,
        'Deliverable': GenericProjectNode,
        'TeamMember': GenericProjectNode,
        'Company': CompanyNode,
        'Degree': DegreeNode,
        'Institution': InstitutionNode,
        'Skill': SkillNode,
        'Startup': GenericProjectNode,
        'Hackathon': GenericProjectNode,
        'Certification': GenericProjectNode,
        'Publication': GenericProjectNode,
        'OpenSource': GenericProjectNode,
        'SocialLearning': GenericProjectNode,
        'Category': GenericProjectNode,
        'Year': GenericProjectNode,
        # Federated Models
        'ExternalSilo': ExternalSiloNode,
        'DataLake': ExternalSiloNode,
        'GitHub': ExternalSiloNode,
        'Confluence': ExternalSiloNode,
        'TableMetadata': TableMetadataNode,
        'PageMetadata': PageMetadataNode,
        # Universal Source Connector Models (Phase A+) — see SOURCE_CONNECTOR_LABELS above
        'WebsiteSource': WebsiteSource,
        'SourceSnapshot': SourceSnapshot,
        # System/Infrastructure
        '__MetaContext__': InfrastructureNode
    }
    
    if label not in model_map:
        raise ValueError(f"Unknown node label: {label}. Please use a label defined in the schema guard.")
        
    return model_map[label](**data)
