// Project Management Entity Classes
// Represents the Why, How, and Who structure of a project

// Why: Purpose & Value cluster
class Purpose {
  description string
  objectives string[] @description("What the project aims to accomplish in order to fullfill the purpose? It is concrete, measurable and breaks down purpose into actionable component")
}

//Waht: would the benefit to the organization be if the project succeeded?
class Value {
  description string
  benefits string[] @description("Specific benefits the organization will receive if the project succeeds")
  metrics string[]? @description("Organization-level metrics that quantify the value/benefit delivered to the organization (e.g., ROI, efficiency gains, cost savings, reduction in integration time)")
}

//What: What will we accomplish?
class Outcomes {
  description string
  successCriteria string[] @description("How would we know that the project succeeded?")
  measurableResults string[]? @description("Post-implementation actual measured results that demonstrate this specific outcome was achieved (e.g., 'Pipeline processes 1000 records/day', 'System handles 1200 requests/min')")
}

// How: Approach & Plan cluster
class Methods {
  name string
  description string
  steps string[]?
}

class Tools {
  name string
  description string
  category string?
}

class Technologies {
  name string
  description string
}

class Plan {
  name string
  description string
  methods Methods[]
  tools Tools[]
  timeline string?
  milestones string[]?
}

class Approach {
  description string
  methodology string?
  plan Plan
}

// Who: Team & Responsibilities cluster
class Responsibilities {
  description string
  tasks string[]
  deliverables string[]? @description("Concrete deliverables or outputs produced by fulfilling this responsibility")
}

class Roles {
  name string
  description string
  responsibilities Responsibilities[]
}

class Team {
  name string
  description string?
  roles Roles[]
  members string[]?
}

// Main Project entity
class Project {
  name string @description("What is the name of the project?")
  description string @description("What is the description of the project?")
  employer string @description("Employer of the project?")
  location string @description("Location of the project?")
  startDate string? @description("Start date of the project?")
  endDate string? @description("End date of the project?")
  duration string? @description("Duration of the project?")
  
  // Why: Purpose & Value relationships
  purpose Purpose @description("Why are we doing this project?")
  value Value @description("What would the benefit to the organization be if the project succeeded?")
  outcomes Outcomes[] @description("What will we accomplish? How would we know that the project succeeded?")
  technologies Technologies[] @description("What technologies will we use?")
  
  // How: Approach & Plan relationships
  approach Approach @description("How will we going  to do this project?")
  
  // Who: Team & Responsibilities relationships
  team Team @description("Who is going to do what on the project? What resources will we need to complete the project?")
}

// Create a function to extract project information from a string.
function ExtractProject(projectContent: string) -> Project {
  // Specify a client as provider/model-name
  // You can also use custom LLM params with a custom client name from clients.baml like "client CustomGPT5" or "client CustomSonnet4"
  client CustomGPT4oMini // Using GPT-4o-mini (cost-efficient model)
  prompt #"
    Extract project information from this content, organizing it into the Why (Purpose & Value), How (Approach & Plan), and Who (Team & Responsibilities) structure:
    {{ projectContent }}

    {{ ctx.output_format }}
  "#
}

test project_test_one {
  functions [ExtractProject]
  args {
    projectContent #"
      Project:
      - Name: Metadata Agent
      - Description: 
      Lead Software Engineer, VP
Asset & Wealth Management, JPMorgan Chase, Jersey City, NJ
Metadata Agent Architecture
1) As a member of a focus group team, worked on developing AI agents that integrate instrument reference data with Wealth Management's AI systems. Specifically focused on building text-to-SQL agent orchestration that reads data from Snowflake databases while consulting business metadata catalogs to enrich context and improve data accuracy.
2)
Situation: Users and other agents within our Asset and Wealth Management (AWM) organization needed a way to access various data product catalogs from the Instrument Reference data universe. The challenge was that metadata was scattered across different sources, making it difficult for users to find relevant data products using natural language queries.
Task: I was tasked with developing a Metadata Agent that would enable intuitive access to data catalogs through natural language queries and provide semantically relevant responses. The system needed to read metadata from Data Explorer (DEx), AWM's internal data catalog, and make it searchable using vector embeddings.
Action: I designed and implemented an end-to-end solution where metadata from various data products was extracted from Data Explorer and transformed into embeddings stored in PG Vector (v0.5.0) database. I implemented a vector similarity search capability that processes user natural language questions by creating query embeddings as search terms. The system contextualizes prompts, serves up contextual data, and represents it to make intelligent decisions. When users submit questions, the agent performs vector similarity search to find semantically similar data and returns the top K relevant responses, which are then combined with system and user prompts and sent to the LLM for structured answers.
Result: The Metadata Agent successfully enabled users and other agents to discover and access data products using natural language queries, significantly improving the discoverability of instrument reference data across the organization. The vector search capability provided semantically relevant results that helped users find the exact data products they needed without knowing specific technical details or catalog structures.

    "#
  }
}

test project_test_two {
  functions [ExtractProject]
  args {
    projectContent #"
      Project:
- Name: Instrument On DataNMesh
- Lengthy name: Instrument Data on DataMesh - Publishing Pipeline
- Team, Employer, Location: Asset & Wealth Management, JPMorgan Chase, Jersey City, NJ
- Role held: Lead Software Engineer, VP
- Description:
1) Led the instrument reference data to Data Mesh initiative as both technical lead and hands-on engineer
2)
Situation: Prior to DataMesh implementation, each AWM (Asset and Wealth Management) team and organization-wide consumer had bespoke integrations with Instrument data sources for their individual workflows. This created a fragmented landscape where discovering data and understanding schemas was inconsistent and inefficient across the organization.
Task: My goal was to publish Instrument Reference Data on DataMesh to provide AWM teams with a standardized way to access Instrument Reference Data. I needed to implement an automated pipeline that would make the Instrument data schema available on the AWM and enterprise-wide federated data catalog platform.
Action: I implemented an automated pipeline to publish instrument data on DataMesh. The pipeline triggers once daily Start of Day (SOD) Instrument reference data—comprising Instrument, Pricing, and Classification data from various sources—becomes available. The automation generates parquet files with Instrument reference data on AWS S3, which serves as the golden source of truth for all instrument reference data. I configured EventBridge rules to trigger AWS Glue jobs upon arrival of parquet files on AWS S3, implementing partition logic based on lines of business through Lambda functions. The AWS Glue jobs process parquet files and create data partitions based on Lines of Business (LOB) and business date requirements, with SNS notifications sent to consumers and DataMesh stakeholders when new data partitions are ready.
Result: The automated pipeline successfully eliminated bespoke integrations, providing a single standardized source for Instrument Reference Data accessible through DataMesh. Consumers now receive automatic notifications when new data is available, and the centralized schema on the federated data catalog platform enables consistent data discovery across the enterprise.

    "#
  }
}
