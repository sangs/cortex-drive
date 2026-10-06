// Phase B document extraction (L3). Follows the pattern of web_extract.baml / extract.baml —
// see documents/architecture/multimodal-document-processing-pipeline-2026-08-19.md §9.1 and
// documents/architecture/phase-b-document-ingestion-build-plan-2026-10-01.md (M2).
//
// Reuses the Concept/Technology/Person/ReferenceLink classes from extract.baml (all .baml files
// merge into one schema). DocumentRelationshipType is file-scoped, like WebRelationshipType, so
// nothing here can change the live podcast (RelationshipType) or website extraction behavior.
//
// Two-speed ingestion runs this ONE function twice: stage 1 with the document text
// (vision_descriptions = ""), stage 2 with the L2 figure descriptions (parsed_content = "").
// Bounding boxes never come from here; they come from the L1 parser. Content categories are
// deferred until a CONTENT_CATEGORIES taxonomy constant exists (none in domain_registry.py yet).

class DocumentGraphExtraction {
  title string
  description string
  concepts Concept[]
  technologies Technology[]
  people Person[]
  reference_links ReferenceLink[]
  relationships DocumentRelationship[]
}

enum DocumentRelationshipType {
  DISCUSSES
  MENTIONS
  COVERS_TECHNOLOGY
}

class DocumentRelationship {
  source_node string
  target_node string
  relationship_type DocumentRelationshipType
}

function ExtractDocumentGraph(parsed_content: string, vision_descriptions: string, document_title: string) -> DocumentGraphExtraction {
  client GPT4o
  prompt #"
    {{ ctx.output_format }}

    GIVE ME THE FINAL JSON AND NOTHING ELSE.
    NO MARKDOWN. NO HEADERS. NO EXPLANATIONS.

    Extract a structured summary of the document content below into the JSON schema above.

    GROUNDING RULES (most important):
    1. Extract ONLY entities that appear in the content below. Never add people, links, tools or
       ideas from your own knowledge, even if you know the document or its authors.
    2. `people`: only people NAMED in the content. Example email addresses, placeholder names and
       sample data are not people. Organizations are not people.
    3. `reference_links`: only URLs that appear verbatim in the content. Never construct or
       complete a URL. Write ligatures as plain letters (e.g. "tensorflow", not "tensorﬂow").
    4. Numbers, scores and measurements are not entities.

    CRITICAL INSTRUCTIONS:
    5. Populate `concepts`, `technologies` and `people` explicitly with every entity you use in a
       relationship.
    6. For relationships from the document itself, use the exact document title
       ("{{ document_title }}") as `source_node`; use the exact entity `name` as `target_node`.
    7. `title`: the document's actual title. `description`: a concise 2-4 sentence summary of
       what the content is about. If the content is only figure descriptions, summarize those.
    8. Use EXACTLY the field names in the schema (all lowercase).

    Relationship rules:
    - DISCUSSES (Document -> Concept): concepts the document discusses.
    - COVERS_TECHNOLOGY (Document -> Technology): tools/technologies the document covers.
    - MENTIONS (Document -> Person): people mentioned by name.

    Document title: {{ document_title }}

    Document text:
    ---
    {{ parsed_content }}
    ---

    Figure descriptions (from the visual describer; may be empty):
    ---
    {{ vision_descriptions }}
    ---
  "#
}
