"""
CortexDrive Domain Sovereignty Registry (Positive Schema)

Defines the authorized labels allowed in each discovery domain. 
This refactor imports constants from schema_guard.py to ensure a Single Source of Truth.
"""

from schema_guard import CORTEX_DRIVE_NODES, PROJECT_GRAPH_NODES

DOMAIN_REGISTRY = {
    # Professional Domain: Inherits from Project Graph Logic
    "professional": PROJECT_GRAPH_NODES,
    
    # Podcast Domain: Inherits from Cortex Drive Media Logic
    "podcast": CORTEX_DRIVE_NODES,
    
    # Universal Domain: No restrictions
    "all": None
}

def get_authorized_labels(domain: str) -> list:
    """Return the list of labels authorized for the given domain context."""
    return DOMAIN_REGISTRY.get(domain.lower(), DOMAIN_REGISTRY["all"])
