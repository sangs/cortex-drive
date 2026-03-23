class Podcast {
  title string
}

class Episode {
  name string
  number int
  description string?
}

class Topic {
  name string
  description string?
}

class Concept {
  name string
  description string?
}

class Technology {
  name string
  description string?
}

class Person {
  name string
  role ("Host" | "Guest" | "Referenced Expert")?
}

class ReferenceLink {
  text string
  url string
}

enum RelationshipType {
  INTERVIEWED_BY
  LEARNING_FROM
  COVERS_CONCEPT
  COVERS_TECHNOLOGY
  HAS_TOPIC
  HAS_REFERENCE_LINK
  GUEST_ON
  HOSTS
  MENTIONED
  LISTENS_TO
  LISTENS_TO_EPISODE
  SUBSCRIBES_TO
}

class Relationship {
  source_node string
  target_node string
  relationship_type RelationshipType
}

class GraphExtraction {
  podcasts Podcast[]
  episodes Episode[]
  topics Topic[]
  concepts Concept[]
  technologies Technology[]
  people Person[]
  links ReferenceLink[]
  relationships Relationship[]
}

function ExtractGraph(transcript: string, episode_title: string) -> GraphExtraction {
  client GPT4o
  prompt #"
    {{ baml_output_format }}

    GIVE ME THE FINAL JSON AND NOTHING ELSE.
    NO MARKDOWN. NO HEADERS. NO EXPLANATIONS.

    Analyze the podcast transcript and extract the complete graph structure into the JSON schema defined above.
    
    CRITICAL INSTRUCTIONS: 
    1. You MUST explicitly populate the `topics`, `concepts`, `technologies`, and `people` arrays with the entities you find. Do NOT skip defining them even if you use them in relationships.
    2. For relationships connecting to the podcast episode itself, you MUST use the provided exact episode title ("{{ episode_title }}") as the `source_node` or `target_node`.
    3. You MUST use Topics as clustering anchors. Link Concepts and Technologies to the Topic they belong to, rather than linking them directly to the Episode if possible.
    
    - Use EXACTLY the field names in the schema (all lowercase).
    - Do NOT capitalize field names like "Topics" or "Relationships".
    - For relationships, use 'source_node', 'target_node', and 'relationship_type'.
    - In 'source_node' and 'target_node', use the EXACT 'name' or 'title' of the node.

    Transcript:
    ---
    {{ transcript }}
    ---

    Core Schema and Relationship Rules:
    - INTERVIEWED_BY (Person -> Person): Who interviewed whom?
    - LEARNING_FROM (Person -> Topic/Concept/Tech/Person): Who is a mentor or source of knowledge?
    - GUEST_ON (Person -> Episode/Podcast): Who was a guest?
    - HOSTS (Person -> Episode/Podcast): Who hosted?
    - MENTIONED (Entity -> Episode): What was mentioned in the episode?
    - COVERS_CONCEPT (Topic -> Concept): Which topic explains this concept?
    - COVERS_TECHNOLOGY (Topic -> Technology): Which topic discusses this tool/tech?
    - HAS_TOPIC (Episode -> Topic): What main topics are in this episode?
    - HAS_REFERENCE_LINK (Episode -> ReferenceLink)
  "#
}
