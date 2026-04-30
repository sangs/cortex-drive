/**
 * graphConstants.ts
 * Single source of truth for all graph domain constants, node-type sets, and
 * pure graph utility functions shared across dashboard/page.tsx, EnterpriseGraph.tsx,
 * and any future graph-rendering surface.
 *
 * Rules:
 *  - No React imports. No hooks. Pure functions and typed constants only.
 *  - All node-type string sets live here — never inline in component files.
 *  - All grouper configuration lives here.
 */

// ---------------------------------------------------------------------------
// Domain backbone sets
// ---------------------------------------------------------------------------

export const CAREER_BACKBONE = new Set([
    'Category', 'Company', 'Startup', 'Hackathon', 'ThoughtLeadership',
    'Institution', 'Degree', 'Certification', 'Publication', 'Role', 'Year', 'Person'
]);

export const PODCAST_BACKBONE = new Set([
    'Podcast', 'Episode', 'Year'
]);

// ---------------------------------------------------------------------------
// Node affordance type sets (visual + interaction behavior)
// ---------------------------------------------------------------------------

/** Node types that are never rendered on the canvas (noise / privacy). */
export const GRAPH_VISUAL_EXCLUDE = new Set([
    'Chunk', 'Source', 'ReferenceLink', 'PreparatoryNote', '__MetaContext__'
]);

/** Node types that carry no semantic content — show as leaves only. */
export const TAG_LEAF_TYPES = new Set([
    'Technology', 'Concept', 'Chunk', 'ReferenceLink', 'Source'
]);

/** Node types that are always double-click expandable regardless of link count. */
export const ALWAYS_EXPANDABLE = new Set([
    'Episode', 'Podcast', 'Category', 'Person',
    'Company', 'Startup', 'Hackathon', 'ThoughtLeadership'
]);

/** Node types treated as hubs — expandable when they have at least one link. */
export const HUB_TYPES = new Set([
    'Role', 'Topic', 'Institution', 'Degree', 'Project', 'Certification'
]);

/**
 * Node types hidden in the initial career backbone view.
 * Only Category nodes are shown at the top level; instances bloom on double-click.
 */
export const CATEGORY_CHILD_TYPES = new Set([
    'ThoughtLeadership', 'Degree', 'Certification', 'Hackathon',
    'Company', 'Startup', 'Role', 'Institution', 'Publication', 'Project'
]);

/**
 * Company-like node types — used when determining which nodes are company groupers
 * in multi-level career expansions.
 */
export const COMPANY_NODE_TYPES = new Set(['Company', 'Startup']);

/**
 * Work-item node types — projects and roles that attach to companies via AT links.
 */
export const WORK_ITEM_NODE_TYPES = new Set(['Project', 'Role']);

// ---------------------------------------------------------------------------
// Grouper configuration
// ---------------------------------------------------------------------------

/**
 * Human-readable plural label for each groupable node type.
 * Drives the "Companies (3)" grouper display names.
 */
export const GROUPER_LABELS: Record<string, string> = {
    Company:         'Companies',
    ThoughtLeadership: 'Thought Leadership',
    Hackathon:       'Hackathons',
    Institution:     'Institutions',
    Certification:   'Certifications',
    Publication:     'Publications',
    Startup:         'Startups',
    Degree:          'Education',
};

/** Minimum number of instances required before collapsing into a grouper node. */
export const GROUPER_MIN_COUNT = 2;

/** Set of types eligible for virtual grouper collapse. */
export const GROUPABLE_TYPES = new Set(Object.keys(GROUPER_LABELS));

/** Prefix used for synthetic grouper node ids (e.g. "group-Company"). */
export const GROUPER_ID_PREFIX = 'group-';

// ---------------------------------------------------------------------------
// Category hierarchy constants
// ---------------------------------------------------------------------------

/**
 * The "Professional Experience" Category uses a two-level bloom:
 *   Level 1 (first double-click): Company groupers appear.
 *   Level 2 (double-click a Company): Projects/Roles at that company bloom.
 * All other categories bloom their direct CONTAINS children in one step.
 */
export const PROFESSIONAL_EXPERIENCE_CATEGORY = 'Professional Experience';

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

export interface GraphNode {
    id: string;
    name?: string;
    type?: string;
    [key: string]: any;
}

export interface GraphLink {
    source: string;
    target: string;
    [key: string]: any;
}

/**
 * Deduplicates a node array by id, then by name.
 * ECharts graph series rejects arrays that contain duplicate id OR duplicate name.
 * Filters accompanying links to only those whose source and target survive deduplication.
 *
 * Generic so callers that pass `any[]` get `any[]` back — no unintended type narrowing.
 */
export function deduplicateNodes<N extends { id?: any; name?: any }, L extends { source?: any; target?: any }>(
    nodes: N[],
    links: L[]
): { nodes: N[]; links: L[] } {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const dedupedNodes = nodes.filter(n => {
        if (!n.id || seenIds.has(String(n.id))) return false;
        if (n.name && seenNames.has(String(n.name))) return false;
        seenIds.add(String(n.id));
        if (n.name) seenNames.add(String(n.name));
        return true;
    });
    const dedupedLinks = links.filter(l => seenIds.has(String(l.source)) && seenIds.has(String(l.target)));
    return { nodes: dedupedNodes, links: dedupedLinks };
}

/**
 * Collapses ≥ GROUPER_MIN_COUNT instances of the same groupable type into a single
 * representative grouper node. Rewires all links through the grouper.
 * Used on the initial backbone render so the graph starts at a clean summary level.
 */
export function collapseToGroupers(
    nodes: GraphNode[],
    links: GraphLink[]
): { nodes: GraphNode[]; links: GraphLink[] } {
    const byType = new Map<string, GraphNode[]>();
    const ungrouped: GraphNode[] = [];
    nodes.forEach(n => {
        if (GROUPABLE_TYPES.has(n.type ?? '')) {
            if (!byType.has(n.type!)) byType.set(n.type!, []);
            byType.get(n.type!)!.push(n);
        } else {
            ungrouped.push(n);
        }
    });

    const outNodes: GraphNode[] = [...ungrouped];
    const idRemap = new Map<string, string>();
    byType.forEach((instances, type) => {
        if (instances.length < GROUPER_MIN_COUNT) {
            outNodes.push(...instances);
        } else {
            const grouperId = `${GROUPER_ID_PREFIX}${type}`;
            outNodes.push({
                id: grouperId,
                name: `${GROUPER_LABELS[type]} (${instances.length})`,
                type,
                isGrouper: true,
                groupCount: instances.length,
                children: instances,
                isExpandable: true,
                isBentoEligible: false,
                val: 18,
            });
            instances.forEach(n => idRemap.set(n.id, grouperId));
        }
    });

    const seenLinks = new Set<string>();
    const outLinks: GraphLink[] = [];
    links.forEach(l => {
        const src = idRemap.get(l.source) || l.source;
        const tgt = idRemap.get(l.target) || l.target;
        if (src === tgt) return;
        const key = `${src}→${tgt}`;
        if (!seenLinks.has(key)) {
            seenLinks.add(key);
            outLinks.push({ ...l, source: src, target: tgt });
        }
    });

    return { nodes: outNodes, links: outLinks };
}

/**
 * From a depth-2 get_cluster_context expansion result for "Professional Experience",
 * extracts Company/Startup nodes enriched with their child Projects/Roles.
 *
 * The Professional Experience Category has a two-level structure:
 *   Category → [Company] → [Project/Role]
 * Depth-2 traversal returns all three levels. This function collapses them so the
 * first bloom only shows Companies, with Projects stored as their `children` for
 * the second-level bloom.
 *
 * Returns deduplicated Company nodes (isGrouper=true) ready to be merged into graphData.
 */
export function buildCompanyGroupers(
    allNodes: GraphNode[],
    allLinks: GraphLink[]
): GraphNode[] {
    // Deduplicate companies by id — depth-2 traversal can surface the same node
    // via multiple paths (CONTAINS→Project→AT and CONTAINS→Role→AT).
    const seenIds = new Set<string>();
    const companyNodes = allNodes.filter(n => {
        if (!COMPANY_NODE_TYPES.has(n.type ?? '') || !n.id) return false;
        if (seenIds.has(n.id)) return false;
        seenIds.add(n.id);
        return true;
    });

    const workNodeIds = new Set(
        allNodes.filter(n => WORK_ITEM_NODE_TYPES.has(n.type ?? '')).map(n => n.id)
    );

    // Map company id → deduplicated child work items via AT links
    const companyChildren = new Map<string, GraphNode[]>();
    companyNodes.forEach(c => companyChildren.set(c.id, []));

    allLinks.forEach(l => {
        const srcNode = allNodes.find(n => n.id === l.source);
        const tgtNode = allNodes.find(n => n.id === l.target);
        if (!srcNode || !tgtNode) return;

        const isWorkSrc = workNodeIds.has(srcNode.id);
        const isCmpSrc  = seenIds.has(srcNode.id);
        const isWorkTgt = workNodeIds.has(tgtNode.id);
        const isCmpTgt  = seenIds.has(tgtNode.id);

        if (isWorkSrc && isCmpTgt) {
            const children = companyChildren.get(tgtNode.id);
            if (children && !children.some(x => x.id === srcNode.id)) children.push(srcNode);
        } else if (isWorkTgt && isCmpSrc) {
            const children = companyChildren.get(srcNode.id);
            if (children && !children.some(x => x.id === tgtNode.id)) children.push(tgtNode);
        }
    });

    return companyNodes.map(c => ({
        ...c,
        isGrouper: true,
        isExpandable: true,
        isBentoEligible: false,
        children: companyChildren.get(c.id) ?? [],
    }));
}

/**
 * Infers the correct backbone set from raw graph response content.
 * Used as a fallback when domain_signal is absent or "unknown".
 */
export function inferBackbone(raw: any): Set<string> {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const nodes = parsed.nodes || (Array.isArray(parsed) ? parsed : [parsed]);
        const types = new Set<string>(nodes.map((n: any) => n.type || '').filter(Boolean));
        if (types.has('Company') || types.has('Role') || types.has('Institution')) return CAREER_BACKBONE;
        if (types.has('Episode') || types.has('Topic')) return PODCAST_BACKBONE;
    } catch { /* ignore parse errors — fall through to default */ }
    return new Set([...CAREER_BACKBONE, ...PODCAST_BACKBONE]);
}

/**
 * Selects backbone set and backboneOnly flag from gateway-declared domain_signal.
 * cross_domain passes all node types through (bridge nodes span both domains).
 */
export function domainToBackbone(
    signal: string | undefined,
    _rawData: any
): { backbone: Set<string>; backboneOnly: boolean } {
    if (signal === 'podcast')      return { backbone: PODCAST_BACKBONE, backboneOnly: true };
    if (signal === 'career')       return { backbone: CAREER_BACKBONE,  backboneOnly: true };
    if (signal === 'cross_domain') return { backbone: new Set([...CAREER_BACKBONE, ...PODCAST_BACKBONE]), backboneOnly: false };
    return { backbone: new Set([...CAREER_BACKBONE, ...PODCAST_BACKBONE]), backboneOnly: false };
}
