/**
 * GraphTheme.ts
 * Central source of truth for Universal Graph Visuals.
 * Maps node types (labels) to an HSL color (used directly by both the ECharts canvas and the
 * legend panel) and a node radius (canvas size hint).
 *
 * Regenerated 2026-09-16 — the prior version hand-authored `hsl` and a separate `tailwind`
 * class string per type, two independently-maintained representations of the same color with
 * nothing enforcing they stayed in sync — which is why Category and Episode had drifted into an
 * exact duplicate (`hsl(210, 80%, 45%)` / `bg-blue-600`, both). Every type's color is now
 * generated from a single hue value.
 *
 * `tailwind` was dropped entirely during this same change, not just merged into `hsl` — an
 * initial version derived a Tailwind arbitrary-value class (`bg-[hsl(...)]`) from `hsl` so both
 * fields stayed in sync, but a build check found the compiled CSS contained none of those
 * classes: Tailwind's content scanner only detects class names that appear as literal text in
 * source files, and a class built via runtime template-literal interpolation never does. Using
 * an arbitrary-value Tailwind class for a per-type *generated* color was structurally the wrong
 * tool regardless of how it's generated. The one consumer (the legend swatch,
 * `dashboard/page.tsx`) now applies `hsl` via inline `style`, which has no such discovery
 * requirement — see documents/architecture/graph-legend-node-color-redesign-2026-09-16.md for
 * the full record, including this correction.
 *
 * Domain-bucketed hue assignment added 2026-09-16 — see NODE_TYPE_DOMAINS below.
 */

export interface ThemeToken {
    hsl: string;
    radius: number;
}

// Fixed saturation/lightness for every type — uniform visual weight, so no type implicitly
// reads as more "important" via brightness than another.
const HUE_SATURATION = 65;
const HUE_LIGHTNESS = 50;

/**
 * Node types grouped by co-occurrence domain — types that routinely render together in the same
 * view. THIS IS THE ONLY THING A DEVELOPER EDITS when adding a node type: add it to the array
 * for the domain it belongs to, or add a new domain key for a wholly new source type (e.g.
 * `video`, `audio`, `notes` as those land). Never hand-order or hand-assign hues directly — hue
 * is computed automatically from this structure by fairInterleave() below, so a same-domain
 * cluster (which is what makes adjacent types hard to tell apart on canvas) can't silently
 * reappear just because new types were appended in source order.
 *
 * `radius` is a node-size hint, unrelated to color — grouped here only because it lives on the
 * same per-type record.
 */
const NODE_TYPE_DOMAINS: Record<string, { type: string; radius: number }[]> = {
    professional: [
        { type: 'Category', radius: 12 },
        { type: 'Project', radius: 8 },
        { type: 'Role', radius: 7 },
        { type: 'Outcome', radius: 5 },
        { type: 'Achievement', radius: 5 },
        { type: 'Company', radius: 12 },
        { type: 'Startup', radius: 12 },
        { type: 'Hackathon', radius: 10 },
        { type: 'ThoughtLeadership', radius: 11 },
        { type: 'Certification', radius: 9 },
        { type: 'Degree', radius: 8 },
        { type: 'Institution', radius: 11 },
        { type: 'Education', radius: 9 },
        { type: 'SocialLearning', radius: 8 },
        { type: 'Publication', radius: 9 },
    ],
    podcast: [
        { type: 'Podcast', radius: 14 },
        { type: 'Episode', radius: 10 },
        { type: 'Topic', radius: 8 },
        { type: 'Person', radius: 7 },
        { type: 'Chunk', radius: 4 },
        { type: 'Technology', radius: 8 },
    ],
    website: [
        { type: 'WebsiteSource', radius: 12 },
    ],
    misc: [
        { type: 'Location', radius: 5 },
        { type: 'Year', radius: 12 },
    ],
};

/**
 * Flattens domain-bucketed types into a single ordering, spreading each domain's own types as
 * evenly as possible across their fair share of the hue wheel. At each step, picks the next type
 * from whichever domain has consumed the smallest FRACTION of its own total so far (not raw
 * count) — this is what keeps a large domain (e.g. `professional`) from exhausting the small
 * domains early and dominating the tail, which a naive round-robin (by raw count) does.
 * Deterministic: same input produces the same output every time, given a fixed key order.
 */
function fairInterleave<T>(domains: Record<string, T[]>): T[] {
    const keys = Object.keys(domains);
    const consumed: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    const total = keys.reduce((sum, k) => sum + domains[k].length, 0);
    const result: T[] = [];
    for (let step = 0; step < total; step++) {
        let bestKey: string | null = null;
        let bestRatio = Infinity;
        for (const k of keys) {
            if (consumed[k] >= domains[k].length) continue;
            const ratio = consumed[k] / domains[k].length;
            if (ratio < bestRatio) {
                bestRatio = ratio;
                bestKey = k;
            }
        }
        result.push(domains[bestKey!][consumed[bestKey!]]);
        consumed[bestKey!]++;
    }
    return result;
}

// Hue is assigned by uniform division around the full color wheel (`hue_i = i * 360 / n`) over
// the fair-interleaved ordering — not golden-angle stepping, which was tried first but produced
// a 7.7° minimum gap between two types for this repo's type count (barely distinguishable);
// uniform division guarantees a 15° minimum gap between every pair for a fixed, known count.
const INTERLEAVED_NODE_TYPES = fairInterleave(NODE_TYPE_DOMAINS);

export const GRAPH_THEME: Record<string, ThemeToken> = Object.fromEntries(
    INTERLEAVED_NODE_TYPES.map(({ type, radius }, i) => {
        const hue = (i * 360) / INTERLEAVED_NODE_TYPES.length;
        return [type, { hsl: `hsl(${hue},${HUE_SATURATION}%,${HUE_LIGHTNESS}%)`, radius }];
    })
);

export const DEFAULT_THEME: ThemeToken = {
    hsl: 'hsl(210, 20%, 65%)',          // Medium Slate
    radius: 6
};

/**
 * Utility to get theme for any node type
 */
export const getThemeForType = (type: string): ThemeToken => {
    return GRAPH_THEME[type] || DEFAULT_THEME;
};
