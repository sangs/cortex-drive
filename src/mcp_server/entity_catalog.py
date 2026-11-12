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

from domain_registry import (CONTENT_DOMAINS, ROUTING_NAME_LABELS, ROUTING_PERSON_LABELS, ROUTING_SOURCE_DOMAINS,
                             ROUTING_TOPIC_LABELS, TOPIC_ALIAS_GENERIC_SUFFIXES, TOPIC_ALIAS_MIN_CHARS,
                             get_exclusive_labels)
from schema_guard import (CONSUMPTION_RELATIONSHIPS, ENTITY_CATALOG_VERSION_KEY_PREFIX, SIMILARITY_RELATIONSHIPS,
                          SOURCE_SHORT_NAME_MIN_CHARS, SOURCE_SHORT_NAME_SEPARATORS)

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


def topic_aliases(name: str) -> list:
    """Extra names a topic answers to: both sides of a parenthesis, and the name without a trailing generic word."""
    import re as _re
    out = set()
    m = _re.fullmatch(r"\s*(.+?)\s*\((.+)\)\s*", name)
    parts = [m.group(1), m.group(2)] if m else [name]
    for p in parts:
        out.add(p.strip())
        words = p.strip().split()
        if len(words) > 1 and words[-1].lower() in TOPIC_ALIAS_GENERIC_SUFFIXES:
            out.add(" ".join(words[:-1]))
    return sorted(a for a in out if len(a) >= TOPIC_ALIAS_MIN_CHARS and a.lower() != name.lower())


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
            RETURN n.name AS name, labels(n) AS labels, n.node_id AS node_id, n.tenant_id AS tenant,
                   n.owner_id AS owner_id
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
            node_type = next((l for l in ROUTING_NAME_LABELS.get(domain, []) if l in r["labels"]), None)
            if node_type:
                entry["type"] = node_type   # e.g. Project vs Degree: picks the suggested-question template (§4.5)
            if r["owner_id"]:
                entry["owner_id"] = r["owner_id"]   # who added it: the owner's routing skips others' (2026-10-28)
            if domain in ROUTING_SOURCE_DOMAINS:
                sn = short_name(name)
                if sn:
                    entry["short_name"] = sn
            entries.append(entry)

        # Persons' work domains (cross-domain design 2026-11-09 §4.1, S2-78): the routing domains of the
        # titled nodes a person is directly linked to (roles, projects, talks → career; episodes → podcast),
        # not counting consumption (listening, subscribing) or similarity links.
        # Lets the gateway send "What has <person> written about X?" to the domain their work lives in —
        # career for the founder, not for a podcast guest. Same tiers as the entries; a routing hint only,
        # answers stay filtered per user.
        person_ids = [e["node_id"] for e in entries if e["domain"] == "person" and e["node_id"]]
        if person_ids:
            work_rows = session.run(
                """
                MATCH (p) WHERE p.node_id IN $ids
                MATCH (p)-[r]-(w) WHERE w.tenant_id IN $tiers AND any(l IN labels(w) WHERE l IN $labels)
                  AND NOT type(r) IN $not_work
                RETURN p.node_id AS id, collect(DISTINCT labels(w)) AS label_sets
                """,
                ids=person_ids, tiers=tiers, labels=sorted({l for ls in ROUTING_NAME_LABELS.values() for l in ls}),
                not_work=CONSUMPTION_RELATIONSHIPS + SIMILARITY_RELATIONSHIPS).data()
            work = {r["id"]: sorted({d for ls in r["label_sets"] if (d := _domain_for(set(ls))) and d != "person"})
                    for r in work_rows}
            for e in entries:
                if e["domain"] == "person":
                    e["work_domains"] = work.get(e["node_id"], [])

        # Topics (routing v2, design 2026-11-09 §4.1 rule 1): shared vocabulary names linked to real content
        # (a node with a content domain's exclusive label), with aliases. Visibility per entry like titles.
        content_labels = sorted({l for d in CONTENT_DOMAINS for l in get_exclusive_labels(d)})
        topic_rows = session.run(
            """
            MATCH (t) WHERE any(l IN labels(t) WHERE l IN $topic_labels) AND t.name IS NOT NULL
              AND t.tenant_id IN $tiers
              AND EXISTS { MATCH (t)-[r]-(c) WHERE NOT type(r) IN $sim AND c.tenant_id IN $tiers
                           AND (any(l IN labels(c) WHERE l IN $content_labels)
                                // podcast technologies hang off an episode's Topic (Episode-HAS_TOPIC-Topic-COVERS_TECHNOLOGY)
                                OR (c:Topic AND EXISTS { MATCH (c)-[r2]-(e) WHERE NOT type(r2) IN $sim
                                                          AND any(l IN labels(e) WHERE l IN $content_labels)
                                                          AND e.tenant_id IN $tiers })) }
            RETURN DISTINCT t.name AS name, t.node_id AS node_id, t.tenant_id AS tenant, t.owner_id AS owner_id
            """,
            topic_labels=ROUTING_TOPIC_LABELS, tiers=tiers, content_labels=content_labels,
            sim=SIMILARITY_RELATIONSHIPS).data()
        seen_topics = set()
        for r in topic_rows:
            name = (r["name"] or "").strip()
            if len(name) < TOPIC_ALIAS_MIN_CHARS or (name.lower(), r["node_id"]) in seen_topics:
                continue
            seen_topics.add((name.lower(), r["node_id"]))
            entry = {"name": name, "domain": "topic", "node_id": r["node_id"],
                     "tier": r["tenant"] if r["tenant"] in GLOBAL_TIERS else ORG_TIER}
            if r["owner_id"]:
                entry["owner_id"] = r["owner_id"]
            aliases = topic_aliases(name)
            if aliases:
                entry["aliases"] = aliases
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
