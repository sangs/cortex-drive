# Neo4j Project Graph Schema - Nodes and Relationships

## Source Code Location

**Primary Implementation**: `project-cortex-model.ipynb`

The main function is `create_project_graph(project: Project, driver)` which orchestrates the creation of all nodes and relationships through helper functions:

- `_create_project_node()` - Creates Project node
- `_create_purpose_and_objectives()` - Creates Purpose and Objectives
- `_create_value_and_benefits()` - Creates Value, Benefits, and Metrics
- `_create_outcomes()` - Creates Outcomes, SuccessCriteria, and MeasurableResults
- `_create_technologies()` - Creates Technologies
- `_create_approach_and_plan()` - Creates Approach, Plan, Methods, Tools, Timeline, Milestones
- `_create_team_and_roles()` - Creates Team, Roles, Responsibilities, Tasks, Deliverables, TeamMembers

## Nodes Created

### Core Project Nodes
1. **Project**
   - Properties: `name`, `description`, `employer`, `location`, `startDate`, `endDate`, `duration`
   - Unique identifier: `{name}`

### Why: Purpose & Value Cluster
2. **Purpose**
   - Properties: `description`
   - Unique identifier: `{description}`

3. **Objective**
   - Properties: `text`
   - Unique identifier: `{text}`

4. **Value**
   - Properties: `description`
   - Unique identifier: `{description}`

5. **Benefit**
   - Properties: `text`
   - Unique identifier: `{text}`

6. **Metric**
   - Properties: `text`
   - Unique identifier: `{text}`

### Outcomes Cluster
7. **Outcome**
   - Properties: `description`
   - Unique identifier: `{description}`

8. **SuccessCriteria**
   - Properties: `text`
   - Unique identifier: `{text}`

9. **MeasurableResult**
   - Properties: `text`
   - Unique identifier: `{text}`

### Technologies
10. **Technology**
    - Properties: `name`, `description`
    - Unique identifier: `{name}`

### How: Approach & Plan Cluster
11. **Approach**
    - Properties: `description`, `methodology`
    - Unique identifier: `{description}`

12. **Plan**
    - Properties: `name`, `description`
    - Unique identifier: `{name}`

13. **Method**
    - Properties: `name`, `description`
    - Unique identifier: `{name}`

14. **MethodStep**
    - Properties: `text`
    - Unique identifier: `{text}`

15. **Tool**
    - Properties: `name`, `description`, `category`
    - Unique identifier: `{name}`

16. **Timeline**
    - Properties: `text`
    - Unique identifier: `{text}`

17. **Milestone**
    - Properties: `text`
    - Unique identifier: `{text}`

### Who: Team & Responsibilities Cluster
18. **Team**
    - Properties: `name`, `description`
    - Unique identifier: `{name}`

19. **Role**
    - Properties: `name`, `description`
    - Unique identifier: `{name}`

20. **Responsibility**
    - Properties: `description`
    - Unique identifier: `{description}`

21. **Task**
    - Properties: `text`
    - Unique identifier: `{text}`

22. **Deliverable**
    - Properties: `text`
    - Unique identifier: `{text}`

23. **TeamMember**
    - Properties: `name`
    - Unique identifier: `{name}`

## Relationships Created

### Project to Purpose & Value
- `Project` → `[:HAS_PURPOSE]` → `Purpose`
- `Project` → `[:DELIVERS]` → `Value`
- `Project` → `[:USES_TECH]` → `Technology`
- `Project` → `[:USES_APPROACH]` → `Approach`
- `Project` → `[:INVOLVES]` → `Team`

### Purpose Hierarchy
- `Purpose` → `[:HAS_OBJECTIVE]` → `Objective`
- `Purpose` → `[:DEFINES_OUTCOMES]` → `Outcome`

### Value Hierarchy
- `Value` → `[:HAS_BENEFIT]` → `Benefit`
- `Value` → `[:MEASURED_BY]` → `Metric`

### Outcomes Hierarchy
- `Outcome` → `[:HAS_CRITERIA]` → `SuccessCriteria`
- `Outcome` → `[:HAS_RESULTS]` → `MeasurableResult`

### Approach & Plan Hierarchy
- `Approach` → `[:HAS_PLAN]` → `Plan`
- `Plan` → `[:USES_METHOD]` → `Method`
- `Plan` → `[:USES_TOOL]` → `Tool`
- `Plan` → `[:HAS_TIMELINE]` → `Timeline`
- `Plan` → `[:HAS_MILESTONES]` → `Milestone`
- `Method` → `[:HAS_STEP]` → `MethodStep`

### Team & Responsibilities Hierarchy
- `Team` → `[:HAS_ROLE]` → `Role`
- `Team` → `[:INCLUDES]` → `TeamMember`
- `Role` → `[:RESPONSIBLE_FOR]` → `Responsibility`
- `Responsibility` → `[:HAS_TASK]` → `Task`
- `Responsibility` → `[:HAS_DELIVERABLE]` → `Deliverable`

## Complete Graph Structure

```
Project
├── [:HAS_PURPOSE] → Purpose
│   ├── [:HAS_OBJECTIVE] → Objective
│   └── [:DEFINES_OUTCOMES] → Outcome
│       ├── [:HAS_CRITERIA] → SuccessCriteria
│       └── [:HAS_RESULTS] → MeasurableResult
│
├── [:DELIVERS] → Value
│   ├── [:HAS_BENEFIT] → Benefit
│   └── [:MEASURED_BY] → Metric
│
├── [:USES_TECH] → Technology
│
├── [:USES_APPROACH] → Approach
│   └── [:HAS_PLAN] → Plan
│       ├── [:USES_METHOD] → Method
│       │   └── [:HAS_STEP] → MethodStep
│       ├── [:USES_TOOL] → Tool
│       ├── [:HAS_TIMELINE] → Timeline
│       └── [:HAS_MILESTONES] → Milestone
│
└── [:INVOLVES] → Team
    ├── [:HAS_ROLE] → Role
    │   └── [:RESPONSIBLE_FOR] → Responsibility
    │       ├── [:HAS_TASK] → Task
    │       └── [:HAS_DELIVERABLE] → Deliverable
    └── [:INCLUDES] → TeamMember
```

## Implementation Details

### Function: `create_project_graph(project: Project, driver)`
**Location**: `project-cortex-model.ipynb`, Cell 3

**Execution Order**:
1. Creates Project node
2. Creates Purpose and Objectives (linked to Project)
3. Creates Value, Benefits, and Metrics (linked to Project)
4. Creates Outcomes, SuccessCriteria, MeasurableResults (linked to Purpose)
5. Creates Technologies (linked to Project)
6. Creates Approach, Plan, Methods, Tools, Timeline, Milestones (linked to Project)
7. Creates Team, Roles, Responsibilities, Tasks, Deliverables, TeamMembers (linked to Project)

### Helper Functions (Cell 4)

All helper functions use Neo4j transactions (`tx.run()`) with `MERGE` statements to:
- Create nodes if they don't exist (based on unique identifiers)
- Create relationships between nodes
- Set properties on nodes

### Usage Example

```python
from project_extractor import get_project_content, extract_project
from baml_client.types import Project
from neo4j import GraphDatabase

# Load project from file
project_content = get_project_content('project_data/input/InstrumentOnDataMesh.txt')
project = extract_project(project_content)

# Create Neo4j driver
driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))

# Create graph
create_project_graph(project, driver)
```

## Notes

- All nodes use `MERGE` to avoid duplicates
- Relationships are created using `MERGE` to ensure idempotency
- Optional fields (like `metrics`, `measurableResults`, `timeline`, `milestones`) are only created if they exist in the Project object
- Node uniqueness is based on key properties (e.g., `{name}` for Project, `{description}` for Purpose)
