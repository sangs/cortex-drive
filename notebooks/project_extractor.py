"""
project_extractor.py

This script accepts project content as user input and extracts structured
project information using the `ExtractProject` method defined in `project.baml`.

The script:
1. Receives raw project content from the user.
2. Passes the content to `ExtractProject` to produce a `Project` response object.
3. Writes the extracted project details to an output file named after the
   project name contained in the input.

The output file serves as a serialized representation of the structured
Project object for downstream processing or review.
"""

import sys
import json
import re
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

from baml_client import b
from baml_client.types import Project

# Load environment variables from .env file
load_dotenv('.env', override=True)


def sanitize_filename(name: str) -> str:
    """Convert project name to a safe filename."""
    # Remove or replace invalid filename characters
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Remove leading/trailing whitespace and dots
    name = name.strip('. ')
    # Replace multiple spaces/underscores with single underscore
    name = re.sub(r'[\s_]+', '_', name)
    # Limit length
    if len(name) > 100:
        name = name[:100]
    return name or "project"


def format_project_output(project: Project) -> str:
    """Format the Project object as a readable string."""
    output_lines = []
    
    output_lines.append("=" * 80)
    output_lines.append(f"PROJECT: {project.name}")
    output_lines.append("=" * 80)
    output_lines.append(f"\nDescription: {project.description}\n")
    
    # Why: Purpose & Value
    output_lines.append("-" * 80)
    output_lines.append("WHY: Purpose & Value")
    output_lines.append("-" * 80)
    output_lines.append(f"\nPurpose:")
    output_lines.append(f"  {project.purpose.description}")
    output_lines.append(f"\nObjectives:")
    for obj in project.purpose.objectives:
        output_lines.append(f"  • {obj}")
    
    output_lines.append(f"\nValue:")
    output_lines.append(f"  {project.value.description}")
    output_lines.append(f"\nBenefits:")
    for benefit in project.value.benefits:
        output_lines.append(f"  • {benefit}")
    if project.value.metrics:
        output_lines.append(f"\nMetrics:")
        for metric in project.value.metrics:
            output_lines.append(f"  • {metric}")
    
    # Outcomes
    if project.outcomes:
        output_lines.append(f"\nOutcomes:")
        for outcome in project.outcomes:
            output_lines.append(f"\n  {outcome.description}")
            output_lines.append(f"  Success Criteria:")
            for criterion in outcome.successCriteria:
                output_lines.append(f"    • {criterion}")
            if outcome.measurableResults:
                output_lines.append(f"  Measurable Results:")
                for result in outcome.measurableResults:
                    output_lines.append(f"    • {result}")
    
    # Technologies
    if project.technologies:
        output_lines.append(f"\nTechnologies:")
        for tech in project.technologies:
            output_lines.append(f"  • {tech.name}: {tech.description}")
    
    # How: Approach & Plan
    output_lines.append("\n" + "-" * 80)
    output_lines.append("HOW: Approach & Plan")
    output_lines.append("-" * 80)
    output_lines.append(f"\nApproach:")
    output_lines.append(f"  {project.approach.description}")
    if project.approach.methodology:
        output_lines.append(f"\nMethodology: {project.approach.methodology}")
    
    plan = project.approach.plan
    output_lines.append(f"\nPlan: {plan.name}")
    output_lines.append(f"  {plan.description}")
    
    if plan.methods:
        output_lines.append(f"\n  Methods:")
        for method in plan.methods:
            output_lines.append(f"    • {method.name}: {method.description}")
            if method.steps:
                for step in method.steps:
                    output_lines.append(f"      - {step}")
    
    if plan.tools:
        output_lines.append(f"\n  Tools:")
        for tool in plan.tools:
            category = f" ({tool.category})" if tool.category else ""
            output_lines.append(f"    • {tool.name}: {tool.description}{category}")
    
    if plan.timeline:
        output_lines.append(f"\n  Timeline: {plan.timeline}")
    
    if plan.milestones:
        output_lines.append(f"\n  Milestones:")
        for milestone in plan.milestones:
            output_lines.append(f"    • {milestone}")
    
    # Who: Team & Responsibilities
    output_lines.append("\n" + "-" * 80)
    output_lines.append("WHO: Team & Responsibilities")
    output_lines.append("-" * 80)
    team = project.team
    output_lines.append(f"\nTeam: {team.name}")
    if team.description:
        output_lines.append(f"  {team.description}")
    
    if team.roles:
        output_lines.append(f"\nRoles:")
        for role in team.roles:
            output_lines.append(f"\n  {role.name}")
            output_lines.append(f"    {role.description}")
            if role.responsibilities:
                output_lines.append(f"    Responsibilities:")
                for resp in role.responsibilities:
                    output_lines.append(f"      {resp.description}")
                    if resp.tasks:
                        output_lines.append(f"        Tasks:")
                        for task in resp.tasks:
                            output_lines.append(f"          • {task}")
                    if resp.deliverables:
                        output_lines.append(f"        Deliverables:")
                        for deliverable in resp.deliverables:
                            output_lines.append(f"          • {deliverable}")
    
    if team.members:
        output_lines.append(f"\nMembers:")
        for member in team.members:
            output_lines.append(f"  • {member}")
    
    output_lines.append("\n" + "=" * 80)
    
    return "\n".join(output_lines)


def extract_project(project_content: str) -> Project:
    """Extract structured project information from raw content."""
    print("Extracting project information...")
    try:
        project = b.ExtractProject(project_content)
        print("✓ Project extraction completed successfully")
        return project
    except Exception as e:
        print(f"✗ Error extracting project: {e}", file=sys.stderr)
        raise


def write_project_to_file(project: Project, output_dir: Optional[Path] = None) -> Path:
    """Write the Project object to a JSON file named after the project."""
    # Use project_data/output directory as default, or use provided output_dir
    base_dir = output_dir or Path.cwd() / "project_data" / "output"
    
    # Create the directory if it doesn't exist
    base_dir.mkdir(parents=True, exist_ok=True)
    
    # Sanitize project name for filename
    filename = sanitize_filename(project.name)
    json_path = base_dir / f"{filename}.json"
    
    # Write the Project object as JSON content
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(project.model_dump(), f, indent=2, ensure_ascii=False)
    
    print(f"✓ Project written to: {json_path}")
    
    return json_path


def get_project_content(filename: str) -> str:
    """Get project content from a given file."""
    file_path = Path(filename)
    if not file_path.exists():
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)
    with open(file_path, 'r', encoding='utf-8') as f:
        return f.read()


def main():
    """Main entry point for the script."""
    try:
        # Check if filename is provided as command line argument
        if len(sys.argv) < 2:
            print("Error: Please provide a filename as an argument", file=sys.stderr)
            print("Usage: python project_extractor.py <filename>", file=sys.stderr)
            sys.exit(1)
        
        # Get project content from file
        filename = sys.argv[1]
        project_content = get_project_content(filename)
        
        if not project_content.strip():
            print("Error: File is empty", file=sys.stderr)
            sys.exit(1)
        
        # Extract project information
        project = extract_project(project_content)
        
        # Write to file
        output_path = write_project_to_file(project)
        
        print(f"\n✓ Successfully extracted project: {project.name}")
        print(f"  Output file: {output_path}")
        
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
