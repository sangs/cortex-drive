#!/usr/bin/env python3
"""
seed_resume_graph.py - Authoritative Navigable Resume Seeder

This script implements the "Double-Click to Expand" architecture and the
"Private STAR Node" strategy (PreparatoryNote) for Sangeetha's portfolio.

Date handling:
  All dates sourced from documents/navigable_graph_resume/categories_and_projects.md.
  The date_utils module converts mm/yyyy strings to integer epoch properties
  (startEpoch, endEpoch) for reliable numeric sorting in Cypher queries.
  See documents/navigable_graph_resume/timeline-and-date-parsing.md for the
  full design rationale.
"""

import sys
import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

# Add scripts directory to path so date_utils can be imported
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from date_utils import parse_date_range, parse_single_date  # noqa: E402

load_dotenv('.env', override=True)

NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

# ==========================================
# DEFINITIVE RESUME CYPHER QUERIES
# ==========================================
RESUME_CYPHER_QUERIES = [
    # 1. CORE IDENTITY & CATEGORIES (LEGEND)
    """
    MERGE (p:Person {name: "Sangeetha Ramadurai"})
    SET p.email = "sangramadurai@gmail.com",
        p.linkedin = "https://www.linkedin.com/in/sangeetharamadurai",
        p.bio = "Lead Software Engineer with extensive experience in banking (JPMC, Goldman Sachs), healthcare (GE), and high-growth fintech (Mezocliq). Specialist in AI/ML, Data Engineering, and Cloud Native architectures."

    MERGE (cat1:Category {name: "Professional Experience", priority: 1})
    MERGE (cat2:Category {name: "Open Source & Independent Ventures", priority: 2})
    MERGE (cat3:Category {name: "Education & Continuous Learning", priority: 3})
    MERGE (cat4:Category {name: "Hackathons", priority: 4})
    MERGE (cat5:Category {name: "Thought Leadership & Community", priority: 5})

    WITH p, cat1, cat2, cat3, cat4, cat5
    MERGE (p)-[:HAS_PORTFOLIO]->(cat1)
    MERGE (p)-[:HAS_PORTFOLIO]->(cat2)
    MERGE (p)-[:HAS_PORTFOLIO]->(cat3)
    MERGE (p)-[:HAS_PORTFOLIO]->(cat4)
    MERGE (p)-[:HAS_PORTFOLIO]->(cat5)
    """,

    # 2. SEEDING ROLES (THE SKELETON)
    """
    MATCH (cat1:Category {name: "Professional Experience"})
    MATCH (cat2:Category {name: "Open Source & Independent Ventures"})
    MATCH (p:Person {name: "Sangeetha Ramadurai"})

    // Cortex-Drive — the company IS the product; no "Independent Ventures" indirection
    MERGE (r1:Startup {name: "Cortex-Drive"})
    MERGE (p)-[:CURRENTLY_BUILDING {role: "Founder & Lead Engineer", start: "08/2025", end: "Present"}]->(r1)
    MERGE (cat1)-[:CONTAINS]->(r1)
    MERGE (cat2)-[:CONTAINS]->(r1)
    SET r1.status = "Active", r1.type = "Independent Venture"

    MERGE (star_founder:PreparatoryNote {name: "STAR: Founder, Cortex-Drive"})
    SET star_founder.text = "Situation: Institutional memory is often lost across siloed tools and turnover. Task: Build a context-aware intelligent layer ('Cortex-Drive') to recover decision provenance. Action: Architected high-fidelity MCP server, Neo4j graphRAG, and Zero-Trust ABAC governance. Result: Enabled stable, traceable institutional memory across federated contexts."
    MERGE (r1)-[:HAS_PRIVATE_NOTE]->(star_founder)

    // NOTE: Hackathon nodes are seeded canonically in block #4 under the "Hackathons" category.
    // Do NOT create hackathon nodes here — doing so puts them under "Thought Leadership & Community".

    // JPMC
    MERGE (c2:Company {name: "JPMorgan Chase", location: "Jersey City, NJ"})
    MERGE (p)-[:HELD_ROLE {title: "Lead Software Engineer, VP", start: "02/2024", end: "07/2025"}]->(c2)
    MERGE (cat1)-[:CONTAINS]->(c2)

    MERGE (p)-[:HELD_ROLE {title: "Sr. Software Engineer (JPMC)", start: "06/2021", end: "01/2024"}]->(c2)

    // Mezocliq
    MERGE (c3:Company {name: "Mezocliq LLC", location: "New York, NY"})
    MERGE (p)-[:HELD_ROLE {title: "Sr. Software Engineer (Mezocliq)", start: "02/2013", end: "02/2021"}]->(c3)
    MERGE (cat1)-[:CONTAINS]->(c3)

    // Goldman Sachs
    MERGE (c4:Company {name: "GOLDMAN SACHS & CO."})
    MERGE (p)-[:HELD_ROLE {title: "Sr. Software Engineer, Consultant", start: "06/2007", end: "12/2009"}]->(c4)
    MERGE (cat1)-[:CONTAINS]->(c4)

    // GE Healthcare
    MERGE (c5:Company {name: "GE Healthcare"})
    MERGE (p)-[:HELD_ROLE {title: "IT Systems Specialist", start: "05/1999", end: "01/2006"}]->(c5)
    MERGE (cat1)-[:CONTAINS]->(c5)

    // Macmet
    MERGE (c6:Company {name: "Macmet India Pvt. Ltd."})
    MERGE (p)-[:HELD_ROLE {title: "Software Engineer", start: "08/1997", end: "04/1999"}]->(c6)
    MERGE (cat1)-[:CONTAINS]->(c6)
    """,

    # 3. PROJECTS: OPEN SOURCE & VENTURES
    # MERGE on single label first to avoid the multi-label duplicate trap (AP-13).
    # SET pj:Project adds the second label idempotently on both CREATE and MATCH.
    """
    MERGE (pj:Startup {name: "Cortex-Drive"})
    SET pj:Project,
        pj.status = "Active",
        pj.isPresent = true,
        pj.endDate = "Present",
        pj.endYear = "Present",
        pj.description = "Cortex-Drive is the living memory for your AI and your Enterprise. It solves the 'Context Amnesia' problem inherent in modern LLMs by providing a stable, traceable source of truth. It transforms AI from a stateless chatbot into a deeply informed collaborator that remembers historical preferences, understands the 'Why' behind your institutional intent, and provides the 'Long-Term Memory' required for mission-critical enterprise workflows.",
        pj.links = ["https://github.com/sangs/cortex-drive"],
        pj.link_titles = ["Cortex-Drive on GitHub"]

    WITH pj
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MATCH (catIndependent:Category {name: "Open Source & Independent Ventures"})
    MATCH (catProfessional:Category {name: "Professional Experience"})

    MERGE (p)-[:CURRENTLY_BUILDING {role: "Founder & Lead Engineer", start: "08/2025", end: "Present"}]->(pj)
    MERGE (catIndependent)-[:CONTAINS]->(pj)
    MERGE (catProfessional)-[:CONTAINS]->(pj)

    WITH pj
    UNWIND range(0, size(pj.links)-1) AS idx
    MERGE (l:ReferenceLink {url: pj.links[idx]})
    SET l.name = pj.link_titles[idx]
    MERGE (pj)-[:HAS_REFERENCE]->(l)
    """,

    # 3b. CORTEX-DRIVE: Technology/Concept bridge anchors + IS_A taxonomy
    # SYSTEM-tier semantics: MERGE on name only (no tenant_id) so these nodes are globally
    # visible landmarks. Tier 1 bulk SET stamps SYSTEM/user_SYSTEM_ADMIN afterward.
    # Absorbed from seed_cortex_drive_project.py — that script is no longer needed for this.
    """
    MATCH (pj:Startup {name: "Cortex-Drive"})

    WITH pj
    UNWIND [
        "Neo4j", "Graph Databases", "LLM", "MCP", "Vector Search",
        "AI Agent", "FastAPI", "TypeScript", "Zero Trust Architecture",
        "Knowledge Graph", "Retrieval-Augmented Generation",
        "Governance", "Explainability", "AI Architecture"
    ] AS tech
    MERGE (t:Technology {name: tech})
    ON CREATE SET t.type = "Technology", t.tenant_id = 'SYSTEM', t.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (pj)-[:USES_TOOL]->(t)

    WITH DISTINCT pj
    UNWIND [
        "AI Architecture", "Graph UX", "Metadata Orchestration",
        "Enterprise Knowledge Management", "Federated Identity",
        "Progressive Disclosure", "Semantic Search"
    ] AS concept
    MERGE (c:Concept {name: concept})
    ON CREATE SET c.type = "Concept", c.tenant_id = 'SYSTEM', c.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (pj)-[:DISCUSSES]->(c)

    WITH DISTINCT pj
    UNWIND [
        {child: "AI Agent", parent: "AI Architecture"},
        {child: "Graph UX", parent: "Graph Databases"},
        {child: "Retrieval-Augmented Generation", parent: "AI Architecture"},
        {child: "Semantic Search", parent: "Vector Search"},
        {child: "Federated Identity", parent: "Zero Trust Architecture"}
    ] AS rel
    MERGE (child:Concept {name: rel.child})
    ON CREATE SET child.type = "Concept", child.tenant_id = 'SYSTEM', child.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (parent:Concept {name: rel.parent})
    ON CREATE SET parent.type = "Concept", parent.tenant_id = 'SYSTEM', parent.owner_id = 'user_SYSTEM_ADMIN'
    MERGE (child)-[:IS_A]->(parent)
    """,

    # 4. HACKATHONS (Canonical List of 3)
    """
    MATCH (cat:Category {name: "Hackathons"})
    MATCH (p:Person {name: "Sangeetha Ramadurai"})

    // Hackathon 1: Humanless Autocode (02/2025-03/2025)
    MERGE (h1:Hackathon:Project {name: "Humanless Autocode at Scale for SRE @ JPMorgan Chase"})
    SET h1.type = "Hackathon",
        h1.description = "Innovation Leadership: Automated, context-aware AI code review process using Sourcegraph's Cody, tailored for enterprise guardrails."
    MERGE (p)-[:PARTICIPATED_IN {role: "Project Lead", start: "02/2025", end: "03/2025"}]->(h1)
    MERGE (cat)-[:CONTAINS]->(h1)

    MERGE (star1:PreparatoryNote {name: "Core Detail: Humanless Autocode"})
    SET star1.text = "Situation: IaC reviews were time-consuming and inconsistent... Task: Showcase automated code review at scale using Sourcegraph Cody... Action: Led project, implemented dependency graph analysis and multi-PR generation... Result: Successfully demonstrated automated code review at scale for IaC, dramatically reducing review time while improving safety."
    MERGE (h1)-[:HAS_PRIVATE_NOTE]->(star1)

    // Hackathon 2: Volarisation Engine (01/2026-01/2026)
    MERGE (h2:Hackathon:Project {name: "Volarisation Engine @ IBM Dev Day 2026"})
    SET h2.type = "Hackathon",
        h2.description = "Innovation Leadership: Explainable, agentic AI decision-support system built with IBM Watsonx Orchestrate to accelerate life-sciences patent research.",
        h2.links = ["https://lnkd.in/dcSmQS4n", "https://sites.google.com/view/valorisationengine/valorisation", "https://drive.proton.me/urls/NYB1KQ7QNC#HueGJ6Nq7AAl"],
        h2.link_titles = ["Volarisation Engine @ LinkedIn", "Volarisation Engine Website", "Volarisation Engine Demo (Proton)"]
    MERGE (p)-[:PARTICIPATED_IN {role: "Lead Developer", start: "01/2026", end: "01/2026"}]->(h2)
    MERGE (cat)-[:CONTAINS]->(h2)

    MERGE (star2:PreparatoryNote {name: "Core Detail: Volarisation Engine"})
    SET star2.text = "Situation: Early-stage patent triage was opaque and slow... Task: Develop PoC for transparent, logic-first patent research... Action: Built agentic workflow with IBM Watsonx Orchestrate on IBM Cloud... Result: Formalized PoC for life-sciences commercialization with high explainability."
    MERGE (h2)-[:HAS_PRIVATE_NOTE]->(star2)

    WITH h2, cat, p
    UNWIND range(0, size(h2.links)-1) AS idx
    MERGE (l:ReferenceLink {url: h2.links[idx]})
    SET l.name = h2.link_titles[idx]
    MERGE (h2)-[:HAS_REFERENCE]->(l)

    // Hackathon 3: Global Hackathons @ JPMC (07/2025-07/2025)
    MERGE (h3:Hackathon:Project {name: "Global Hackathons @ JPMorgan Chase"})
    SET h3.type = "Hackathon",
        h3.description = "Innovation Leadership: Led Global Hackathon projects delivering MCP-based AI solutions, including MongoDB and Neo4j MCP clients."
    MERGE (p)-[:PARTICIPATED_IN {role: "Innovation Lead", start: "07/2025", end: "07/2025"}]->(h3)
    MERGE (cat)-[:CONTAINS]->(h3)

    MERGE (star3:PreparatoryNote {name: "Core Detail: Global Hackathons"})
    SET star3.text = "Situation: Innovation required contributing to the technical community through open-source... Task: Advance organizational technical capabilities through hackathons... Action: Led projects delivering MCP-based AI solutions (MongoDB, Neo4j)... Result: Created ripple effects across the organization; AI Agent examples accelerated adoption of agent frameworks."
    MERGE (h3)-[:HAS_PRIVATE_NOTE]->(star3)
    """,

    # 5. THOUGHT LEADERSHIP (Canonical List of 2)
    """
    MATCH (cat:Category {name: "Thought Leadership & Community"})
    MATCH (p:Person {name: "Sangeetha Ramadurai"})

    // InfoQ (11/2025-01/2026)
    MERGE (t1:ThoughtLeadership:Publication {name: "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI"})
    SET t1.type = "ThoughtLeadership",
        t1.description = "Thought Leadership: Co-authored expert article in InfoQ e-magazine, defining mandatory architectural shifts (Governance, Explainability) for AI platform engineering.",
        t1.links = ["https://www.infoq.com/minibooks/architecture-age-ai-opportunity/"],
        t1.link_titles = ["InfoQ: Architectural Shifts for Platform Engineers in the Age of AI"]
    MERGE (p)-[tl1_rel:AUTHORED]->(t1)
    SET tl1_rel.start = "11/2025", tl1_rel.end = "01/2026"
    MERGE (cat)-[:CONTAINS]->(t1)

    MERGE (star_t1:PreparatoryNote {name: "Core Detail: InfoQ Publication"})
    SET star_t1.text = "Situation: Blind automation in AI often leads to governance failures... Task: Define safe human-in-the-loop engineering guardrails... Action: Co-authored article in InfoQArchitecture Cohort... Result: Established workflow/alignment patterns adopted by platform teams."
    MERGE (t1)-[:HAS_PRIVATE_NOTE]->(star_t1)

    WITH t1, cat, p
    UNWIND range(0, size(t1.links)-1) AS idx
    MERGE (l:ReferenceLink {url: t1.links[idx]})
    SET l.name = t1.link_titles[idx]
    MERGE (t1)-[:HAS_REFERENCE]->(l)

    // Ignite
    MERGE (t2:ThoughtLeadership:Community {name: "Ignite Social Learning Community @ JPMC"})
    SET t2.type = "ThoughtLeadership",
        t2.description = "Innovation Leadership: Featured as a Lead and Guest Interviewee for the Ignite Cloud community, driving organic network growth and showcasing the impact of social learning in enterprise tech.",
        t2.links = ["https://www.jpmorganchase.com/about/technology/blog/ignite-takes-new-york-city-by-storm"],
        t2.link_titles = ["Ignite Takes New York City by Storm"]
    MERGE (p)-[tl2_rel:FEATURE_GUEST]->(t2)
    SET tl2_rel.role = "Lead & Featured Guest", tl2_rel.start = "06/2021", tl2_rel.end = "07/2025"
    MERGE (cat)-[:CONTAINS]->(t2)

    MERGE (star_t2:PreparatoryNote {name: "Core Detail: Ignite Community"})
    SET star_t2.text = "Situation: Employees lacked structured opportunities for skills-dev outside day-jobs... Task: Run ecosystem for organic learning and innovation... Action: Organized monthly sessions, mentored leadership potential, and represented the community in high-profile internal/external interviews... Result: Community grew organically, leading to internal mobility and collaboration across JPMC, while establishing a model for social learning."
    MERGE (t2)-[:HAS_PRIVATE_NOTE]->(star_t2)

    WITH t2, cat, p
    UNWIND range(0, size(t2.links)-1) AS idx
    MERGE (l2:ReferenceLink {url: t2.links[idx]})
    SET l2.name = t2.link_titles[idx]
    MERGE (t2)-[:HAS_REFERENCE]->(l2)

    // Open-Source AI Agents Contribution @ JPMC (05/2025-07/2025)
    MERGE (t3:ThoughtLeadership:Project {name: "Open-Source AI Agents Contribution @ JPMC"})
    SET t3.type = "ThoughtLeadership",
        t3.description = "Thought Leadership: Contributed to Microsoft AutoGen-based AI Agent frameworks at JPMC, fostering knowledge sharing about multi-agent patterns."
    MERGE (p)-[tl3_rel:CONTRIBUTED_TO]->(t3)
    SET tl3_rel.start = "05/2025", tl3_rel.end = "07/2025"
    MERGE (cat)-[:CONTAINS]->(t3)

    MERGE (star_t3:PreparatoryNote {name: "Core Detail: Open-Source AI Agents"})
    SET star_t3.text = "Situation: JPMC was exploring AI Agent frameworks... Task: Contribute practical examples of agent development... Action: Developed news Agent based on Microsoft AutoGen framework... Result: Accelerated adoption of AI Agent patterns and created practitioners network."
    MERGE (t3)-[:HAS_PRIVATE_NOTE]->(star_t3)
    """,


    # 5.5 EDUCATION & CONTINUOUS LEARNING
    """
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MATCH (cat:Category {name: "Education & Continuous Learning"})

    // PURGE LEGACY NODES before re-seeding to fix sorting duplicates (e.g. 2007/2003)
    OPTIONAL MATCH (old) WHERE old:Degree OR old:Certification OR old:ProfessionalEducation
    DETACH DELETE old

    WITH p, cat

    // 2026: InfoQ
    MERGE (e1:Certification {name: "[2026] InfoQ Certified Architect"})
    SET e1.year = "2026",
        e1.description = "Co-authored expert article in InfoQ e-magazine, Architectural Shifts for Platform Engineers in the Age of AI, defining mandatory architectural shifts for AI platform engineering."
    MERGE (p)-[:CERTIFIED_BY {year: "2026"}]->(e1)
    MERGE (cat)-[:CONTAINS]->(e1)

    // 2024: MIT
    MERGE (e2:ProfessionalEducation {name: "[2024] MIT: Applied Data Science"})
    SET e2.year = "2024",
        e2.skills = ["Logistic Regression", "Decision Trees", "Hyper-parameter Tuning"],
        e2.description = "Applied Data Science Program covering AI & ML / MIT Professional Education."
    MERGE (p)-[:STUDIED_AT {year: "2024"}]->(e2)
    MERGE (cat)-[:CONTAINS]->(e2)

    // 2011: IIT
    MERGE (e3:Degree {name: "[2011] Master's Degree in Computer Science"})
    SET e3.year = "2011",
        e3.institution = "Illinois Institute of Technology",
        e3.location = "Chicago, IL"
    MERGE (p)-[:GRADUATED_FROM {year: "2011"}]->(e3)
    MERGE (cat)-[:CONTAINS]->(e3)

    // 1997: NIT
    MERGE (e4:Degree {name: "[1997] Bachelor's Degree (B.E.) in Electronics and Communication"})
    SET e4.year = "1997",
        e4.institution = "National Institute of Technology (NIT) Bhopal",
        e4.location = "Bhopal, India"
    MERGE (p)-[:GRADUATED_FROM {year: "1997"}]->(e4)
    MERGE (cat)-[:CONTAINS]->(e4)
    """,

    # 6. JPMC PROJECTS (MODERN ERA: 2024-2025)
    """
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MATCH (c:Company {name: "JPMorgan Chase"})
    MATCH (cat:Category {name: "Professional Experience"})

    // Metadata Agent
    MERGE (p1:Project {name: "Metadata Agent Architecture"})
    SET p1.description = "Metadata Discovery & RAG Agent: Architected AWS-based AI solution using Lambda, Bedrock, and PG Vector to reduce data discovery time from hours to seconds."
    MERGE (p)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p1)
    MERGE (c)-[:CONTAINS]->(p1)
    MERGE (cat)-[:CONTAINS]->(p1)
    MERGE (n1:PreparatoryNote {name: "STAR: Metadata Agent"})
    SET n1.text = "Situation: Metadata was scattered across AWM data catalogs. Task: Develop AI Agent for natural language discovery. Action: Architected end-to-end with AWS Lambda/Bedrock/PG Vector, built RAG pattern. Result: Reduced discovery time from hours to seconds."
    MERGE (p1)-[:HAS_PRIVATE_NOTE]->(n1)

    // DataMesh Publishing
    MERGE (p2:Project {name: "Instrument Data on DataMesh"})
    SET p2.description = "DataMesh Publishing: Standardized enterprise reference data for AWM by building automated publishing pipelines across the JPMC DataMesh using AWS Glue/Step Functions."
    MERGE (p)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p2)
    MERGE (c)-[:CONTAINS]->(p2)
    MERGE (cat)-[:CONTAINS]->(p2)
    MERGE (n2:PreparatoryNote {name: "STAR: DataMesh Publishing"})
    SET n2.text = "Situation: Bespoke integrations created a fragmented data landscape. Task: Publish Instrument Reference Data on DataMesh. Action: Implemented automated pipeline using AWS Lambda/Step Functions/Glue. Result: Established single standardized source for enterprise reference data."
    MERGE (p2)-[:HAS_PRIVATE_NOTE]->(n2)

    // DataMesh Infrastructure
    MERGE (p3:Project {name: "Infrastructure for Instrument Data on DataMesh"})
    SET p3.description = "DataMesh Infrastructure: Resolved critical architecture blockers by collaborating on enterprise-approved Terraform modules for Lake Formation and S3 Access Points."
    MERGE (p)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p3)
    MERGE (c)-[:CONTAINS]->(p3)
    MERGE (cat)-[:CONTAINS]->(p3)
    MERGE (n3:PreparatoryNote {name: "STAR: DataMesh Infrastructure"})
    SET n3.text = "Situation: Lacked approved Terraform modules for Lake Formation. Task: Resolve architecture blockers. Action: Collaborated with platform teams to create enterprise Terraform modules. Result: Removed critical blockers and established reusable infrastructure patterns."
    MERGE (p3)-[:HAS_PRIVATE_NOTE]->(n3)
    """,

    # 7. JPMC PROJECTS (2021-2024 ERA)
    """
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MATCH (c:Company {name: "JPMorgan Chase"})
    MATCH (cat:Category {name: "Professional Experience"})

    // Gain/Loss
    MERGE (p4:Project {name: "Gain/Loss Cloud Native Microservice"})
    SET p4.description = "Cost Modernization: Designed and implemented a greenfield, cloud-native Gain/Loss microservice on AWS EKS, delivering $338k in annual cost savings and removing vendor dependency."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p4)
    MERGE (c)-[:CONTAINS]->(p4)
    MERGE (cat)-[:CONTAINS]->(p4)
    MERGE (n4:PreparatoryNote {name: "STAR: Gain/Loss MS"})
    SET n4.text = "Situation: Costly dependency on vendor product for real-time gain/loss. Task: Replace vendor product with cloud-native MS. Action: Designed/implemented greenfield MS using Spring/AWS EKS/Kafka. Result: Saved $338k annually and removed external dependency."
    MERGE (p4)-[:HAS_PRIVATE_NOTE]->(n4)

    // Short Orders
    MERGE (p5:Project {name: "Start of Day Open Short Orders Microservice"})
    SET p5.description = "Cloud Transformation: Modernized start-of-day business processing by migrating legacy vendor products to a scalable, cloud-native microservice architecture."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p5)
    MERGE (c)-[:CONTAINS]->(p5)
    MERGE (cat)-[:CONTAINS]->(p5)
    MERGE (n5:PreparatoryNote {name: "STAR: Short Orders MS"})
    SET n5.text = "Situation: Vendor dependency for locating daily open short orders. Task: Implement cloud-native MS to improve integration. Action: Used AWS MSK, CloudWatch, and Datadog for monitoring/alerting. Result: Eliminated licensing costs and gained full control over daily operations."
    MERGE (p5)-[:HAS_PRIVATE_NOTE]->(n5)

    // Corporate Action
    MERGE (p6:Project {name: "Corporate Action Report Automation"})
    SET p6.description = "Corporate Action Automation: Eliminated manual report delays by implementing an automation microservice integrated with upstream data sources, improving stakeholder delivery consistency."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p6)
    MERGE (c)-[:CONTAINS]->(p6)
    MERGE (cat)-[:CONTAINS]->(p6)
    MERGE (n6:PreparatoryNote {name: "STAR: Corp Action Automation"})
    SET n6.text = "Situation: Manual report generation was time-consuming and prone to delays. Task: Automate Corporate Action reports. Action: Designed/implemented automation microservice integrated with data sources. Result: Improved stakeholder satisfaction through timely and consistent delivery."
    MERGE (p6)-[:HAS_PRIVATE_NOTE]->(n6)

    // Settlement Verification
    MERGE (p7:Project {name: "Settlement Setup Instruction Verification System"})
    SET p7.description = "Settlement Verification: Led brownfield migration off Sybase dependency, maintaining settlement instruction verification integrity without disruption to order-raising workflows."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p7)
    MERGE (c)-[:CONTAINS]->(p7)
    MERGE (cat)-[:CONTAINS]->(p7)
    MERGE (n7:PreparatoryNote {name: "STAR: Settlement Verification"})
    SET n7.text = "Situation: Sybase dependency for settlement verification needed strategic exit. Task: Maintain functionality during migration. Action: Led brownfield enhancements, worked with stakeholders on business criteria. Result: Successfully replaced Sybase without disruption to order-raising."
    MERGE (p7)-[:HAS_PRIVATE_NOTE]->(n7)
    """,

    # 8. LEGACY PROJECTS (MEZOCLIQ, GS, GE, MACMET)
    """
    // Mezocliq (02/2013-02/2021)
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MATCH (c_mezo:Company {name: "Mezocliq LLC"})
    MATCH (cat1:Category {name: "Professional Experience"})

    MERGE (pm1:Project {name: "Cloud-Native Platform Orchestration & Workflow System"})
    SET pm1.description = "Platform Orchestration: Designed Quarkus-based microservices architecture for UI orchestration and multi-stage approval workflows, with Docker/Kubernetes containerization and full CI/CD pipelines at Mezocliq."
    MERGE (p)-[:CONTRIBUTED_TO {start: "02/2013", end: "02/2021"}]->(pm1)
    MERGE (c_mezo)-[:CONTAINS]->(pm1)
    MERGE (cat1)-[:CONTAINS]->(pm1)

    MERGE (pm2:Project {name: "Enterprise Access Control, Search, and Distributed Infrastructure"})
    SET pm2.description = "Access & Search Infrastructure: Architected Cassandra-based fine-grained privilege model and Elasticsearch full-text search across analytics platforms, with Hazelcast distributed caching for sub-second performance."
    MERGE (p)-[:CONTRIBUTED_TO {start: "02/2013", end: "02/2021"}]->(pm2)
    MERGE (c_mezo)-[:CONTAINS]->(pm2)
    MERGE (cat1)-[:CONTAINS]->(pm2)

    WITH p, cat1
    // Goldman Sachs (06/2007-12/2009)
    MATCH (c_gs:Company {name: "GOLDMAN SACHS & CO."})
    MERGE (pg1:Project {name: "Executive Workflow Management Platform (Ten Thousand Women)"})
    SET pg1.description = "Executive Workflow Platform: Led J2EE/Struts/Hibernate development of a multi-stage approval workflow system for Goldman Sachs' global Ten Thousand Women initiative, improving operational efficiency for administrators worldwide."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2007", end: "12/2009"}]->(pg1)
    MERGE (c_gs)-[:CONTAINS]->(pg1)
    MERGE (cat1)-[:CONTAINS]->(pg1)

    MERGE (pg2:Project {name: "Capital Attribution & Market Risk Data Platform"})
    SET pg2.description = "Market Risk Platform: Implemented capital attribution logic and redesigned market risk data workflows in DB2, improving accuracy and enabling better alignment with evolving risk reporting structures at Goldman Sachs."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2007", end: "12/2009"}]->(pg2)
    MERGE (c_gs)-[:CONTAINS]->(pg2)
    MERGE (cat1)-[:CONTAINS]->(pg2)

    WITH p, cat1
    // GE Healthcare (05/1999-01/2006)
    MATCH (c_ge:Company {name: "GE Healthcare"})
    MERGE (pge1:Project {name: "Radiology Imaging Platform Integration"})
    SET pge1.description = "PACS Integration: Implemented a universal medical application interface enabling radiologists to access 3D clinical applications directly from PACS systems, demonstrated at RSNA conferences and adopted across GE Healthcare deployments."
    MERGE (p)-[:CONTRIBUTED_TO {start: "05/1999", end: "01/2006"}]->(pge1)
    MERGE (c_ge)-[:CONTAINS]->(pge1)
    MERGE (cat1)-[:CONTAINS]->(pge1)

    MERGE (pge2:Project {name: "Image Management & Distributed Event Processing System"})
    SET pge2.description = "Distributed Imaging Workflows: Designed patient data processing workflows and prototyped distributed event communication using CORBA/ACE, improving reliability and scalability of large-scale medical image management at GE Healthcare."
    MERGE (p)-[:CONTRIBUTED_TO {start: "05/1999", end: "01/2006"}]->(pge2)
    MERGE (c_ge)-[:CONTAINS]->(pge2)
    MERGE (cat1)-[:CONTAINS]->(pge2)

    WITH p, cat1
    // Macmet (08/1997-04/1999)
    MATCH (c_mac:Company {name: "Macmet India Pvt. Ltd."})
    MERGE (pma:Project {name: "Simulation systems development and evaluation (Macmet)"})
    SET pma.description = "Simulation Engineering: Developed and evaluated industrial simulation systems as an early-career software engineer, building core foundations in systems development, evaluation methodologies, and engineering software design."
    MERGE (p)-[:CONTRIBUTED_TO {start: "08/1997", end: "04/1999"}]->(pma)
    MERGE (c_mac)-[:CONTAINS]->(pma)
    MERGE (cat1)-[:CONTAINS]->(pma)
    """,

    # 8.1 LEGACY STAR NOTES (BACKFILL)
    """
    // Mezocliq
    MATCH (pm1:Project {name: "Cloud-Native Platform Orchestration & Workflow System"})
    MERGE (n_pm1:PreparatoryNote {name: "STAR: Mezocliq Workflow"})
    SET n_pm1.text = "Situation: Mezocliq platform required a scalable, modular architecture for UI orchestration and workflow execution. Task: Design and implement microservices-based architecture for UI logic and approval rules. Action: Developed Quarkus-based microservices, implemented containerization with Docker/K8s, and established CI/CD. Result: Delivered scalable platform with independent deployment and faster release cycles."
    MERGE (pm1)-[:HAS_PRIVATE_NOTE]->(n_pm1)

    WITH count(*) AS scope
    MATCH (pm2:Project {name: "Enterprise Access Control, Search, and Distributed Infrastructure"})
    MERGE (n_pm2:PreparatoryNote {name: "STAR: Mezocliq Security"})
    SET n_pm2.text = "Situation: Needed robust access control and high-performance search for analytics platforms. Task: Design flexible privilege model and enable full-text search across datasets. Action: Designed Cassandra-based privilege model, implemented Elasticsearch search, and integrated Hazelcast distributed caching. Result: Enabled fine-grained access control and significantly improved search/discovery performance."
    MERGE (pm2)-[:HAS_PRIVATE_NOTE]->(n_pm2)

    WITH count(*) AS scope
    // Goldman Sachs
    MATCH (pg1:Project {name: "Executive Workflow Management Platform (Ten Thousand Women)"})
    MERGE (n_pg1:PreparatoryNote {name: "STAR: GS Ten Thousand Women"})
    SET n_pg1.text = "Situation: The executive office needed a system to manage project submissions and approvals for a global initiative. Task: Lead development of a production-ready workflow application. Action: Led development using J2EE/Struts/Hibernate, designed end-to-end multi-stage approval workflow. Result: Delivered fully functional platform improving operational efficiency for global administrators."
    MERGE (pg1)-[:HAS_PRIVATE_NOTE]->(n_pg1)

    WITH count(*) AS scope
    MATCH (pg2:Project {name: "Capital Attribution & Market Risk Data Platform"})
    MERGE (n_pg2:PreparatoryNote {name: "STAR: GS Risk Management"})
    SET n_pg2.text = "Situation: Risk and capital attribution processes needed re-design due to evolving reporting needs. Task: Implement capital attribution logic and redesign market risk data workflows. Action: Designed data structures in DB2, implemented business logic, and integrated with internal dashboard framework. Result: Improved accuracy of capital attribution and enabled better alignment with risk organizational structures."
    MERGE (pg2)-[:HAS_PRIVATE_NOTE]->(n_pg2)

    WITH count(*) AS scope
    // GE
    MATCH (pge1:Project {name: "Radiology Imaging Platform Integration"})
    MERGE (n_pge1:PreparatoryNote {name: "STAR: GE PACS Integration"})
    SET n_pge1.text = "Situation: Radiologists needed seamless access to 3D clinical applications from siloed PACS systems. Task: Integrate PACS with 3D applications to provide a unified diagnostic experience. Action: Implemented universal medical application interface enabling access directly from PACS. Result: Successfully provided unified diagnostic access, improving workflow; demonstrated at RSNA conferences."
    MERGE (pge1)-[:HAS_PRIVATE_NOTE]->(n_pge1)

    WITH count(*) AS scope
    MATCH (pge2:Project {name: "Image Management & Distributed Event Processing System"})
    MERGE (n_pge2:PreparatoryNote {name: "STAR: GE Workflows"})
    SET n_pge2.text = "Situation: Medical imaging required robust workflows for processing and storage across distributed systems. Task: Design scalable workflows and evaluate distributed communication models. Action: Designed patient data workflows and prototyped event communication using CORBA/ACE. Result: Improved reliability and scalability of imaging workflows for large-scale medical image data."
    MERGE (pge2)-[:HAS_PRIVATE_NOTE]->(n_pge2)

    """,

    # 8.5 META-CONTEXT: INTERACTIVE RESUME
    """
    MERGE (meta:__MetaContext__ {useCase: "interactiveResume"})
    SET meta.version = 1,
        meta.context = "
This knowledge graph contains Sangeetha Ramadurai's professional portfolio, organized into a hierarchical structure for navigable discovery.

KEY NAVIGATION RULES:
1. OVERVIEW/PORTFOLIO: When the user asks for a 'portfolio,' 'overview,' or 'professional background,' START by searching for 'Category' nodes.
2. CATEGORIES: The primary entry points are:
   - 'Professional Experience' (Contains both corporate roles AND professional independent ventures like Cortex-Drive)
   - 'Open Source & Independent Ventures'
   - 'Hackathons & Thought Leadership'
   - 'Education & Continuous Learning'
3. DRILL-DOWN: From a Category, follow [:CONTAINS] to find Projects, Roles, or Hackathons.
4. STAR DETAILS: Projects and Hackathons have [:HAS_PRIVATE_NOTE] edges to 'PreparatoryNote' nodes. These contain detailed Situation, Task, Action, Result (STAR) content used for interview coaching and deep-dives.
5. CLICKABLE LINKS: Many nodes (Project, ReferenceLink) have 'links' properties or [:HAS_REFERENCE] edges. These should be presented to the user as clickable URLs.

TOOL USAGE:
- Use `search_resume_graph` for high-level keyword discovery.
- Use `get_node_details` once you have a specific entity name to see all links and metadata.
- Use `run_cypher_query` for complex path-finding (e.g., 'What tools did Sangeetha use at GE?').
"
    """,

    # 9. TECHNOLOGY MAPPING: CORTEX
    """
    WITH {
        cortex: ["Neo4j", "BAML", "Python", "LangGraph", "Langflow", "AI Agent", "Claude Code", "Google Antigravity", "Software architecture", "AI", "Explainability", "Governance"]
    } as tech_map
    MATCH (pj:Project {name: "Cortex-Drive"})
    UNWIND tech_map.cortex as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 10. TECHNOLOGY MAPPING: JPMC MODERN
    """
    WITH {
        jpmc_modern: ["AWS Lambda", "Step Function", "Glue", "Lake Formation", "DataMesh", "Snowflake", "Starburst", "Python", "ML", "Al Agent", "LangGraph", "Terraform"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Metadata Agent" OR pj.name CONTAINS "DataMesh"
    UNWIND tech_map.jpmc_modern as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 11. TECHNOLOGY MAPPING: JPMC LEGACY
    """
    WITH {
        jpmc_legacy: ["Java", "Spring", "AWS", "EKS", "MSK", "Kafka", "RDS", "Datadog", "CloudWatch"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Microservice" OR pj.name CONTAINS "Automation" OR pj.name CONTAINS "Verification"
    UNWIND tech_map.jpmc_legacy as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 12. TECHNOLOGY MAPPING: MEZOCLIQ
    """
    WITH {
        mezocliq: ["Microservices", "Cloud Computing", "Quarkus", "Docker", "Jenkins", "Kubernetes", "AWS", "React", "Java", "GWT", "Elasticsearch", "Thrift API", "Protocol Buffer", "Kafka Streams", "Cassandra"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Cloud-Native Platform" OR pj.name CONTAINS "Access Control, Search"
    UNWIND tech_map.mezocliq as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 13. TECHNOLOGY MAPPING: GOLDMAN SACHS
    """
    WITH {
        gs: ["Java", "Struts", "Hibernate", "Tomcat", "DB2", "Slang", "SecDB"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Ten Thousand Women" OR pj.name CONTAINS "Capital Attribution & Market Risk"
    UNWIND tech_map.gs as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 14. TECHNOLOGY MAPPING: GE HEALTHCARE
    """
    WITH {
        ge: ["Java", "C", "C++", "Sybase", "CORBA", "ACE"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Imaging Platform" OR pj.name CONTAINS "Image Management"
    UNWIND tech_map.ge as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 15. TECHNOLOGY MAPPING: MACMET
    """
    WITH {
        macmet: ["VC++", "Lead Tools API"]
    } as tech_map
    MATCH (pj:Project) WHERE pj.name CONTAINS "Simulation systems"
    UNWIND tech_map.macmet as tool
    MERGE (t:Technology {name: tool})
    MERGE (pj)-[:USES_TOOL]->(t)
    """,

    # 16. TECHNOLOGY MAPPING: INFOQ
    """
    WITH {
        infoq: ["Software architecture", "AI", "C4 Model", "Explainability", "Governance"]
    } as tech_map
    MATCH (tl:ThoughtLeadership) WHERE tl.name CONTAINS "InfoQ"
    UNWIND tech_map.infoq as tool
    MERGE (t:Technology {name: tool})
    MERGE (tl)-[:USES_TOOL]->(t)
    """,

    # 17. TECHNOLOGY MAPPING: IGNITE COMMUNITY
    """
    WITH {
        ignite: ["Public Cloud", "AWS", "GoLang", "ML"]
    } as tech_map
    MATCH (tl:ThoughtLeadership) WHERE tl.name CONTAINS "Ignite Social Learning Community"
    UNWIND tech_map.ignite as tool
    MERGE (t:Technology {name: tool})
    MERGE (tl)-[:USES_TOOL]->(t)
    """,

    # 18. TECHNOLOGY MAPPING: OPEN-SOURCE AI AGENTS
    """
    WITH {
        os_agents: ["AutoGen", "Python", "ML", "AI Agent (OpenAI)"]
    } as tech_map
    MATCH (os:Project) WHERE os.name CONTAINS "Open-Source AI Agents Contribution"
    UNWIND tech_map.os_agents as tool
    MERGE (t:Technology {name: tool})
    MERGE (os)-[:USES_TOOL]->(t)
    """,

    # 19. TECHNOLOGY MAPPING: NEW HACKATHONS
    """
    WITH {
        autocode: ["Python", "Cody AI Agent", "Terraform", "Infrastructure as Code", "AI Agent"],
        valorisation: ["Python", "Langflow", "IBM Watson", "AI Agent", "Decision Support"],
        global_hacks: ["Neo4j", "MongoDB", "Python", "ML", "AI Agent", "MCP"]
    } as tech_map
    MATCH (h1:Hackathon {name: "Humanless Autocode at Scale for SRE @ JPMorgan Chase"})
    MATCH (h2:Hackathon {name: "Volarisation Engine @ IBM Dev Day 2026"})
    MATCH (h3:Hackathon {name: "Global Hackathons @ JPMorgan Chase"})
    
    UNWIND tech_map.autocode as t1
    MERGE (tool1:Technology {name: t1})
    MERGE (h1)-[:USES_TOOL]->(tool1)
    
    WITH tech_map, h2, h3
    UNWIND tech_map.valorisation as t2
    MERGE (tool2:Technology {name: t2})
    MERGE (h2)-[:USES_TOOL]->(tool2)
    
    WITH tech_map, h3
    UNWIND tech_map.global_hacks as t3
    MERGE (tool3:Technology {name: t3})
    MERGE (h3)-[:USES_TOOL]->(tool3)
    """,

    # 20. TECHNOLOGY MAPPING: EDUCATION & CERTS
    """
    WITH {
        mit: ["Logistic Regression", "Decision Trees", "Random Forest", "Bagging", "Boosting", "Hyper-parameter Tuning", "EDA", "Data Visualization", "Statistics", "Python", "ML"],
        infoq_cert: ["Software architecture", "AI", "Platform Engineering", "Governance", "Explainability"]
    } as tech_map
    MATCH (e1:Certification) WHERE e1.name CONTAINS "InfoQ Certified Architect"
    MATCH (e2:ProfessionalEducation) WHERE e2.name CONTAINS "MIT: Applied Data Science"
    
    UNWIND tech_map.mit as t1
    MERGE (tool1:Technology {name: t1})
    MERGE (e2)-[:USES_TOOL]->(tool1)
    
    WITH tech_map, e1
    UNWIND tech_map.infoq_cert as t2
    MERGE (tool2:Technology {name: t2})
    MERGE (e1)-[:USES_TOOL]->(tool2)
    """
]

# ===========================================================================
# EPOCH PROPAGATION QUERIES
# These Cypher queries are executed after all MERGE queries to propagate
# startEpoch, endEpoch, isPresent, displayDate, startYear, endYear from
# relationship edges (source of truth) onto the connected nodes (cache).
# This is a denormalization step for efficient querying — the relationship
# is always the canonical source. See timeline-and-date-parsing.md.
# ===========================================================================

def _build_epoch_cypher(rel_type: str, node_label: str) -> str:
    """Build a Cypher query that propagates epoch properties from a relationship to its target node."""
    return f"""
    MATCH ()-[rel:{rel_type}]->(n:{node_label})
    WHERE rel.start IS NOT NULL OR rel.end IS NOT NULL
    WITH n,
         rel.start AS rel_start,
         rel.end   AS rel_end,
         CASE WHEN rel.end IS NOT NULL AND toLower(rel.end) = 'present' THEN true ELSE false END AS is_present
    SET
        n.displayDate    = CASE
                             WHEN rel_start IS NOT NULL AND rel_end IS NOT NULL
                             THEN rel_start + '-' + rel_end
                             ELSE coalesce(rel_start, rel_end, '')
                           END,
        n.isPresent      = is_present,
        n.startYear      = CASE
                             WHEN rel_start =~ '\\d{{2}}/\\d{{4}}' THEN right(rel_start, 4)
                             WHEN rel_start =~ '\\d{{4}}'          THEN rel_start
                             ELSE null END,
        n.endYear        = CASE
                             WHEN is_present                        THEN 'Present'
                             WHEN rel_end   =~ '\\d{{2}}/\\d{{4}}' THEN right(rel_end, 4)
                             WHEN rel_end   =~ '\\d{{4}}'          THEN rel_end
                             ELSE null END,
        n.startEpoch     = CASE
                             WHEN rel_start =~ '\\d{{2}}/\\d{{4}}'
                             THEN toInteger(right(rel_start, 4)) * 100 + toInteger(left(rel_start, 2))
                             WHEN rel_start =~ '\\d{{4}}'
                             THEN toInteger(rel_start) * 100 + 1
                             ELSE null END,
        n.endEpoch       = CASE
                             WHEN is_present                        THEN 999999
                             WHEN rel_end   =~ '\\d{{2}}/\\d{{4}}'
                             THEN toInteger(right(rel_end, 4)) * 100 + toInteger(left(rel_end, 2))
                             WHEN rel_end   =~ '\\d{{4}}'
                             THEN toInteger(rel_end) * 100 + 12
                             ELSE null END
    """


def seed_resume_graph():
    """Seed the full interactive resume graph into Neo4j, then propagate epoch properties."""
    if not NEO4J_PASSWORD:
        print("Error: NEO4J_PASSWORD environment variable is not set.")
        sys.exit(1)

    print(f"Connecting to Neo4j at {NEO4J_URI}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))

    try:
        with driver.session() as session:
            # Step 1: Run all MERGE queries
            print(f"Executing {len(RESUME_CYPHER_QUERIES)} definitive mapping queries...")
            for i, query in enumerate(RESUME_CYPHER_QUERIES, 1):
                print(f"  -> Running Query {i}/{len(RESUME_CYPHER_QUERIES)}")
                session.run(query)

            # Step 2: Stamp identity tier on all resume-domain nodes (Zero-Trust ReBAC model)
            tenant_id = os.getenv("TENANT_ID")
            if not tenant_id or not tenant_id.startswith("org_"):
                raise EnvironmentError(
                    "CRITICAL: 'TENANT_ID' environment variable is missing or invalid. "
                    "Seeding aborted to prevent accidental data corruption with placeholder IDs."
                )
            owner_id = os.getenv("OWNER_USER_ID")
            if not owner_id or not owner_id.startswith("user_"):
                raise EnvironmentError(
                    "CRITICAL: 'OWNER_USER_ID' environment variable is missing or invalid. "
                    "Seeding aborted to prevent nodes from being created without an owner."
                )

            print(f"  -> Authoritative Identity confirmed: tenant={tenant_id}, owner={owner_id}")
            print("  -> Stamping graph with Zero-Trust identity tier (SYSTEM / PUBLIC / PRIVATE).")

            # Tier 1: SYSTEM — globally visible structural landmarks
            # Technology, Concept, Year are semantic primitives shared across all tenants —
            # they must be SYSTEM tier so virtual bridge discovery can traverse them globally.
            session.run(
                """
                MATCH (n)
                WHERE any(label IN labels(n) WHERE label IN [
                    'Company', 'Institution', 'Degree', 'Category',
                    'Technology', 'Concept', 'Year'
                ])
                SET n.tenant_id = 'SYSTEM', n.owner_id = 'user_SYSTEM_ADMIN'
                """
            )

            # Tier 2: PUBLIC — community benchmarks visible to any authenticated user
            session.run(
                """
                MATCH (n)
                WHERE any(label IN labels(n) WHERE label IN [
                    'ThoughtLeadership', 'Publication', 'Hackathon'
                ])
                SET n.tenant_id = 'PUBLIC', n.owner_id = 'user_SYSTEM_ADMIN'
                """
            )

            # Tier 3: PRIVATE — personal professional memory, gated by owner + tenant
            session.run(
                """
                MATCH (n)
                WHERE any(label IN labels(n) WHERE label IN [
                    'Person', 'Project', 'Startup', 'Community', 'PreparatoryNote',
                    'Skill', 'Certification', 'ProfessionalEducation', 'OpenSource',
                    'SocialLearning', 'ReferenceLink', '__MetaContext__', 'Outcome',
                    'Achievement'
                ])
                SET n.tenant_id = $tenant_id, n.owner_id = $owner_id
                """,
                tenant_id=tenant_id,
                owner_id=owner_id,
            )

            # Step 3a: Remove stale year-only duplicate relationships.
            # MERGE creates a NEW relationship when properties differ, so old year-only
            # rels (e.g. start:"2013") and new mm/yyyy rels (e.g. start:"02/2013") can
            # coexist. Delete the stale one where a more specific mm/yyyy rel exists.
            print("  -> Cleaning up stale year-only relationships...")
            session.run(
                """
                MATCH (a)-[old_rel]->(b)
                WHERE type(old_rel) IN ['CONTRIBUTED_TO', 'PARTICIPATED_IN',
                                        'FEATURE_GUEST', 'AUTHORED']
                  AND (old_rel.start =~ '^\\d{4}$' OR old_rel.end =~ '^\\d{4}$'
                       OR old_rel.date =~ '^\\d{2}/\\d{4}$')
                WITH a, b, type(old_rel) AS rel_type, old_rel
                MATCH (a)-[new_rel]->(b)
                WHERE type(new_rel) = rel_type
                  AND new_rel <> old_rel
                  AND (new_rel.start =~ '^\\d{2}/\\d{4}$'
                       OR new_rel.end =~ '^\\d{2}/\\d{4}$')
                DELETE old_rel
                """
            )

            # Guard: Remove the historically incorrect 06/2021-07/2025 relationship
            # on "Open-Source AI Agents" that was inherited from Ignite's dates.
            # This node was correctly re-dated to 05/2025-07/2025 per categories_and_projects.md.
            session.run(
                """
                MATCH (a)-[rel:CONTRIBUTED_TO]->(n)
                WHERE n.name CONTAINS 'Open-Source AI Agents'
                  AND rel.start = '06/2021'
                DELETE rel
                """
            )

            # Guard: Remove stale AUTHORED relationships for the InfoQ ThoughtLeadership node
            # that may survive from earlier seed runs with different date values (e.g. "02/2024").
            # The step-3a year-only cleanup only removes year-format rels; mm/yyyy stale rels
            # must be explicitly deleted here so the coalesce year chain returns 2025, not 2024.
            session.run(
                """
                MATCH (p:Person {name: "Sangeetha Ramadurai"})-[rel:AUTHORED]->(t:ThoughtLeadership)
                WHERE t.name CONTAINS "InfoQ"
                  AND NOT (rel.start = "11/2025" AND rel.end = "01/2026")
                DELETE rel
                """
            )

            # Step 3b: Propagate epoch properties from relationships to nodes
            # These denormalized cache properties enable efficient numeric sorting
            # and range-overlap timeline filtering without complex multi-hop traversal.
            print("  -> Propagating epoch date properties to nodes (denormalization pass)...")
            epoch_queries = [
                # Project nodes via CONTRIBUTED_TO relationships
                _build_epoch_cypher("CONTRIBUTED_TO", "Project"),
                # Hackathon nodes via PARTICIPATED_IN relationships
                _build_epoch_cypher("PARTICIPATED_IN", "Hackathon"),
                # ThoughtLeadership nodes via FEATURE_GUEST relationships
                _build_epoch_cypher("FEATURE_GUEST", "ThoughtLeadership"),
                # ThoughtLeadership nodes via AUTHORED relationships (start+end)
                _build_epoch_cypher("AUTHORED", "ThoughtLeadership"),
                # ThoughtLeadership/Project via CONTRIBUTED_TO
                _build_epoch_cypher("CONTRIBUTED_TO", "ThoughtLeadership"),
                # Hackathon nodes branded as Project (dual label)
                _build_epoch_cypher("PARTICIPATED_IN", "Project"),
            ]
            for i, eq in enumerate(epoch_queries, 1):
                print(f"     -> Epoch pass {i}/{len(epoch_queries)}")
                session.run(eq)

            print("\n✓ SUCCESS: Interactive Resume Graph successfully seeded, secured, and epoch-indexed!")

    except Exception as e:
        print(f"\nError during seeding: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        driver.close()


if __name__ == "__main__":
    seed_resume_graph()
