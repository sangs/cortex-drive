from typing import List, Optional
from datetime import date
from pydantic import BaseModel, Field, HttpUrl
from enum import Enum


# ---------- Relationship Enums ----------

class PersonRel(str, Enum):
    """Relationships originating from Person node."""
    SUBSCRIBES_TO = "SUBSCRIBES_TO"
    LISTENS_TO = "LISTENS_TO"
    LEARNING_FROM = "LEARNING_FROM"
    IS_A_HOST = "IS_A_HOST"
    IS_A_GUEST = "IS_A_GUEST"


class PodcastEpisodeRel(str, Enum):
    HAS_EPISODE = "HAS_EPISODE"


class EpisodeTopicRel(str, Enum):
    HAS_TOPIC = "HAS_TOPIC"


class EpisodeChunkRel(str, Enum):
    HAS_CHUNK = "HAS_CHUNK"


class TopicConceptRel(str, Enum):
    COVERS_CONCEPT = "COVERS_CONCEPT"


class TopicTechnologyRel(str, Enum):
    COVERS_TECHNOLOGY = "COVERS_TECHNOLOGY"


# ---------- Core Node Models ----------

class ReferenceLink(BaseModel):
    text: str
    url: HttpUrl


class TranscriptChunk(BaseModel):
    order: int
    text: str
    file_name: Optional[str] = None
    file_source: Optional[str] = None


class Concept(BaseModel):
    name: str
    description: Optional[str] = None


class Technology(BaseModel):
    name: str
    description: Optional[str] = None


class Topic(BaseModel):
    name: str
    description: Optional[str] = None
    concepts: List[Concept] = Field(default_factory=list)
    technologies: List[Technology] = Field(default_factory=list)

    # Enum relations for graph mapping
    rel_covers_concept: TopicConceptRel = Field(default=TopicConceptRel.COVERS_CONCEPT)
    rel_covers_technology: TopicTechnologyRel = Field(default=TopicTechnologyRel.COVERS_TECHNOLOGY)


class Episode(BaseModel):
    name: str
    number: int
    published_date: Optional[date] = None
    link: Optional[HttpUrl] = None
    description: Optional[str] = None
    reference_links: List[ReferenceLink] = Field(default_factory=list)
    topics: List[Topic] = Field(default_factory=list)
    transcript_chunks: List[TranscriptChunk] = Field(default_factory=list)

    # Enum relations for graph mapping
    rel_has_topic: EpisodeTopicRel = Field(default=EpisodeTopicRel.HAS_TOPIC)
    rel_has_chunk: EpisodeChunkRel = Field(default=EpisodeChunkRel.HAS_CHUNK)


class Podcast(BaseModel):
    title: str
    description: Optional[str] = None
    episodes: List[Episode] = Field(default_factory=list)

    # Enum relations for graph mapping
    rel_has_episode: PodcastEpisodeRel = Field(default=PodcastEpisodeRel.HAS_EPISODE)


class Person(BaseModel):
    """Person node — can subscribe, listen, learn, or host/guest episodes/podcasts."""
    name: str

    # Related entities
    subscribes_to: List[Podcast] = Field(default_factory=list)
    listens_to: List[Episode] = Field(default_factory=list)
    learning_from: List[Episode] = Field(default_factory=list)
    hosts: List[Podcast] = Field(default_factory=list)
    guests_on: List[Episode] = Field(default_factory=list)

    # Enum references for relationship types
    rel_subscribes_to: PersonRel = Field(default=PersonRel.SUBSCRIBES_TO)
    rel_listens_to: PersonRel = Field(default=PersonRel.LISTENS_TO)
    rel_learning_from: PersonRel = Field(default=PersonRel.LEARNING_FROM)
    rel_is_a_host: PersonRel = Field(default=PersonRel.IS_A_HOST)
    rel_is_a_guest: PersonRel = Field(default=PersonRel.IS_A_GUEST)