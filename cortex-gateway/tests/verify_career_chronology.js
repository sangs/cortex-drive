'use strict';
/**
 * S2-94: career map newest first, with work shown where it was done (utils/career_chronology.js; design
 * documents/architecture/career-map-chronology-design-2026-11-19.md). Uses the PUBLIC career nodes search_enterprise_graph
 * returned on 2026-11-19 (tests/fixtures/career_nodes_2026-11-19.json), before the employer links were added, plus the
 * owner-confirmed links applied on top. No network. Run: node tests/verify_career_chronology.js (npm test).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const c = require('../utils/career_chronology');
const { nodes: FIXTURE } = require('./fixtures/career_nodes_2026-11-19.json');
const LINKS = require('../../data/curation/career_employer_links.json');

let passed = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); passed++; };
const ok = (cond, m) => { assert.ok(cond, m); passed++; };

// ── Dates ────────────────────────────────────────────────────────────────────────────────────
eq(c.parseYm('06/2021'), { ym: '2021-06', current: false }, 'MM/YYYY');
eq(c.parseYm('6/2021'), { ym: '2021-06', current: false }, 'M/YYYY');
eq(c.parseYm('2011'), { ym: '2011-00', current: false }, 'YYYY');
eq(c.parseYm('2025-11-02'), { ym: '2025-11', current: false }, 'ISO date');
eq(c.parseYm('Present'), { ym: c.CURRENT_YM, current: true }, 'Present');
eq([c.parseYm(null), c.parseYm(''), c.parseYm('soon')], [null, null, null], 'unknown → null');
ok('2009-12' < '2025-07', 'parsed dates compare correctly (the old text compare put "12/2009" after "07/2025")');

const jpmc = c.nodeSpan({ career_spans: [{ start: '02/2024', end: '07/2025', role: 'Lead Software Engineer, VP' },
                                          { start: '06/2021', end: '01/2024', role: 'Sr. Software Engineer (JPMC)' }] });
eq([jpmc.start, jpmc.end, jpmc.current, c.formatSpan(jpmc)], ['2021-06', '2025-07', false, '2021–2025'], 'two roles → one span 2021–2025');
eq(jpmc.roles, ['Lead Software Engineer, VP', 'Sr. Software Engineer (JPMC)'], 'both role titles kept');
eq(c.formatSpan(c.nodeSpan({ career_spans: [{ start: '08/2025', end: 'Present' }] })), '2025–Present', 'current span');
eq(c.formatSpan(c.nodeSpan({ career_spans: [{ start: '07/2025', end: '07/2025' }] })), '2025', 'one-month span');
eq(c.formatSpan(c.nodeSpan({ displayDate: '06/2007-12/2009' })), '2007–2009', 'older displayDate still read');
eq(c.formatSpan(c.nodeSpan({ year: '2011' })), '2011', 'year fallback');
eq(c.nodeSpan({ isPresent: true }).current, true, 'isPresent fallback');

// ── Sections by labels (config) ──────────────────────────────────────────────────────────────
eq(c.sectionOf({ labels: ['Project', 'Hackathon'] }), 'hackathons', 'Project+Hackathon is a hackathon');
eq(c.sectionOf({ labels: ['Project', 'ThoughtLeadership'] }), 'thoughtLeadership', 'Project+ThoughtLeadership is thought leadership');
eq(c.sectionOf({ labels: ['SocialLearning'] }), 'thoughtLeadership', 'social learning is thought leadership');
eq(c.sectionOf({ labels: ['Company'] }), 'employer', 'Company is an employer');
eq(c.sectionOf({ labels: ['Skill'] }), null, 'structural nodes are not listed');
eq(c.sectionOf({ type: 'Project' }), 'projects', 'type used when labels are missing');

// ── The real 2026-11-19 data, with the owner-confirmed employer links ────────────────────────
const linked = FIXTURE.map(n => {
    const link = LINKS.links.find(l => l.item === n.name && l.item_labels.every(lb => (n.labels || []).includes(lb)));
    return link ? { ...n, employer: link.employer } : n;
});
const model = c.buildCareerModel(linked);
eq(model.employers.map(e => e.name),
   ['Independent Ventures', 'JPMorgan Chase', 'Mezocliq LLC', 'GOLDMAN SACHS & CO.', 'GE Healthcare', 'Macmet India Pvt. Ltd.'],
   'Career Timeline newest first (Independent Ventures is current)');
eq(model.employers.map(e => c.formatSpan(e.span)), ['2025–Present', '2021–2025', '2013–2021', '2007–2009', '1999–2006', '1997–1999'],
   'each employer has its span');

const under = name => model.employers.find(e => e.name === name).items.map(i => i.name);
const jp = under('JPMorgan Chase');
for (const item of ['Global Hackathons @ JPMorgan Chase', 'Humanless Autocode at Scale for SRE @ JPMorgan Chase',
                    'Open-Source AI Agents Contribution @ JPMC', 'Ignite Social Learning Community @ JPMC',
                    'Metadata Agent Architecture', 'Gain/Loss Cloud Native Microservice']) {
    ok(jp.includes(item), `${item} is under JPMorgan Chase`);
}
const indep = under('Independent Ventures');
for (const item of ['Cortex-Drive', 'Volarisation Engine @ IBM Dev Day 2026',
                    'InfoQ: Architectural Shifts for Platform Engineers in the Age of AI']) {
    ok(indep.includes(item), `${item} is under Independent Ventures`);
}
eq(indep[0], 'Cortex-Drive', 'current work first under its employer');
ok(jp.indexOf('Global Hackathons @ JPMorgan Chase') < jp.indexOf('Gain/Loss Cloud Native Microservice'), 'items under an employer newest first');

const names = key => model.sections[key].map(n => n.name);
ok(names('hackathons').includes('Global Hackathons @ JPMorgan Chase') && names('thoughtLeadership').includes('Ignite Social Learning Community @ JPMC'),
   'employer work also appears in its own section');
eq(names('hackathons'), ['Volarisation Engine @ IBM Dev Day 2026', 'Global Hackathons @ JPMorgan Chase',
                         'Humanless Autocode at Scale for SRE @ JPMorgan Chase'], 'hackathons newest first');
eq(names('projects')[0], 'Cortex-Drive', 'current project first');
eq(names('projects').slice(-1)[0], 'Simulation systems development and evaluation (Macmet)', 'oldest project last');
eq(names('education').map(n => n.slice(0, 6)), ['[2026]', '[2024]', '[2011]', '[1997]'], 'education newest first');
eq(model.current.map(n => n.name), ['Cortex-Drive'], 'current projects (writer targets)');

const md = c.renderCareerMap(model);
ok(md.indexOf('#### Independent Ventures') < md.indexOf('#### JPMorgan Chase') && md.indexOf('#### JPMorgan Chase') < md.indexOf('#### Macmet'), 'rendered timeline order');
ok(/#### JPMorgan Chase · Lead Software Engineer, VP; Sr\. Software Engineer \(JPMC\) \[2021–2025\]/.test(md), 'employer line shows roles and span');
ok(/#### Global Hackathons @ JPMorgan Chase \[2025\] · @ JPMorgan Chase/.test(md), 'section items tagged with their employer');
ok(!/\[\[\d{4}\]/.test(md) && md.includes('- **[2011] Master'), 'no doubled year on education names');
eq((md.match(/^#### Cortex-Drive/m) || []).length, 1, 'Cortex-Drive listed once as a section heading');
eq(c.renderCareerMap(model, { proseFor: n => (n.name === 'Cortex-Drive' ? 'WRITER PROSE' : null) }).includes('WRITER PROSE'), true, 'writer prose used when given');

// Repeats (one row per relationship, two tools) collapse into one item with all spans.
const merged = c.mergeNodes([{ node_id: 'x', name: 'JPMorgan Chase', labels: ['Company'], career_spans: [{ start: '06/2021', end: '01/2024' }] },
                             { node_id: 'x', name: 'JPMorgan Chase', type: 'Company', career_spans: [{ start: '02/2024', end: '07/2025' }] }]);
eq([merged.length, c.formatSpan(merged[0].span)], [1, '2021–2025'], 'repeats merged, spans combined');

// Without the links (before the data step), nothing is invented: unlinked items are listed only in their section.
const raw = c.buildCareerModel(FIXTURE);
ok(!raw.employers.find(e => e.name === 'JPMorgan Chase').items.some(i => i.name.includes('Hackathons')), 'no employer guessed from a name');

// ── index.js wiring ──────────────────────────────────────────────────────────────────────────
const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
ok(!/q2RankedNodes[^\n]*temporal_boost/.test(index) && !/temporal_boost/.test(fs.readFileSync(path.join(__dirname, '../utils/career_chronology.js'), 'utf8').replace(/\/\*\*[\s\S]*?\*\//g, '')),
   'the career map is not ordered by temporal_boost (it stays only for scored search summaries)');
ok(!/function groupNodesForQ2|function nodeTimeline|CAREER_CHAT_NODE_TYPES/.test(index), 'old inline career helpers removed');
eq((index.match(/careerChronology\.renderCareerMap\(/g) || []).length, 2, 'both career writers render through the module');
ok(/q2RankedNodes = careerChronology\.mergeNodes\(\[\.\.\.\(q2RankedNodes \|\| \[\]\), \.\.\.parsed\.nodes\]\)/.test(index), 'career nodes from every career tool call are kept and merged');

console.log(`verify_career_chronology: ${passed} checks passed`);
