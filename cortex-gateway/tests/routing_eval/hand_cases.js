'use strict';
/**
 * Hand-labelled routing cases (cross-domain discovery design 2026-11-09 §4.1, evaluation gate).
 * [question, domains that should be searched, mode, rule, note?]
 * Domains use the classifier's names: career, podcast, website, document.
 * Modes: single | cross | bridge (today's Q3 "how did X influence Y" path) | clarify | discovery (Flow 4).
 * Labelling rules (README.md): G1 explicit scope word; G2 container phrase; G3 a source title; G4 named person +
 * own work; G5 topic only, broad → every domain with content on it (coverage snapshot); G6 influence/trace →
 * bridge; G7 nothing recognised → discovery; G8 ambiguous person / pronoun → clarify; G9 small talk, out of scope,
 * open discovery → their §4.5 modes (no search).
 */
module.exports = [
    // Canonical and regression questions (documents/user_queries.md; e2e baseline 2026-10-06)
    ['What have experts discussed about graph-native AI architectures and knowledge graphs in the podcast episodes?', ['podcast'], 'single', 'G1', 'Q1'],
    ["What is the decision trace from Sangeetha's AI governance and explainability work at JPMorgan Chase to the zero-trust security architecture of Cortex-Drive?", ['career'], 'bridge', 'G6', 'Q2'],
    ['Show the institutional memory map of Sangeetha Ramadurai—her career, what she built, and what she published.', ['career'], 'single', 'G4', 'Q3'],
    ['AI ethics and governance work from known sources', ['career', 'podcast'], 'cross', 'G5', 'Q4: governance is covered in career and podcast'],
    ['What is Cortex-Drive?', ['career'], 'single', 'G3', 'P3-1'],
    ['What has Sangeetha done on accountability and oversight practices for AI systems?', ['career'], 'single', 'G4', 'P3-2'],
    ['What has Sangeetha worked on around explainability and accountability in automated decision systems?', ['career'], 'single', 'G4', 'P3-3 career'],
    ['What did podcast guests say about explainability and accountability in automated decision systems?', ['podcast'], 'single', 'G1', 'P3-3 podcast'],
    ['What was discussed about graph databases by experts in the podcast episodes?', ['podcast'], 'single', 'G1', 'P3-4'],
    ['graph databases', ['career', 'podcast', 'website'], 'cross', 'G5', 'P3-4 bare (today: website)'],
    ['How does Cortex-Drive connect across career and podcast content?', ['career', 'podcast'], 'bridge', 'G6', 'P3-5'],
    ['Find episodes discussing graph databases', ['podcast'], 'single', 'G1', 'Invariant 10 single-domain'],
    ['Show career map of Sangeetha Ramadurai', ['career'], 'single', 'G4', 'Invariant 10 identity map'],
    ["How did Sangeetha's thought leadership influence Cortex-Drive?", ['career'], 'bridge', 'G6', 'Invariant 10 cross-domain bridge'],
    ['What does sangeetha ramadurai does at cortex-drive?', ['career'], 'single', 'G4', 'W-1'],
    ['What has Sangeetha written about graph databases?', ['career'], 'single', 'G4', 'S2-78 a'],
    ["Find podcasts and Sangeetha's work on graph databases", ['career', 'podcast'], 'cross', 'G4', 'S2-78 b'],
    ['Who has worked on graph databases, and which talks discuss it?', ['career', 'podcast', 'website'], 'cross', 'G5', 'design D1'],
    ['Find discussion about graph databases', ['career', 'podcast', 'website'], 'cross', 'G5', 'design D2 / P1 (today: podcast)'],

    // Website
    ['What does the Graph database page say?', ['website'], 'single', 'G2'],
    ['What is on the Apache Iceberg page?', ['website'], 'single', 'G2', 'today: cross_domain (bridge entity)'],
    ['Summarize the Apache Iceberg website', ['website'], 'single', 'G2'],
    ['What does the Wikipedia article on graph databases cover?', ['website'], 'single', 'G2'],
    ['What does the Graph database page say about Neo4j?', ['website'], 'single', 'G2', 'container wins over the topic'],
    ['Tell me about Apache Iceberg', ['podcast', 'website'], 'cross', 'G5'],
    ['What do podcasts say about Apache Iceberg?', ['podcast'], 'single', 'G1'],
    ['Compare what the Apache Iceberg page and the Iceberg episode say about table formats', ['podcast', 'website'], 'cross', 'G2', 'two containers'],

    // Document
    ['What does the BERT paper say about pre-training?', ['document'], 'single', 'G2'],
    ['According to the BERT paper, how does BERT perform on GLUE?', ['document'], 'single', 'G2'],
    ['Summarise BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding.', ['document'], 'single', 'G3'],
    ['What is self-attention?', ['document'], 'single', 'G5', 'only documents cover it'],
    ['Explain fine-tuning', ['document'], 'single', 'G5'],
    ['What do my documents say about transformers?', ['document'], 'single', 'G1'],
    ['Find discussion about transformers', ['document', 'podcast'], 'cross', 'G5'],
    ['On page 3 of the BERT paper, what is the model size?', ['document'], 'single', 'G2'],
    ['In the BERT paper, what is masked language modelling?', ['document'], 'single', 'G2'],

    // Podcast
    ['Who were the guests on the KuzuDB episode?', ['podcast'], 'single', 'G1'],
    ['What was discussed in Iceberg at Netflix and Beyond with Ryan Blue?', ['podcast'], 'single', 'G3'],
    ['Which episodes of Data Engineering Podcast are there?', ['podcast'], 'single', 'G1'],
    ['What has David Soria Parra discussed about MCP?', ['podcast'], 'single', 'G3', 'guest; work only in podcast'],
    ['Find episodes about DuckDB', ['podcast'], 'single', 'G1'],
    ['What is DuckLake?', ['podcast'], 'single', 'G5', 'only podcasts cover it'],
    ['Which podcasts does Sangeetha listen to?', ['podcast'], 'single', 'G1'],
    ['What are the latest podcast episodes?', ['podcast'], 'single', 'G1'],
    ['Tell me about the Model Context Protocol episode', ['podcast'], 'single', 'G2'],
    ['What do experts say about Delta Lake?', ['podcast'], 'single', 'G5', 'only podcasts cover it'],
    ['What did the KuzuDB episode say about Cypher?', ['podcast'], 'single', 'G2'],
    ['Who are the hosts of Software Engineering Daily?', ['podcast'], 'single', 'G3'],
    ['Which episodes mention Anthropic?', ['podcast'], 'single', 'G1'],
    ['graph DB podcasts', ['podcast'], 'single', 'G1'],
    ['neo4j episodes', ['podcast'], 'single', 'G1'],

    // Career
    ['Where did Sangeetha work before JPMorgan Chase?', ['career'], 'single', 'G4'],
    ['What projects did she build at JPMorgan Chase?', ['career'], 'single', 'G3'],
    ['What did Sangeetha study at Illinois Institute of Technology?', ['career'], 'single', 'G3'],
    ["List Sangeetha's certifications", ['career'], 'single', 'G4'],
    ['What hackathons has Sangeetha participated in?', ['career'], 'single', 'G4'],
    ['Which technologies were used in Cortex-Drive?', ['career'], 'single', 'G3'],
    ['What was built at Global Hackathons @ JPMorgan Chase?', ['career'], 'single', 'G3'],
    ['What did Sangeetha do at GE Healthcare?', ['career'], 'single', 'G3'],
    ['What is the Volarisation Engine?', ['career'], 'single', 'G3'],
    ['Show her thought leadership', ['career'], 'single', 'G1'],
    ['What talks has Sangeetha given?', ['career'], 'single', 'G4', '"talks" here is her thought leadership'],
    ['What has Sangeetha published on InfoQ?', ['career'], 'single', 'G4'],
    ['Which companies has she worked at?', ['career'], 'single', 'G1'],
    ['Has Sangeetha used Neo4j?', ['career'], 'single', 'G4'],
    ['What did Sangeetha build with Kafka?', ['career'], 'single', 'G4'],
    ['What has Sangeetha written about governance?', ['career'], 'single', 'G4'],
    ["Sangeetha's experience with Kubernetes", ['career'], 'single', 'G4'],
    ["Sangeetha's projects using Python", ['career'], 'single', 'G4'],
    ['career summary', ['career'], 'single', 'G1'],
    ['What is Terraform used for?', ['career'], 'single', 'G5', 'only career covers it'],

    // Topic only, several domains
    ['Who has worked with Kafka?', ['career', 'podcast'], 'cross', 'G5'],
    ['Tell me about Kafka', ['career', 'podcast'], 'cross', 'G5'],
    ['What is known about Neo4j?', ['career', 'podcast'], 'cross', 'G5'],
    ['Find everything about MCP', ['career', 'podcast'], 'cross', 'G5'],
    ['Graph databases across my sources', ['career', 'podcast', 'website'], 'cross', 'G5'],
    ['Who discusses knowledge graphs?', ['career', 'podcast'], 'cross', 'G5', '"discusses" adds podcast weight but does not decide'],
    ['Find discussion about Snowflake', ['career', 'podcast'], 'cross', 'G5'],
    ['What is Trino?', ['podcast', 'website'], 'cross', 'G5'],
    ['Explain ACID transactions', ['podcast', 'website'], 'cross', 'G5'],
    ['Python', ['career', 'podcast', 'website'], 'cross', 'G5'],
    ['data lake vs lakehouse', ['career', 'podcast', 'website'], 'cross', 'G5', 'union of both topics'],
    ['What do I know about Rust?', ['podcast'], 'single', 'G5', 'only podcasts cover it'],

    // Bridges (today's Q3 path)
    ["How did Sangeetha's work at JPMorgan Chase shape Cortex-Drive's architecture?", ['career'], 'bridge', 'G6'],
    ["Trace the decision from Sangeetha's governance work to the security design of Cortex-Drive", ['career'], 'bridge', 'G6'],
    ['What is the relation between Apache Iceberg and the podcasts?', ['podcast', 'website'], 'bridge', 'G6'],
    ["How does the Graph database page connect to Sangeetha's projects?", ['career', 'website'], 'bridge', 'G6'],
    ["How did podcast learning influence Sangeetha's projects?", ['career', 'podcast'], 'bridge', 'G6'],

    // Nothing recognised (Flow 4) and out of scope
    ['Tell me something interesting', [], 'overview', 'G9', '§4.5 open discovery'],
    ["What's new?", [], 'overview', 'G9', '§4.5 open discovery'],
    ['Hello', [], 'small_talk', 'G9', '§4.5 small talk'],
    ['What is quantum computing?', [], 'discovery', 'G7', 'not in the graph'],
    ['Explain blockchain', [], 'discovery', 'G7', 'not in the graph'],
    ["What's the weather today?", [], 'out_of_scope', 'G9', '§4.5 out of scope'],
    ['Can you show me her resume', [], 'clarify', 'G8', '§4.5 pronoun with nothing to point to'],
    ['Tell me what was said about the speaker background in that segment', [], 'discovery', 'G7', 'existing case: confident=false'],

    // Ambiguous person
    ['What has David said about MCP?', ['podcast'], 'clarify', 'G8', 'David Hughes or David Soria Parra'],
    ['What did David discuss?', ['podcast'], 'clarify', 'G8'],
];
