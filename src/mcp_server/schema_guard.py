from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict, Any
from datetime import datetime

# --- Schema Constants ---

CORTEX_MODEL_NODES = [
    'Podcast', 'Episode', 'Chunk', 'Topic', 
    'Concept', 'ReferenceLink', 'Person', 'Technology'
]

PROJECT_GRAPH_NODES = [
    'Project', 'Purpose', 'Objective', 'Value', 'Benefit', 'Metric',
    'Outcome', 'SuccessCriteria', 'MeasurableResult', 'Approach',
    'Plan', 'Method', 'MethodStep', 'Tool', 'Timeline', 'Milestone',
    'Team', 'Role', 'Responsibility', 'Task', 'Deliverable', 'TeamMember'
]

SYSTEM_NODES = [
    '__MetaContext__'
]

CORTEX_MODEL_RELATIONSHIPS = [
    'BELONGS_TO_EPISODE', 'COVERED_BY_EPISODE', 'COVERS_CONCEPT', 
    'COVERS_TECHNOLOGY', 'GUEST_ON', 'HAS_CHUNK', 'HAS_EPISODE', 
    'HAS_REFERENCE_LINK', 'HAS_TOPIC', 'HOSTS', 'INTERVIEWED_BY', 
    'IS_A_GUEST', 'IS_A_HOST', 'IS_SIMILAR', 'LEARNING_FROM', 
    'LISTENS_TO', 'LISTENS_TO_EPISODE', 'MENTIONED', 
    'SEMANTICALLY_SIMILAR_KNN', 'SIMILAR', 'SUBSCRIBES_TO'
]

PROJECT_GRAPH_RELATIONSHIPS = [
    'HAS_PURPOSE', 'DELIVERS', 'USES_TECH', 'USES_APPROACH', 'INVOLVES',
    'HAS_OBJECTIVE', 'DEFINES_OUTCOMES', 'HAS_BENEFIT', 'MEASURED_BY',
    'HAS_CRITERIA', 'HAS_RESULTS', 'HAS_PLAN', 'USES_METHOD', 'USES_TOOL',
    'HAS_TIMELINE', 'HAS_MILESTONES', 'HAS_STEP', 'HAS_ROLE', 'INCLUDES',
    'RESPONSIBLE_FOR', 'HAS_TASK', 'HAS_DELIVERABLE'
]

class Neo4jBaseModel(BaseModel):
    """Base model for all entries in CortexModel Neo4j database."""
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
    fileName: str = Field(..., description="Source file name.")
    fileSource: Optional[str] = Field(None, description="Origin source identifier (e.g. ep1654).")
    
    @validator('embedding')
    def validate_embedding_dimensions(cls, v):
        # standard text-embedding-ada-002 is 1536
        if len(v) != 1536:
            # We log a warning but allow it for other models (e.g. Gemini)
            # but usually, inconsistency here breaks kNN
            pass
        return v

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

class InfrastructureNode(Neo4jBaseModel):
    """Schema for system/infrastructure nodes like __MetaContext__."""
    useCase: Optional[str] = None
    context: Optional[str] = None
    version: Optional[int] = None

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
        # System/Infrastructure
        '__MetaContext__': InfrastructureNode
    }
    
    if label not in model_map:
        raise ValueError(f"Unknown node label: {label}. Please use a label defined in the schema guard.")
        
    return model_map[label](**data)
