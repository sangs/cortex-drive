// Phase A web-URL extraction. Follows the exact pattern of extract.baml's ExtractGraph —
// see documents/architecture/phase-a-web-url-adapter-design-2026-08-19.md §5.
//
// Reuses Concept/Technology/Person/ReferenceLink classes already defined in extract.baml
// (all .baml files in baml_src/ merge into one combined schema — no import needed, exactly
// how this file's ExtractWebPage function reuses the GPT4o client from clients.baml without
// declaring it locally).
//
// Deliberately does NOT reuse extract.baml's Relationship/RelationshipType — that enum is
// podcast-specific (INTERVIEWED_BY, GUEST_ON, HOSTS, ...) and already backs the live,
// working podcast ingestion pipeline. WebRelationshipType below is scoped to this new
// extraction path so nothing here can affect ExtractGraph's behavior.

class WebPageExtraction {
  title string
  description string
  concepts Concept[]
  technologies Technology[]
  people Person[]
  reference_links ReferenceLink[]
  relationships WebRelationship[]
}

enum WebRelationshipType {
  DISCUSSES
  MENTIONS
  COVERS_TECHNOLOGY
}

class WebRelationship {
  source_node string
  target_node string
  relationship_type WebRelationshipType
}

function ExtractWebPage(content: string, url: string) -> WebPageExtraction {
  client GPT4o
  prompt #"
    {{ ctx.output_format }}

    GIVE ME THE FINAL JSON AND NOTHING ELSE.
    NO MARKDOWN. NO HEADERS. NO EXPLANATIONS.

    Analyze the following web page content and extract a structured summary into the JSON schema defined above.

    CRITICAL INSTRUCTIONS:
    1. You MUST explicitly populate the `concepts`, `technologies`, and `people` arrays with the entities you find. Do NOT skip defining them even if you use them in relationships.
    2. For relationships connecting to the page itself, you MUST use the exact page URL ("{{ url }}") as the `source_node`.
    3. `description` must be a concise 2-4 sentence summary of what this page is about — this becomes the page's stored description.
    4. `title` must be the page's actual title (from a heading or the most prominent text), not a paraphrase.

    - Use EXACTLY the field names in the schema (all lowercase).
    - Do NOT capitalize field names like "Concepts" or "Relationships".
    - For relationships, use 'source_node', 'target_node', and 'relationship_type'.
    - In 'source_node' and 'target_node', use the EXACT 'name' of the entity, or the page URL for the page itself.

    Page URL: {{ url }}
    Page Content:
    ---
    {{ content }}
    ---

    Relationship Rules:
    - DISCUSSES (Page -> Concept): What concepts does this page discuss?
    - COVERS_TECHNOLOGY (Page -> Technology): What tools/technologies does this page cover?
    - MENTIONS (Page -> Person): What people are mentioned by name?
  "#
}
