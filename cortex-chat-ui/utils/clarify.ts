// Clarifying questions from the gateway (routing v2, cross-domain design 2026-11-09 §4.5). The gateway decides when to
// ask and offers only people the user can see; the browser renders the options and sends the choice back. The gateway
// re-checks the choice against the user's visible catalog, so nothing here is trusted.
export type ClarifyOption = { label: string; entity: { kind: 'person'; name: string } | null };
export type Clarify = { question: string; options: ClarifyOption[] };
export type ClarifyChoice = { kind: 'person'; name?: string; names?: string[] };

/** The choice to send for an option: one person, or every listed person for "Both" (entity null). */
export function clarifyChoiceFor(option: ClarifyOption, clarify: Clarify): ClarifyChoice | null {
    if (option.entity) return { kind: 'person', name: option.entity.name };
    const names = clarify.options.map(o => o.entity?.name).filter((n): n is string => !!n);
    return names.length ? { kind: 'person', names } : null;
}

/** A clarify payload from the gateway, or null when malformed. */
export function readClarify(value: unknown): Clarify | null {
    const v = value as Clarify;
    if (!v || typeof v.question !== 'string' || !Array.isArray(v.options) || !v.options.length) return null;
    return v.options.every(o => o && typeof o.label === 'string') ? v : null;
}
