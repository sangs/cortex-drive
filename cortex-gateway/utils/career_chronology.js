'use strict';
/**
 * Career map: newest first, with work shown where it was done (S2-94). Design:
 * documents/architecture/career-map-chronology-design-2026-11-19.md §3.3.
 *
 * One module, two readers: the Option A writer path and buildCareerMapResponse (Option B / LLM summary) in index.js.
 * Input: the career nodes MCP returns (search_enterprise_graph or get_cluster_context). Each carries `labels`,
 * `career_spans` (raw dates from the Person → item relationship, e.g. {start: "06/2021", end: "Present"}) and
 * `employer` (the Company it was done at). Older fields (displayDate, startYear, endYear, isPresent) are a fallback.
 *
 * Before 2026-11-19 the order came from `temporal_boost`, which these nodes don't carry (all 0), so the answer kept
 * whatever order Neo4j returned. Order now comes only from dates: current work first, then latest end, then latest
 * start, then name. Sections and labels come from config/career_sections.json.
 */
const CONFIG = require('../config/career_sections.json');

const PRESENT = CONFIG.present_label;
const CURRENT_YM = '9999-12';

/** "06/2021" | "6/2021" | "2021" | "2021-06[-..]" | "Present" → { ym: "YYYY-MM", current } or null. */
function parseYm(value) {
    if (value === null || value === undefined) return null;
    const v = String(value).trim();
    if (!v) return null;
    if (v.toLowerCase() === PRESENT.toLowerCase()) return { ym: CURRENT_YM, current: true };
    let m = v.match(/^(\d{1,2})\/(\d{4})$/);
    if (m) return { ym: `${m[2]}-${m[1].padStart(2, '0')}`, current: false };
    m = v.match(/^(\d{4})-(\d{2})/);
    if (m) return { ym: `${m[1]}-${m[2]}`, current: false };
    m = v.match(/^(\d{4})$/);
    if (m) return { ym: `${m[1]}-00`, current: false };
    return null;
}

const minYm = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const maxYm = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

/** A node's span: { start, end, current, roles } with start/end as "YYYY-MM" (end = CURRENT_YM when current). */
function nodeSpan(n) {
    let start = null, end = null, current = false;
    const roles = [];
    for (const s of Array.isArray(n.career_spans) ? n.career_spans : []) {
        if (!s) continue;
        const a = parseYm(s.start) || parseYm(s.date);
        const b = parseYm(s.end) || parseYm(s.date) || a;
        if (a) start = minYm(start, a.ym);
        if (b) { end = maxYm(end, b.ym); current = current || b.current; }
        if (s.role && !roles.includes(s.role)) roles.push(s.role);
    }
    if (!start && !end) {   // older fields
        const disp = typeof n.displayDate === 'string' ? n.displayDate.split(/\s*[-–]\s*(?=\d|Present)/i) : [];
        const a = parseYm(disp[0]) || parseYm(n.startYear) || parseYm(n.year);
        const b = parseYm(disp[1]) || parseYm(n.endYear) || a;
        if (a) start = a.ym;
        if (b) { end = b.ym; current = b.current; }
        if (n.isPresent === true || n.isPresent === 'true') { current = true; end = CURRENT_YM; }
        if (n.role && !roles.includes(n.role)) roles.push(n.role);
    }
    if (current) end = CURRENT_YM;
    return { start, end, current, roles };
}

/** Current first, then latest end, then latest start, then name. Undated items last. */
function compareNewestFirst(a, b) {
    const sa = a.span || nodeSpan(a), sb = b.span || nodeSpan(b);
    if (sa.current !== sb.current) return sa.current ? -1 : 1;
    if ((sa.end || '') !== (sb.end || '')) return (sb.end || '').localeCompare(sa.end || '');
    if ((sa.start || '') !== (sb.start || '')) return (sb.start || '').localeCompare(sa.start || '');
    return String(a.name || '').localeCompare(String(b.name || ''));
}

/** "2021–2025", "2025–Present", "2025", or "". */
function formatSpan(span) {
    if (!span) return '';
    const sy = span.start ? span.start.slice(0, 4) : '';
    if (span.current) return sy ? `${sy}–${PRESENT}` : PRESENT;
    const ey = span.end ? span.end.slice(0, 4) : '';
    if (sy && ey && sy !== ey) return `${sy}–${ey}`;
    return ey || sy;
}

function labelsOf(n) {
    return Array.isArray(n.labels) && n.labels.length ? n.labels : (n.type ? [n.type] : []);
}

/** Section key for a node (first section whose labels it carries), 'employer', or null. */
function sectionOf(n) {
    const labels = labelsOf(n);
    for (const s of CONFIG.sections) if (s.labels.some(l => labels.includes(l))) return s.key;
    if (labels.includes(CONFIG.employer_label)) return 'employer';
    return null;
}

/** One entry per career item: the same node can arrive several times (one row per relationship, or from two tools). */
function mergeNodes(nodes) {
    const byKey = new Map();
    for (const n of nodes || []) {
        if (!n || !n.name) continue;
        const key = n.node_id || n.name;
        const prev = byKey.get(key);
        if (!prev) { byKey.set(key, { ...n, career_spans: [...(n.career_spans || [])], labels: [...labelsOf(n)] }); continue; }
        prev.career_spans.push(...(n.career_spans || []));
        prev.labels = [...new Set([...prev.labels, ...labelsOf(n)])];
        prev.employer = prev.employer || n.employer || null;
        if (!prev.description && n.description) prev.description = n.description;
        if (!prev.text && n.text) prev.text = n.text;
        if (Array.isArray(n.links)) prev.links = [...new Set([...(prev.links || []), ...n.links])];
        for (const f of ['displayDate', 'startYear', 'endYear', 'year', 'role', 'url']) if (!prev[f] && n[f]) prev[f] = n[f];
        if (n.isPresent === true || n.isPresent === 'true') prev.isPresent = true;
    }
    return [...byKey.values()].map(n => ({ ...n, span: nodeSpan(n) }));
}

/**
 * The career map model:
 *   employers: [{ name, span, roles, items }] newest first, each employer's items newest first;
 *   sections:  { projects, thoughtLeadership, hackathons, education } each newest first;
 *   current:   current projects (writer targets).
 * An item appears under its employer AND in its own section.
 */
function buildCareerModel(rawNodes) {
    const nodes = mergeNodes(rawNodes);
    const sections = Object.fromEntries(CONFIG.sections.map(s => [s.key, []]));
    const employerNodes = new Map();
    for (const n of nodes) {
        const key = sectionOf(n);
        if (key === 'employer') employerNodes.set(n.name, n);
        else if (key) sections[key].push(n);
    }
    for (const key of Object.keys(sections)) sections[key].sort(compareNewestFirst);

    const employers = new Map();
    const employerEntry = name => {
        if (!employers.has(name)) {
            const node = employerNodes.get(name);
            employers.set(name, { name, node: node || null, roles: node ? node.span.roles : [], items: [], ownSpan: node ? node.span : null });
        }
        return employers.get(name);
    };
    for (const name of employerNodes.keys()) employerEntry(name);
    for (const key of CONFIG.nest_under_employer) {
        for (const item of sections[key]) if (item.employer) employerEntry(item.employer).items.push(item);
    }
    const list = [...employers.values()].map(e => {
        e.items.sort(compareNewestFirst);
        // An employer's span: its own roles; without roles (e.g. Independent Ventures), the span of its items.
        let span = e.ownSpan && (e.ownSpan.start || e.ownSpan.end) ? e.ownSpan : null;
        if (!span && e.items.length) {
            span = { start: null, end: null, current: false, roles: [] };
            for (const it of e.items) {
                span.start = minYm(span.start, it.span.start);
                span.end = maxYm(span.end, it.span.end);
                span.current = span.current || it.span.current;
            }
        }
        return { name: e.name, span: span || { start: null, end: null, current: false, roles: [] }, roles: e.roles, items: e.items };
    });
    list.sort((a, b) => compareNewestFirst({ name: a.name, span: a.span }, { name: b.name, span: b.span }));

    return { employers: list, sections, current: (sections.projects || []).filter(n => n.span.current) };
}

const isUrl = l => typeof l === 'string' && (l.startsWith('http://') || l.startsWith('https://'));
function itemLinks(n) {
    const all = Array.isArray(n.links) && n.links.length ? n.links : (n.url ? [n.url] : []);
    return [...new Set(all.filter(isUrl))];
}

/**
 * Markdown career map. `proseFor(item)` may return writer prose for an item (Option A); otherwise the item's
 * description is used. `sanitize` cleans narrative text.
 */
function renderCareerMap(model, { proseFor = () => null } = {}) {
    const lines = [`## ${CONFIG.map_heading}`];
    const tag = n => (n.employer ? ` · @ ${n.employer}` : '');
    const when = span => { const s = formatSpan(span); return s ? ` [${s}]` : ''; };

    if (model.employers.length) {
        lines.push('', '---', '', `### ${CONFIG.timeline_heading}`);
        for (const e of model.employers) {
            const roles = e.roles.length ? ` · ${e.roles.join('; ')}` : '';
            lines.push(`#### ${e.name}${roles}${when(e.span)}`);
            for (const it of e.items) lines.push(`- ${it.name}${when(it.span)}`);
            lines.push('');
        }
    }
    for (const key of CONFIG.render_order) {
        const items = model.sections[key] || [];
        if (!items.length) continue;
        const heading = CONFIG.sections.find(s => s.key === key).heading;
        lines.push('', '---', '', `### ${heading}`);
        if (key === 'education') {
            for (const n of items) {
                const y = formatSpan(n.span) || n.year || '';
                const shown = y && !String(n.name).startsWith(`[${y}]`);   // some names already carry "[YYYY]"
                lines.push(`- ${shown ? `[${y}] ` : ''}**${n.name}**`);
            }
            continue;
        }
        for (const n of items) {
            lines.push(`#### ${n.name}${when(n.span)}${tag(n)}`);
            const prose = proseFor(n);
            const desc = prose || (typeof n.description === 'string' && n.description.length > 10 ? n.description : '');
            if (desc) { lines.push(''); lines.push(desc); }
            itemLinks(n).forEach(url => lines.push(`- ${url}`));
            lines.push('');
        }
    }
    return lines.join('\n');
}

/** True when the model has anything to show. */
function hasCareerContent(model) {
    return model.employers.length > 0 || Object.values(model.sections).some(s => s.length > 0);
}

module.exports = {
    parseYm, nodeSpan, compareNewestFirst, formatSpan, sectionOf, mergeNodes, buildCareerModel, renderCareerMap,
    hasCareerContent, CURRENT_YM,
};
