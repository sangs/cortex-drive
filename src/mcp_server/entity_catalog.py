"""
Entity catalog for gateway routing (classifier Phase E) — the one builder (S2-60).

Used by:
  - Bento POST /entity_catalog: the gateway fetches a tenant's catalog when its version counter changes;
  - scripts/generate_entity_catalog.py: the static file baked into the gateway image (cold-start fallback).

Each entry carries its node id and tier so the gateway can drop titles the asker can't open (design §8:
routing obeys the same visibility as answers). Writers never write names here: they only bump the
per-tenant counter (bump_version) after adding or removing a source, and Neo4j stays the source of truth.

Design: documents/architecture/entity-catalog-freshness-design-2026-10-27.md
"""
import re
from datetime import datetime, timezone

from domain_registry import ROUTING_NAME_LABELS, ROUTING_PERSON_LABELS, ROUTING_SOURCE_DOMAINS
from schema_guard import (ENTITY_CATALOG_VERSION_KEY_PREFIX, SOURCE_SHORT_NAME_MIN_CHARS,
                          SOURCE_SHORT_NAME_SEPARATORS)

GLOBAL_TIERS = ["SYSTEM", "PUBLIC"]
ORG_TIER = "org"

# Relationship types connecting a Concept/Technology bridge candidate back to each domain's anchors
# (website<->podcast bridge entities, design 2026-08-24 §2.2). Bounded *1..2: the podcast hop shape
# depends on LLM extraction.
BRIDGE_REL_TYPES_WEBSITE = ["COVERS_TECHNOLOGY", "DISCUSSES"]
BRIDGE_REL_TYPES_PODCAST = ["COVERS_TECHNOLOGY", "COVERS_CONCEPT", "HAS_TOPIC"]
BRIDGE_DOMAINS = ["website", "podcast"]

_SHORT_NAME_SPLIT = re.compile("|".join(re.escape(s) for s in SOURCE_SHORT_NAME_SEPARATORS))


def version_key(tenant_id: str) -> str:
    return f"{ENTITY_CATALOG_VERSION_KEY_PREFIX}:{tenant_id}"


def bump_version(redis_client, tenant_id: str) -> None:
    """Tell gateways this tenant's catalog changed. Never raises: a missed bump only delays routing by a
    title until the next bump or the gateway's daily refresh."""
    try:
        redis_client.incr(version_key(tenant_id))
    except Exception as e:  # noqa: BLE001
        print(f"[CATALOG] version bump failed for {tenant_id}: {type(e).__name__}: {e}")


def short_name(title: str):
    """'BERT: Pre-training of …' → 'BERT'. None when the title has no separator or the prefix is too short."""
    head = _SHORT_NAME_SPLIT.split(title or "", maxsplit=1)
    if len(head) < 2:
        return None
    s = head[0].strip()
    return s if len(s) >= SOURCE_SHORT_NAME_MIN_CHARS else None


def _domain_for(labels: set):
    for domain, domain_labels in ROUTING_NAME_LABELS.items():
        if labels & set(domain_labels):
            return domain
    if labels & set(ROUTING_PERSON_LABELS):
        return "person"
    return None


def build_entity_catalog(driver, tenant_id: str) -> dict:
    """The routing catalog for one tenant (+ SYSTEM/PUBLIC). Read-only."""
    tiers = [tenant_id, *GLOBAL_TIERS]
    label_list = sorted({l for ls in ROUTING_NAME_LABELS.values() for l in ls} | set(ROUTING_PERSON_LABELS))
    entries, seen = [], set()
    with driver.session() as session:
        rows = session.run(
            """
            MATCH (n)
            WHERE n.name IS NOT NULL AND n.tenant_id IN $tiers
              AND any(l IN labels(n) WHERE l IN $labels)
            RETURN n.name AS name, labels(n) AS labels, n.node_id AS node_id, n.tenant_id AS tenant
            """,
            tiers=tiers, labels=label_list).data()
        for r in rows:
            name = (r["name"] or "").strip()
            domain = _domain_for(set(r["labels"]))
            if not name or not domain:
                continue
            tier = r["tenant"] if r["tenant"] in GLOBAL_TIERS else ORG_TIER
            key = (name, domain, r["node_id"])
            if key in seen:
                continue
            seen.add(key)
            entry = {"name": name, "domain": domain, "node_id": r["node_id"], "tier": tier}
            if domain in ROUTING_SOURCE_DOMAINS:
                sn = short_name(name)
                if sn:
                    entry["short_name"] = sn
            entries.append(entry)

        # Bridge entities: Concept/Technology names connected to both website and podcast data. Matched
        # by name across the two MATCHes (the same concept can exist as a SYSTEM and an org node).
        website_rels = "|".join(BRIDGE_REL_TYPES_WEBSITE)
        podcast_rels = "|".join(BRIDGE_REL_TYPES_PODCAST)
        bridge_rows = session.run(
            f"""
            MATCH (website_bridge) WHERE (website_bridge:Technology OR website_bridge:Concept)
              AND website_bridge.tenant_id IN $tiers
            MATCH (website_bridge)-[:{website_rels}*1..2]-(:WebsiteSource)
            WITH DISTINCT website_bridge.name AS candidate_name
            MATCH (podcast_bridge) WHERE (podcast_bridge:Technology OR podcast_bridge:Concept)
              AND podcast_bridge.name = candidate_name
              AND podcast_bridge.tenant_id IN $tiers
            MATCH (podcast_bridge)-[:{podcast_rels}*1..2]-(podcast_anchor)
            WHERE podcast_anchor:Episode OR podcast_anchor:Topic OR podcast_anchor:Podcast
            RETURN DISTINCT candidate_name AS entity_name
            """,
            tiers=tiers).data()
    bridge_entities = {}
    for r in bridge_rows:
        name = (r["entity_name"] or "").strip()
        if name:
            bridge_entities[name.lower()] = list(BRIDGE_DOMAINS)

    # `domains` / `persons` keep the pre-S2-60 shape so an older gateway can read a newer file.
    domains = {d: sorted({e["name"] for e in entries if e["domain"] == d}) for d in ROUTING_NAME_LABELS}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tenant_id": tenant_id,
        "node_count": sum(len(v) for v in domains.values()),
        "domains": domains,
        "persons": sorted({e["name"] for e in entries if e["domain"] == "person"}),
        "bridge_entities": bridge_entities,
        "entries": sorted(entries, key=lambda e: (e["domain"], e["name"])),
    }
