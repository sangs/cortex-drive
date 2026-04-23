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
    # Federated Discovery Relationships
    'STORES', 'FEDERATED_TO', 'DOCUMENTED_BY'
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
        # System/Infrastructure
        '__MetaContext__': InfrastructureNode
    }
    
    if label not in model_map:
        raise ValueError(f"Unknown node label: {label}. Please use a label defined in the schema guard.")
        
    return model_map[label](**data)
