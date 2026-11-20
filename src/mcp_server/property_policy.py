"""Which raw node properties a caller may see (S2-98, 2026-11-20).

Design: documents/security/node-property-exposure-design-2026-11-20.md. Lists: schema_guard
(NEVER_RETURNED_PROPERTY_SUFFIXES, SHARED_VIEW_PROPERTY_ALLOWLIST).

Node-level access (may this caller open the node at all?) stays with the security clause and Permify. This module
decides the next question: of an openable node's properties, which ones go back. Before S2-98, get_node_details
returned properties(n) whole, so a share-link viewer got the founder's email, LinkedIn URL, Clerk user id and
embedding vector from the PUBLIC Person node.
"""
from schema_guard import NEVER_RETURNED_PROPERTY_SUFFIXES, SHARED_VIEW_PROPERTY_ALLOWLIST


def visible_properties(props, full_access: bool) -> dict:
    """The properties to return.

    full_access: True for the tenant owner and internal calls (ExpertTools._has_tenant_visibility()); they get
    everything except vectors. Everyone else (guest links, members, collaborators) gets only the allowlist.
    """
    if not isinstance(props, dict):
        return {}
    if full_access:
        return {k: v for k, v in props.items() if not k.endswith(NEVER_RETURNED_PROPERTY_SUFFIXES)}
    return {k: v for k, v in props.items() if k in SHARED_VIEW_PROPERTY_ALLOWLIST}
