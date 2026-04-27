"""
Prompts and instruction strings for the Neo4j Podcast Episode Graph project.
"""

# Mental Model AI Assistant instruction
import os

# Externalized prompt directory
_prompts_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "prompts")
_mental_model_path = os.path.join(_prompts_dir, "mcp_mental_model.md")

with open(_mental_model_path, "r", encoding="utf-8") as _f:
    MENTAL_MODEL_AI_INSTRUCTION = _f.read()

# Add other prompts here as needed
# Example:
# PERSON_EXTRACTION_PROMPT = """
# Extract person information from resume text...
# """

# EPISODE_ANALYSIS_PROMPT = """
# Analyze podcast episode content...
# """
