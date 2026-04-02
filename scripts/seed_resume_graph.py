#!/usr/bin/env python3
"""
seed_resume_graph.py - Authoritative Navigable Resume Seeder
This script implements the "Double-Click to Expand" architecture and the
"Private STAR Node" strategy (PreparatoryNote) for Sangeetha's portfolio.
"""

import sys
import os
from neo4j import GraphDatabase
from dotenv import load_dotenv

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

    // Self, Cortex-Drive
    MERGE (c1:Company {name: "Self, Cortex-Drive"})
    MERGE (r1:Role {name: "Founder & Sr. Software Engineer"})
    MERGE (p)-[:CURRENTLY_BUILDING {start: "08/2025", end: "Present"}]->(r1)
    MERGE (r1)-[:AT]->(c1)
    MERGE (cat1)-[:CONTAINS]->(r1)
    MERGE (cat2)-[:CONTAINS]->(r1)

    // JPMC
    MERGE (c2:Company {name: "JPMorgan Chase", location: "Jersey City, NJ"})
    MERGE (r2:Role {name: "Lead Software Engineer, VP"})
    MERGE (p)-[:HELD_ROLE {start: "02/2024", end: "07/2025"}]->(r2)
    MERGE (r2)-[:AT]->(c2)
    MERGE (cat1)-[:CONTAINS]->(r2)

    MERGE (r2_legacy:Role {name: "Sr. Software Engineer (JPMC)"})
    MERGE (p)-[:HELD_ROLE {start: "06/2021", end: "01/2024"}]->(r2_legacy)
    MERGE (r2_legacy)-[:AT]->(c2)
    MERGE (cat1)-[:CONTAINS]->(r2_legacy)

    // Mezocliq
    MERGE (c3:Company {name: "Mezocliq LLC", location: "New York, NY"})
    MERGE (r3:Role {name: "Sr. Software Engineer (Mezocliq)"})
    MERGE (p)-[:HELD_ROLE {start: "02/2013", end: "02/2021"}]->(r3)
    MERGE (r3)-[:AT]->(c3)
    MERGE (cat1)-[:CONTAINS]->(r3)

    // Goldman Sachs
    MERGE (c4:Company {name: "GOLDMAN SACHS & CO."})
    MERGE (r4:Role {name: "Sr. Software Engineer, Consultant"})
    MERGE (p)-[:HELD_ROLE {start: "06/2007", end: "12/2009"}]->(r4)
    MERGE (r4)-[:AT]->(c4)
    MERGE (cat1)-[:CONTAINS]->(r4)

    // GE Healthcare
    MERGE (c5:Company {name: "GE Healthcare"})
    MERGE (r5:Role {name: "IT Systems Specialist"})
    MERGE (p)-[:HELD_ROLE {start: "05/1999", end: "01/2006"}]->(r5)
    MERGE (r5)-[:AT]->(c5)
    MERGE (cat1)-[:CONTAINS]->(r5)

    // Macmet
    MERGE (c6:Company {name: "Macmet India Pvt. Ltd."})
    MERGE (r6:Role {name: "Software Engineer"})
    MERGE (p)-[:HELD_ROLE {start: "08/1997", end: "04/1999"}]->(r6)
    MERGE (r6)-[:AT]->(c6)
    MERGE (cat1)-[:CONTAINS]->(r6)
    """,

    # 3. PROJECTS: OPEN SOURCE & VENTURES
    """
    MERGE (pj:Startup:Project {name: "Cortex-Drive"})
    SET pj.status = "Active",
        pj.description = "A personalized AI that links information across your knowledge landscape, organizing it by meaning and relationships rather than source. Features a personal knowledge graph and explainable AI reasoning.",
        pj.links = ["https://github.com/sangs/cortex-drive"]
    
    WITH pj
    MATCH (r:Role {name: "Founder & Sr. Software Engineer"})
    MATCH (catIndependent:Category {name: "Open Source & Independent Ventures"})
    MATCH (catProfessional:Category {name: "Professional Experience"})
    
    MERGE (r)-[:CONTRIBUTED_TO {start: "08/2025", end: "Present"}]->(pj)
    MERGE (catIndependent)-[:CONTAINS]->(pj)
    MERGE (catProfessional)-[:CONTAINS]->(pj)

    WITH pj
    UNWIND pj.links AS link_url
    MERGE (l:ReferenceLink {url: link_url})
    MERGE (pj)-[:HAS_REFERENCE]->(l)
    """,

    # 4. HACKATHONS (Canonical List of 3)
    """
    MATCH (cat:Category {name: "Hackathons"})
    MATCH (p:Person {name: "Sangeetha Ramadurai"})

    // Hackathon 1: Humanless Autocode
    MERGE (h1:Hackathon:Project {name: "Humanless Autocode at Scale for SRE @ JPMorgan Chase", year: "2025"})
    SET h1.type = "Hackathon",
        h1.description = "Innovation Leadership: Automated, context-aware AI code review process using Sourcegraph's Cody, tailored for enterprise guardrails."
    MERGE (p)-[:PARTICIPATED_IN {role: "Project Lead", start: "2025", end: "2025"}]->(h1)
    MERGE (cat)-[:CONTAINS]->(h1)
    
    MERGE (star1:PreparatoryNote {name: "STAR: Humanless Autocode"})
    SET star1.text = "Situation: IaC reviews were time-consuming and inconsistent... Task: Showcase automated code review at scale using Sourcegraph Cody... Action: Led project, implemented dependency graph analysis and multi-PR generation... Result: Successfully demonstrated automated code review at scale for IaC, dramatically reducing review time while improving safety."
    MERGE (h1)-[:HAS_PRIVATE_NOTE]->(star1)

    // Hackathon 2: Volarisation Engine
    MERGE (h2:Hackathon:Project {name: "Volarisation Engine @ IBM Dev Day 2026", year: "2026"})
    SET h2.type = "Hackathon",
        h2.description = "Innovation Leadership: Explainable, agentic AI decision-support system built with IBM Watsonx Orchestrate to accelerate life-sciences patent research.",
        h2.links = ["https://lnkd.in/dcSmQS4n", "https://sites.google.com/view/valorisationengine/valorisation", "https://drive.proton.me/urls/NYB1KQ7QNC#HueGJ6Nq7AAl"]
    MERGE (p)-[:PARTICIPATED_IN {role: "Lead Developer", start: "2026", end: "2026"}]->(h2)
    MERGE (cat)-[:CONTAINS]->(h2)
    
    MERGE (star2:PreparatoryNote {name: "STAR: Volarisation Engine"})
    SET star2.text = "Situation: Early-stage patent triage was opaque and slow... Task: Develop PoC for transparent, logic-first patent research... Action: Built agentic workflow with IBM Watsonx Orchestrate on IBM Cloud... Result: Formalized PoC for life-sciences commercialization with high explainability."
    MERGE (h2)-[:HAS_PRIVATE_NOTE]->(star2)
    
    WITH h2, cat, p
    UNWIND h2.links AS link_url
    MERGE (l:ReferenceLink {url: link_url})
    MERGE (h2)-[:HAS_REFERENCE]->(l)

    // Hackathon 3: Global Hackathons @ JPMC
    MERGE (h3:Hackathon:Project {name: "Global Hackathons @ JPMorgan Chase", year: "2025"})
    SET h3.type = "Hackathon",
        h3.description = "Innovation Leadership: Led Global Hackathon projects delivering MCP-based AI solutions, including MongoDB and Neo4j MCP clients."
    MERGE (p)-[:PARTICIPATED_IN {role: "Innovation Lead", start: "2025", end: "2025"}]->(h3)
    MERGE (cat)-[:CONTAINS]->(h3)
    
    MERGE (star3:PreparatoryNote {name: "STAR: Global Hackathons"})
    SET star3.text = "Situation: Innovation required contributing to the technical community through open-source... Task: Advance organizational technical capabilities through hackathons... Action: Led projects delivering MCP-based AI solutions (MongoDB, Neo4j)... Result: Created ripple effects across the organization; AI Agent examples accelerated adoption of agent frameworks."
    MERGE (h3)-[:HAS_PRIVATE_NOTE]->(star3)
    """,

    # 5. THOUGHT LEADERSHIP (Canonical List of 2)
    """
    MATCH (cat:Category {name: "Thought Leadership & Community"})
    MATCH (p:Person {name: "Sangeetha Ramadurai"})

    // InfoQ
    MERGE (t1:ThoughtLeadership:Publication {name: "InfoQ: Architectural Shifts for Platform Engineers in the Age of AI"})
    SET t1.type = "ThoughtLeadership",
        t1.description = "Thought Leadership: Co-authored expert article in InfoQ e-magazine, defining mandatory architectural shifts (Governance, Explainability) for AI platform engineering.",
        t1.links = ["https://www.infoq.com/minibooks/architecture-age-ai-opportunity/"]
    MERGE (p)-[:AUTHORED {date: "01/2026"}]->(t1)
    MERGE (cat)-[:CONTAINS]->(t1)
    
    MERGE (star_t1:PreparatoryNote {name: "STAR: InfoQ Publication"})
    SET star_t1.text = "Situation: Blind automation in AI often leads to governance failures... Task: Define safe human-in-the-loop engineering guardrails... Action: Co-authored article in InfoQArchitecture Cohort... Result: Established workflow/alignment patterns adopted by platform teams."
    MERGE (t1)-[:HAS_PRIVATE_NOTE]->(star_t1)

    WITH t1, cat, p
    UNWIND t1.links AS link_url
    MERGE (l:ReferenceLink {url: link_url})
    MERGE (t1)-[:HAS_REFERENCE]->(l)

    // Ignite
    MERGE (t2:ThoughtLeadership:Community {name: "Ignite Social Learning Community @ JPMC"})
    SET t2.type = "ThoughtLeadership",
        t2.description = "Innovation Leadership: Core team member and lead for Ignite Cloud community, driving organic network growth and innovation through structured social learning.",
        t2.links = ["https://www.jpmorganchase.com/about/technology/blog/ignite-takes-new-york-city-by-storm"]
    MERGE (p)-[:LED {role: "Core Team Member", start: "06/2021", end: "07/2025"}]->(t2)
    MERGE (cat)-[:CONTAINS]->(t2)
    
    MERGE (star_t2:PreparatoryNote {name: "STAR: Ignite Community"})
    SET star_t2.text = "Situation: Employees lacked structured opportunities for skills-dev outside day-jobs... Task: Run ecosystem for organic learning and innovation... Action: Organized monthly sessions, mentored leadership potential... Result: Community grew organically, leading to internal mobility and collaboration across JPMC."
    MERGE (t2)-[:HAS_PRIVATE_NOTE]->(star_t2)

    WITH t2, cat, p
    UNWIND t2.links AS link_url
    MERGE (l2:ReferenceLink {url: link_url})
    MERGE (t2)-[:HAS_REFERENCE]->(l2)

    // Open-Source AI Agents Contribution @ JPMC
    MERGE (t3:ThoughtLeadership:Project {name: "Open-Source AI Agents Contribution @ JPMC"})
    SET t3.type = "ThoughtLeadership",
        t3.description = "Thought Leadership: Contributed to Microsoft AutoGen-based AI Agent frameworks at JPMC, fostering knowledge sharing about multi-agent patterns."
    MERGE (p)-[:CONTRIBUTED_TO {start: "06/2021", end: "07/2025"}]->(t3)
    MERGE (cat)-[:CONTAINS]->(t3)

    MERGE (star_t3:PreparatoryNote {name: "STAR: Open-Source AI Agents"})
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
    MATCH (r:Role {name: "Lead Software Engineer, VP"})
    MATCH (cat:Category {name: "Professional Experience"})

    // Metadata Agent
    MERGE (p1:Project {name: "Metadata Agent Architecture"})
    SET p1.description = "Metadata Discovery & RAG Agent: Architected AWS-based AI solution using Lambda, Bedrock, and PG Vector to reduce data discovery time from hours to seconds."
    MERGE (r)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p1)
    MERGE (cat)-[:CONTAINS]->(p1)
    MERGE (n1:PreparatoryNote {name: "STAR: Metadata Agent"})
    SET n1.text = "Situation: Metadata was scattered across AWM data catalogs... Task: Develop AI Agent for natural language discovery... Action: Architected end-to-end with AWS Lambda/Bedrock/PG Vector, built RAG pattern... Result: Reduced discovery time from hours to seconds."
    MERGE (p1)-[:HAS_PRIVATE_NOTE]->(n1)

    // DataMesh Publishing
    MERGE (p2:Project {name: "Instrument Data on DataMesh"})
    SET p2.description = "DataMesh Publishing: Standardized enterprise reference data for AWM by building automated publishing pipelines across the JPMC DataMesh using AWS Glue/Step Functions."
    MERGE (r)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p2)
    MERGE (cat)-[:CONTAINS]->(p2)
    MERGE (n2:PreparatoryNote {name: "STAR: DataMesh Publishing"})
    SET n2.text = "Situation: Bespoke integrations created a fragmented data landscape... Task: Publish Instrument Reference Data on DataMesh... Action: Implemented automated pipeline using AWS Lambda/Step Functions/Glue... Result: Established single standardized source for enterprise reference data."
    MERGE (p2)-[:HAS_PRIVATE_NOTE]->(n2)

    // DataMesh Infrastructure
    MERGE (p3:Project {name: "Infrastructure for Instrument Data on DataMesh"})
    SET p3.description = "DataMesh Infrastructure: Resolved critical architecture blockers by collaborating on enterprise-approved Terraform modules for Lake Formation and S3 Access Points."
    MERGE (r)-[:CONTRIBUTED_TO {start: "02/2024", end: "07/2025"}]->(p3)
    MERGE (cat)-[:CONTAINS]->(p3)
    MERGE (n3:PreparatoryNote {name: "STAR: DataMesh Infrastructure"})
    SET n3.text = "Situation: Lacked approved Terraform modules for Lake Formation... Task: Resolve architecture blockers... Action: Collaborated with platform teams to create enterprise Terraform modules... Result: Removed critical blockers and established reusable infrastructure patterns."
    MERGE (p3)-[:HAS_PRIVATE_NOTE]->(n3)
    """,

    # 7. JPMC PROJECTS (2021-2024 ERA)
    """
    MATCH (r:Role {name: "Sr. Software Engineer (JPMC)"})
    MATCH (cat:Category {name: "Professional Experience"})

    // Gain/Loss
    MERGE (p4:Project {name: "Gain/Loss Cloud Native Microservice"})
    SET p4.description = "Cost Modernization: Designed and implemented a greenfield, cloud-native Gain/Loss microservice on AWS EKS, delivering $338k in annual cost savings and removing vendor dependency."
    MERGE (r)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p4)
    MERGE (cat)-[:CONTAINS]->(p4)
    MERGE (n4:PreparatoryNote {name: "STAR: Gain/Loss MS"})
    SET n4.text = "Situation: Costly dependency on vendor product for real-time gain/loss... Task: Replace vendor product with cloud-native MS... Action: Designed/implemented greenfield MS using Spring/AWS EKS/Kafka... Result: Saved $338k annually and removed external dependency."
    MERGE (p4)-[:HAS_PRIVATE_NOTE]->(n4)

    // Short Orders
    MERGE (p5:Project {name: "Start of Day Open Short Orders Microservice"})
    SET p5.description = "Cloud Transformation: Modernized start-of-day business processing by migrating legacy vendor products to a scalable, cloud-native microservice architecture."
    MERGE (r)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p5)
    MERGE (cat)-[:CONTAINS]->(p5)
    MERGE (n5:PreparatoryNote {name: "STAR: Short Orders MS"})
    SET n5.text = "Situation: Vendor dependency for locating daily open short orders... Task: Implement cloud-native MS to improve integration... Action: Used AWS MSK, CloudWatch, and Datadog for monitoring/alerting... Result: Eliminated licensing costs and gained full control over daily operations."
    MERGE (p5)-[:HAS_PRIVATE_NOTE]->(n5)

    // Corporate Action
    MERGE (p6:Project {name: "Corporate Action Report Automation"})
    MERGE (r)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p6)
    MERGE (cat)-[:CONTAINS]->(p6)
    MERGE (n6:PreparatoryNote {name: "STAR: Corp Action Automation"})
    SET n6.text = "Situation: Manual report generation was time-consuming and prone to delays... Task: Automate Corporate Action reports... Action: Designed/implemented automation microservice integrated with data sources... Result: Improved stakeholder satisfaction through timely and consistent delivery."
    MERGE (p6)-[:HAS_PRIVATE_NOTE]->(n6)

    // Settlement Verification
    MERGE (p7:Project {name: "Settlement Setup Instruction Verification System"})
    MERGE (r)-[:CONTRIBUTED_TO {start: "06/2021", end: "01/2024"}]->(p7)
    MERGE (cat)-[:CONTAINS]->(p7)
    MERGE (n7:PreparatoryNote {name: "STAR: Settlement Verification"})
    SET n7.text = "Situation: Sybase dependency for settlement verification needed strategic exit... Task: Maintain functionality during migration... Action: Led brownfield enhancements, worked with stakeholders on business criteria... Result: Successfully replaced Sybase without disruption to order-raising."
    MERGE (p7)-[:HAS_PRIVATE_NOTE]->(n7)
    """,

    # 8. LEGACY PROJECTS (MEZOCLIQ, GS, GE, MACMET)
    """
    // Mezocliq
    MATCH (r:Role {name: "Sr. Software Engineer (Mezocliq)"})
    MATCH (cat:Category {name: "Professional Experience"})
    
    MERGE (pm1:Project {name: "Cloud-Native Platform Orchestration & Workflow System"})
    MERGE (r)-[:CONTRIBUTED_TO {start: "2013", end: "2021"}]->(pm1)
    MERGE (cat)-[:CONTAINS]->(pm1)

    MERGE (pm2:Project {name: "Enterprise Access Control, Search, and Distributed Infrastructure"})
    MERGE (r)-[:CONTRIBUTED_TO {start: "2013", end: "2021"}]->(pm2)
    MERGE (cat)-[:CONTAINS]->(pm2)

    WITH cat
    // Goldman Sachs
    MATCH (rg:Role {name: "Sr. Software Engineer, Consultant"})
    MERGE (pg1:Project {name: "Executive Workflow Management Platform (Ten Thousand Women)"})
    MERGE (rg)-[:CONTRIBUTED_TO {start: "2007", end: "2009"}]->(pg1)
    MERGE (cat)-[:CONTAINS]->(pg1)

    MERGE (pg2:Project {name: "Capital Attribution & Market Risk Data Platform"})
    MERGE (rg)-[:CONTRIBUTED_TO {start: "2007", end: "2009"}]->(pg2)
    MERGE (cat)-[:CONTAINS]->(pg2)

    WITH cat
    // GE
    MATCH (re:Role {name: "IT Systems Specialist"})
    MERGE (pge1:Project {name: "Radiology Imaging Platform Integration"})
    MERGE (re)-[:CONTRIBUTED_TO {start: "1999", end: "2006"}]->(pge1)
    MERGE (cat)-[:CONTAINS]->(pge1)

    MERGE (pge2:Project {name: "Image Management & Distributed Event Processing System"})
    MERGE (re)-[:CONTRIBUTED_TO {start: "1999", end: "2006"}]->(pge2)
    MERGE (cat)-[:CONTAINS]->(pge2)

    WITH cat
    // Macmet
    MATCH (rm:Role {name: "Software Engineer"})
    MERGE (pma:Project {name: "Simulation systems development and evaluation (Macmet)"})
    MERGE (rm)-[:CONTRIBUTED_TO {start: "1997", end: "1999"}]->(pma)
    MERGE (cat)-[:CONTAINS]->(pma)
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
        cortex: ["Neo4j", "BAML", "Python", "Langflow", "AI Agent", "Supabase", "Railway"]
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
            print(f"Executing {len(RESUME_CYPHER_QUERIES)} definitive mapping queries...")
            for i, query in enumerate(RESUME_CYPHER_QUERIES, 1):
                print(f"  -> Running Query {i}/{len(RESUME_CYPHER_QUERIES)}")
                session.run(query)
                
            tenant_id = os.getenv("TENANT_ID") or "test-tenant"
            print(f"  -> Stamping graph with tenant isolation header: {tenant_id}")
            # Stamp ALL resume-domain nodes explicitly by label.
            # Using an inclusion list is safer than an exclusion list
            # because new node types are NOT stamped by accident.
            session.run("""
            MATCH (n)
            WHERE any(label IN labels(n) WHERE label IN [
                'Person', 'Category', 'Role', 'Company', 'Project',
                'Startup', 'Hackathon', 'ThoughtLeadership', 'Community',
                'Publication', 'PreparatoryNote', 'Skill', 'Institution',
                'Degree', 'Certification', 'ProfessionalEducation', 'OpenSource',
                'SocialLearning', 'ReferenceLink', '__MetaContext__', 'Outcome',
                'Achievement'
            ])
            SET n.tenant_id = $tenant_id
            """, tenant_id=tenant_id)

            print("\n✓ SUCCESS: Interactive Resume Graph successfully seeded and secured!")
    except Exception as e:
        print(f"\nError during seeding: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        driver.close()

if __name__ == "__main__":
    seed_resume_graph()
