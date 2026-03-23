#!/usr/bin/env python3
"""
seed_resume_graph.py

 This script serves as the deterministic, authoritative injection pipeline
 for Sangeetha's Interactive Graph Resume. 
 
 By using MERGE clauses instead of CREATE, this script is fully idempotent.
 You can safely run this script repeatedly. If you modify a description,
 running the script again will update the existing node. If you add a new
 role, running the script will only ingest the newly added components.
"""

import sys
from dotenv import load_dotenv
from typing import List
from neo4j import GraphDatabase
import os

load_dotenv('.env', override=True)

NEO4J_URI = os.getenv("NEO4J_URI", "neo4j://localhost:7687")
NEO4J_USERNAME = os.getenv("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

# We define the resume as an ordered list of Cypher queries.
# This makes it remarkably easy to append new projects at the bottom.
RESUME_CYPHER_QUERIES = [
    # ==========================================
    # 1. CORE IDENTITY
    # ==========================================
    """
    MERGE (p:Person {name: "Sangeetha Ramadurai"})
    SET p.email = "sangramadurai@gmail.com",
        p.linkedin = "https://www.linkedin.com/in/sangeetharamadurai",
        p.bio = "I am a Lead Software Engineer with extensive experience in banking and technology startups, having led AI and data engineering initiatives at JPMorgan Chase and Goldman Sachs. Prior to banking, I spent eight years at Mezocliq building cloud-native platforms. I hold a Master's in Computer Science from Illinois Institute of Technology and recently completed MIT's Applied Data Science Program."
    """,
    
    # ==========================================
    # 2. CHRONOLOGICAL TIMELINE (THE SKELETON)
    # ==========================================
    # Role 1: Self, Cortex-Drive
    """
    MERGE (c1:Company {name: "Self, Cortex-Model"})
    MERGE (r1:Role {name: "Sr. Software Engineer"})
    WITH c1, r1
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "08/2025", end: "Present"}]->(r1)
    MERGE (r1)-[:AT]->(c1)
    MERGE (p)-[:WORKED_AT]->(c1)
    """,
    # Role 2: JPMorgan Chase
    """
    MERGE (c2:Company {name: "JPMorgan Chase", location: "Jersey City, NJ"})
    MERGE (r2:Role {name: "Lead Software Engineer, VP"})
    WITH c2, r2
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "02/2024", end: "07/2025"}]->(r2)
    MERGE (r2)-[:AT]->(c2)
    MERGE (p)-[:WORKED_AT]->(c2)
    """,
    # Role 3: Mezocliq LLC
    """
    MERGE (c3:Company {name: "Mezocliq LLC", location: "New York, NY"})
    MERGE (r3:Role {name: "Sr. Software Engineer"})
    WITH c3, r3
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "02/2013", end: "02/2021"}]->(r3)
    MERGE (r3)-[:AT]->(c3)
    MERGE (p)-[:WORKED_AT]->(c3)
    """,

    # ==========================================
    # 3. DEEP DIVE PROJECTS (THE MEAT)
    # ==========================================
    
    # Project: Cortex-Model
    """
    MERGE (proj_cortex:Startup:Project {name: "Cortex-Drive"})
    SET proj_cortex.description = "A personal startup vision of personalized AI that links information across your knowledge landscape, organizing it by meaning and relationships rather than source. Powered by Neo4j and Python.",
        proj_cortex.link = "https://github.com/sangs/cortex-model"
    
    MERGE (obj_cortex:Objective {description: "Overcome information scatter by creating an underlying semantic layer that reasons over existing tools."})
    MERGE (app_cortex:Approach {description: "Built a knowledge operating system using graph databases to connect people, topics, and content with a natural language semantic interface."})
    MERGE (out_cortex:Outcome {description: "Delivered a fully functional personal knowledge graph architecture with an explainable AI reasoning layer."})
    
    WITH proj_cortex, obj_cortex, app_cortex, out_cortex
    MERGE (proj_cortex)-[:HAS_OBJECTIVE]->(obj_cortex)
    MERGE (proj_cortex)-[:USES_APPROACH]->(app_cortex)
    MERGE (proj_cortex)-[:HAS_RESULTS]->(out_cortex)
    
    WITH proj_cortex
    MATCH (r1:Role {name: "Sr. Software Engineer"}), (c1:Company {name: "Self, Cortex-Model"})
    WHERE (r1)-[:AT]->(c1)
    MERGE (r1)-[:CONTRIBUTED_TO]->(proj_cortex)
    """,

    # Project: JPMC Metadata Agent
    """
    MERGE (proj_meta:Project {name: "Metadata Agent Architecture"})
    SET proj_meta.description = "Develop an Agent for users and other Agents to access various data product catalogs from the Instrument Reference data universe."
    
    MERGE (obj_meta:Objective {description: "Enable natural language access to complex, scattered data catalogs using vector embeddings."})
    MERGE (app_meta:Approach {description: "Extracted DEx metadata to PG Vector. Orchestrated a LangGraph-based RAG workflow combining vector similarity search with structured LLM query generation."})
    MERGE (out_meta:Outcome {description: "Significantly improved discoverability of instrument reference data via reliable, semantic natural language queries."})
    
    WITH proj_meta, obj_meta, app_meta, out_meta
    MERGE (proj_meta)-[:HAS_OBJECTIVE]->(obj_meta)
    MERGE (proj_meta)-[:USES_APPROACH]->(app_meta)
    MERGE (proj_meta)-[:HAS_RESULTS]->(out_meta)
    
    WITH proj_meta
    MATCH (r2:Role {name: "Lead Software Engineer, VP"}), (c2:Company {name: "JPMorgan Chase"})
    WHERE (r2)-[:AT]->(c2)
    MERGE (r2)-[:CONTRIBUTED_TO]->(proj_meta)
    """,
    
    # Project: Instrument Data on DataMesh
    """
    MERGE (proj_mesh:Project {name: "Instrument Data on DataMesh"})
    SET proj_mesh.description = "Publish Instrument Reference Data on DataMesh to establish a standard enterprise access pattern."
    
    MERGE (obj_mesh:Objective {description: "Standardize access to Instrument Reference Data, eliminating bespoke and fragmented integrations."})
    MERGE (app_mesh:Approach {description: "Implemented an automated pipeline publishing daily Parquet files to AWS S3. Configured EventBridge and Lambda to trigger AWS Glue partition jobs based on Line of Business."})
    MERGE (out_mesh:Outcome {description: "Successfully pioneered the first on-prem to cloud move of Instrument classification data and established a unified golden source for consumers."})
    
    WITH proj_mesh, obj_mesh, app_mesh, out_mesh
    MERGE (proj_mesh)-[:HAS_OBJECTIVE]->(obj_mesh)
    MERGE (proj_mesh)-[:USES_APPROACH]->(app_mesh)
    MERGE (proj_mesh)-[:HAS_RESULTS]->(out_mesh)
    
    WITH proj_mesh
    MATCH (r2:Role {name: "Lead Software Engineer, VP"}), (c2:Company {name: "JPMorgan Chase"})
    WHERE (r2)-[:AT]->(c2)
    MERGE (r2)-[:CONTRIBUTED_TO]->(proj_mesh)
    """,

    # ==========================================
    # 3b. ADDITIONAL PROJECTS FROM RESUME
    # ==========================================
    
    # Event: Volarisation Engine Hackathon
    """
    MERGE (h1:Hackathon {name: "AI Demystified Hackathon by IBM", date: "Jan-Feb 2026"})
    WITH h1
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:PARTICIPATED_IN {role: "Personal participation"}]->(h1)

    MERGE (proj_ve:Project {name: "Volarisation Agent"})
    SET proj_ve.description = "Explainable, agentic AI decision-support system built with IBM Watsonx Orchestrate for patent research and commercial decision support.",
        proj_ve.link = "https://lnkd.in/dcSmQS4n"
    
    MERGE (proj_ve)-[:BUILT_DURING]->(h1)
    
    MERGE (obj_ve:Objective {description: "Accelerate life-sciences commercialization by transforming raw research inputs into actionable venture insights."})
    MERGE (app_ve:Approach {description: "Formalized early-stage patent triage into a transparent, logic-first workflow supporting expert judgement while improving speed and consistency."})
    MERGE (out_ve:Outcome {description: "Developed and presented as a proof-of-concept on IBM Cloud at IBM Dev Day 2026 - AI Demystified Hackathon."})
    
    WITH proj_ve, obj_ve, app_ve, out_ve
    MERGE (proj_ve)-[:HAS_OBJECTIVE]->(obj_ve)
    MERGE (proj_ve)-[:USES_APPROACH]->(app_ve)
    MERGE (proj_ve)-[:HAS_RESULTS]->(out_ve)
    """,

    # Certification & Publication: InfoQ
    """
    MERGE (cert:Certification {name: "InfoQ Certified Architect"})
    SET cert.description = "Strengthened skills in modern architecture, resilience patterns, decentralized decision-making, platform engineering, and AI systems."
    
    MERGE (pub:Publication {name: "Architectural Shifts for Platform Engineers in the Age of AI"})
    SET pub.link = "https://www.infoq.com/minibooks/architecture-age-ai-opportunity/"
    
    WITH cert, pub
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:EARNED]->(cert)
    MERGE (p)-[:CO_AUTHORED]->(pub)
    MERGE (pub)-[:DERIVED_FROM]->(cert)
    
    WITH cert
    MATCH (r1:Role {name: "Sr. Software Engineer"}), (c1:Company {name: "Self, Cortex-Model"})
    WHERE (r1)-[:AT]->(c1)
    MERGE (r1)-[:CONTRIBUTED_TO]->(cert)
    """,

    # Certification: Problem-First Agentic AI
    """
    MERGE (cert_prob:Certification {name: "Building Agentic AI Applications with a Problem-First Approach"})
    SET cert_prob.description = "Practical, collaborative space to explore and apply agentic AI, learning from experts across OpenAI, AWS, and Google."
    
    WITH cert_prob
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:EARNED]->(cert_prob)
    
    WITH cert_prob
    MATCH (r1:Role {name: "Sr. Software Engineer"}), (c1:Company {name: "Self, Cortex-Model"})
    WHERE (r1)-[:AT]->(c1)
    MERGE (r1)-[:CONTRIBUTED_TO]->(cert_prob)
    """,

    # Hackathons & Open-Source: JPMorgan
    """
    MERGE (h2:Hackathon {name: "Humanless Autocode at Scale"})
    MERGE (h3:Hackathon {name: "Global Hackathon MCP solutions"})
    
    WITH h2, h3
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:PARTICIPATED_IN {role: "TSP Graduate"}]->(h2)
    MERGE (p)-[:LED]->(h3)

    MERGE (proj_os:OpenSource {name: "MCP server for internal news access"})
    SET proj_os.description = "Developed MongoDB and Neo4j MCP clients and an MCP server for internal news access."
    
    MERGE (proj_os)-[:BUILT_DURING]->(h2)
    MERGE (proj_os)-[:BUILT_DURING]->(h3)
    
    WITH proj_os
    MATCH (r2:Role {name: "Lead Software Engineer, VP"}), (c2:Company {name: "JPMorgan Chase"})
    WHERE (r2)-[:AT]->(c2)
    MERGE (r2)-[:CONTRIBUTED_TO]->(proj_os)
    """,

    # Social Learning: Ignite Community
    """
    MERGE (ignite:SocialLearning {name: "Ignite Community Leadership"})
    SET ignite.description = "Core team member of Ignite community in New York Metro, working with 9 active communities and 18 community leads."
    
    MERGE (blog:Publication {name: "Ignite takes New York City by storm"})
    SET blog.link = "https://www.jpmorganchase.com/about/technology/blog/ignite-takes-new-york-city-by-storm"
    
    WITH ignite, blog
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:PARTICIPATED_IN {role: "Core Team Member"}]->(ignite)
    MERGE (p)-[:AUTHORED]->(blog)
    MERGE (ignite)-[:AUTHORED]->(blog)
    
    WITH ignite
    MATCH (r2:Role {name: "Lead Software Engineer, VP"}), (c2:Company {name: "JPMorgan Chase"})
    WHERE (r2)-[:AT]->(c2)
    MERGE (r2)-[:CONTRIBUTED_TO]->(ignite)
    """,

    # ==========================================
    # 2b. ADDITIONAL CHRONOLOGICAL TIMELINE (OLDER)
    # ==========================================
    # Role 4: Goldman Sachs & Co.
    """
    MERGE (c4:Company {name: "GOLDMAN SACHS & CO.", location: "New York, NY"})
    MERGE (r4:Role {name: "Sr. Software Engineer, Consultant"})
    WITH c4, r4
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "06/2007", end: "12/2009"}]->(r4)
    MERGE (r4)-[:AT]->(c4)
    MERGE (p)-[:WORKED_AT]->(c4)
    """,
    # Role 5: GE Healthcare
    """
    MERGE (c5:Company {name: "GE Healthcare", location: "Chicago, IL"})
    MERGE (r5:Role {name: "IT Systems Specialist"})
    WITH c5, r5
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "05/1999", end: "01/2006"}]->(r5)
    MERGE (r5)-[:AT]->(c5)
    MERGE (p)-[:WORKED_AT]->(c5)
    """,
    # Role 6: Macmet India
    """
    MERGE (c6:Company {name: "Macmet India Pvt. Ltd.", location: "Bangalore, India"})
    MERGE (r6:Role {name: "Software Engineer"})
    WITH c6, r6
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    MERGE (p)-[:HELD_ROLE {start: "08/1997", end: "04/1999"}]->(r6)
    MERGE (r6)-[:AT]->(c6)
    MERGE (p)-[:WORKED_AT]->(c6)
    """,

    # ==========================================
    # 3c. ADDITIONAL PROJECTS: MEZOCLIQ
    # ==========================================
    """
    MERGE (proj_mezo1:Project {name: "Cloud Native Microservices Platform"})
    SET proj_mezo1.description = "Developed cloud native microservices responsible for orchestrating UI interaction, executing user defined approval rules, auto scheduling, and alert notifications. Ensured on-demand CI/CD using Jenkins and Kubernetes."
    
    WITH proj_mezo1
    MATCH (r:Role {name: "Sr. Software Engineer"}), (c:Company {name: "Mezocliq LLC"})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_mezo1)
    """,
    """
    MERGE (proj_mezo2:Project {name: "User Privilege Cassandra Data Model"})
    SET proj_mezo2.description = "Designed user privilege data model persisted in Cassandra to enforce access restriction for legal entities."
    
    WITH proj_mezo2
    MATCH (r:Role {name: "Sr. Software Engineer"}), (c:Company {name: "Mezocliq LLC"})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_mezo2)
    """,
    """
    MERGE (proj_mezo3:Project {name: "Full Text Search & Analytics Platform"})
    SET proj_mezo3.description = "Implemented full text search capability using Elastic Search and Siren, distributed caching with Hazelcast, and thrift services for validating active user sessions."
    
    WITH proj_mezo3
    MATCH (r:Role {name: "Sr. Software Engineer"}), (c:Company {name: "Mezocliq LLC"})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_mezo3)
    """,

    # ==========================================
    # 3d. ADDITIONAL PROJECTS: GOLDMAN SACHS
    # ==========================================
    """
    MERGE (proj_gs1:Project {name: "Ten Thousand Women Initiative Web Application"})
    SET proj_gs1.description = "Lead the software development activities of an existing prototype of a web application for the executive office to set up and test project submission, employee registration, and approval workflow."
    
    WITH proj_gs1
    MATCH (r:Role {name: "Sr. Software Engineer, Consultant"}), (c:Company {name: "GOLDMAN SACHS & CO."})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_gs1)
    """,
    """
    MERGE (proj_gs2:Project {name: "CSE Capital Attribution & Market Risk IT"})
    SET proj_gs2.description = "Implemented CSE capital attribution process in DB2 and re-designed market risk IT process interacting with P&L. Developed corporate risk reporting prototype using SecDB slang."
    
    WITH proj_gs2
    MATCH (r:Role {name: "Sr. Software Engineer, Consultant"}), (c:Company {name: "GOLDMAN SACHS & CO."})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_gs2)
    """,

    # ==========================================
    # 3e. ADDITIONAL PROJECTS: GE HEALTHCARE
    # ==========================================
    """
    MERGE (proj_ge1:Project {name: "PACS and 3D Clinical Applications Integration"})
    SET proj_ge1.description = "Integrated GE's PACS with Advantage Workstation system enabling Radiologists to access 3D clinical applications from a single workstation. Demonstrated successfully at SCAR and RSNA."
    
    WITH proj_ge1
    MATCH (r:Role {name: "IT Systems Specialist"}), (c:Company {name: "GE Healthcare"})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_ge1)
    """,
    """
    MERGE (proj_ge2:Project {name: "Image Management Platform & Distributed Event Communication"})
    SET proj_ge2.description = "Integrated networking and archiving platform with X-ray workstation and evaluated a new Distributed Event communication model for CT platform using ACE/TAO."
    
    WITH proj_ge2
    MATCH (r:Role {name: "IT Systems Specialist"}), (c:Company {name: "GE Healthcare"})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_ge2)
    """,

    # ==========================================
    # 3f. ADDITIONAL PROJECTS: MACMET INDIA
    # ==========================================
    """
    MERGE (proj_mac:Project {name: "Prosolvia and Clarus Simulation Platform"})
    SET proj_mac.description = "Implemented solutions for improving the efficiency and productivity of the simulation environment for scientific software using VC++ and Lead Tools API."
    
    WITH proj_mac
    MATCH (r:Role {name: "Software Engineer"}), (c:Company {name: "Macmet India Pvt. Ltd."})
    WHERE (r)-[:AT]->(c)
    MERGE (r)-[:CONTRIBUTED_TO]->(proj_mac)
    """,

    # ==========================================
    # 4. EDUCATION & SKILLS
    # ==========================================
    """
    MATCH (p:Person {name: "Sangeetha Ramadurai"})
    
    // Degrees
    MERGE (inst1:Institution {name: "MIT Professional Education"})
    MERGE (deg1:Degree {name: "Applied Data Science Program, AI & ML", year: "2024"})
    MERGE (p)-[:EARNED_DEGREE]->(deg1)
    MERGE (deg1)-[:FROM_INSTITUTION]->(inst1)
    
    MERGE (inst2:Institution {name: "Illinois Institute of Technology", location: "Chicago, IL"})
    MERGE (deg2:Degree {name: "Master's Degree in Computer Science", year: "2011"})
    MERGE (p)-[:EARNED_DEGREE]->(deg2)
    MERGE (deg2)-[:FROM_INSTITUTION]->(inst2)
    
    MERGE (inst3:Institution {name: "National Institute of Technology", location: "Bhopal, India"})
    MERGE (deg3:Degree {name: "Bachelor's Degree (B.E.) in Electronics and Communication", year: "1997"})
    MERGE (p)-[:EARNED_DEGREE]->(deg3)
    MERGE (deg3)-[:FROM_INSTITUTION]->(inst3)
    
    // Skills Grouping
    MERGE (s1:Skill {name: "Quarkus", category: "Cloud Native"})
    MERGE (s2:Skill {name: "Kafka", category: "Distributed Systems"})
    MERGE (s3:Skill {name: "Smallrye Mutiny", category: "Cloud Native"})
    MERGE (s4:Skill {name: "gRPC", category: "Distributed Systems"})
    MERGE (s5:Skill {name: "Protocol Buffers", category: "Data Serialization"})
    MERGE (s6:Skill {name: "JSON", category: "Data Serialization"})
    MERGE (s7:Skill {name: "Thrift", category: "Data Serialization"})
    MERGE (s8:Skill {name: "Cassandra", category: "Data Store"})
    MERGE (s9:Skill {name: "Elastic Search", category: "Data Store"})
    MERGE (s10:Skill {name: "Java", category: "Programming Languages"})
    MERGE (s11:Skill {name: "Python", category: "Programming Languages"})
    MERGE (s12:Skill {name: "AWS", category: "Cloud Infrastructures"})
    MERGE (s13:Skill {name: "Docker/Kubernetes", category: "Build Tools"})
    
    // Wire Skills
    MERGE (p)-[:HAS_SKILL]->(s1)  MERGE (p)-[:HAS_SKILL]->(s2)
    MERGE (p)-[:HAS_SKILL]->(s3)  MERGE (p)-[:HAS_SKILL]->(s4)
    MERGE (p)-[:HAS_SKILL]->(s5)  MERGE (p)-[:HAS_SKILL]->(s6)
    MERGE (p)-[:HAS_SKILL]->(s7)  MERGE (p)-[:HAS_SKILL]->(s8)
    MERGE (p)-[:HAS_SKILL]->(s9)  MERGE (p)-[:HAS_SKILL]->(s10)
    MERGE (p)-[:HAS_SKILL]->(s11) MERGE (p)-[:HAS_SKILL]->(s12)
    MERGE (p)-[:HAS_SKILL]->(s13)
    """,

    # ==========================================
    # 5. KEYWORDS TO PROJECT TOOLS
    # ==========================================
    """
    // Cortex-Drive Tools
    WITH ["Neo4j", "BAML", "Python", "Langflow", "AI Agent", "Supabase", "Railway"] as cortex_tools
    MATCH (p) WHERE p.name IN ["Cortex-Drive", "Volarisation Agent", "Building Agentic AI Applications with a Problem-First Approach", "InfoQ Certified Architect"]
    UNWIND cortex_tools as c_tool
    MERGE (t:Tool:Technology {name: c_tool})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // JPMC DataMesh / Agent Tools
    WITH ["AWS Lambda", "Step Function", "Glue", "Lake Formation", "DataMesh", "Snowflake", "Starburst", "Python", "ML", "AI Agent", "LangGraph"] as jpmc_tools
    MATCH (p) WHERE p.name IN ["Instrument Data on DataMesh", "Metadata Agent Architecture", "MCP server for internal news access"]
    UNWIND jpmc_tools as j_tool
    MERGE (t:Tool:Technology {name: j_tool})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // Mezocliq Platform Tools
    WITH ["Agile software development", "micro services", "cloud computing", "Quarkus", "Docker", "Jenkins", "Kubernetes", "AWS", "React"] as mezo_tools1
    MATCH (p:Project {name: "Cloud Native Microservices Platform"})
    UNWIND mezo_tools1 as m_tool1
    MERGE (t:Tool:Technology {name: m_tool1})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // Mezocliq App Server Tools
    WITH ["Agile software development", "Java", "GWT", "Elastic Search", "Thrift API", "Protocol Buffer", "Kafka Streams", "Cassandra"] as mezo_tools2
    MATCH (p:Project) WHERE p.name IN ["User Privilege Cassandra Data Model", "Full Text Search & Analytics Platform"]
    UNWIND mezo_tools2 as m_tool2
    MERGE (t:Tool:Technology {name: m_tool2})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // Goldman Sachs Ten Thousand Women Tools
    WITH ["Java J2EE", "Struts", "Hibernate", "Tomcat", "DB2"] as gs_tools1
    MATCH (p:Project {name: "Ten Thousand Women Initiative Web Application"})
    UNWIND gs_tools1 as g_tool1
    MERGE (t:Tool:Technology {name: g_tool1})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // Goldman Sachs Risk Tools
    WITH ["Java", "Slang", "DB2", "SecDB"] as gs_tools2
    MATCH (p:Project {name: "CSE Capital Attribution & Market Risk IT"})
    UNWIND gs_tools2 as g_tool2
    MERGE (t:Tool:Technology {name: g_tool2})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // GE Healthcare PACS Tools
    WITH ["Java", "C", "C++", "Sybase"] as ge_tools1
    MATCH (p:Project {name: "PACS and 3D Clinical Applications Integration"})
    UNWIND ge_tools1 as ge_t1
    MERGE (t:Tool:Technology {name: ge_t1})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // GE Healthcare Image Management
    WITH ["C", "C++", "CORBA", "Third Party Package ACE"] as ge_tools2
    MATCH (p:Project {name: "Image Management Platform & Distributed Event Communication"})
    UNWIND ge_tools2 as ge_t2
    MERGE (t:Tool:Technology {name: ge_t2})
    MERGE (p)-[:USES_TOOL]->(t)
    """,
    """
    // Macmet India Tools
    WITH ["VC++", "Lead Tools API"] as mac_tools
    MATCH (p:Project {name: "Prosolvia and Clarus Simulation Platform"})
    UNWIND mac_tools as m_t
    MERGE (t:Tool:Technology {name: m_t})
    MERGE (p)-[:USES_TOOL]->(t)
    """
]

def seed_resume_graph():
    if not NEO4J_PASSWORD:
        print("Error: NEO4J_PASSWORD environment variable is not set.")
        sys.exit(1)

    print(f"Connecting to Neo4j at {NEO4J_URI}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
    
    try:
        with driver.session() as session:
            print(f"Executing {len(RESUME_CYPHER_QUERIES)} deterministic mapping queries...")
            for i, query in enumerate(RESUME_CYPHER_QUERIES, 1):
                print(f"  -> Running Query {i}/{len(RESUME_CYPHER_QUERIES)}")
                session.run(query)
                
            tenant_id = os.getenv("TENANT_ID") or "test-tenant"
            print(f"  -> Stamping graph with tenant isolation header: {tenant_id}")
            session.run("""
            MATCH (n)
            // Exclude Podcast elements which already have strict Tenant pipelines
            WHERE NOT n:Chunk AND NOT n:Episode AND NOT n:Topic AND NOT n:Source AND NOT n:ReferenceLink AND NOT n:Podcast AND NOT n:Concept AND NOT n:Technology AND NOT n:__MetaContext__
            SET n.tenant_id = $tenant_id
            """, tenant_id=tenant_id)

            print("\n✓ SUCCESS: Interactive Resume Graph successfully seeded and secured!")
            print("  You can safely re-run this script at any time to patch in updates or edits.")
    except Exception as e:
        print(f"\nError during seeding: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        driver.close()

if __name__ == "__main__":
    seed_resume_graph()
