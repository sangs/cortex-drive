/**
 * Settings → People (S2-50 build 2b): payload checks and the preview wording for "Remove person".
 * The gateway decides who may be removed; the UI only shows and confirms.
 */
export type Person = { userSub: string; name: string | null; kind: 'member' | 'collaborator' };

export function readPeople(value: unknown): Person[] {
    if (!Array.isArray(value)) return [];
    return value.filter(p => p && typeof p.userSub === 'string' && /^user_/.test(p.userSub)).map(p => ({
        userSub: p.userSub,
        name: typeof p.name === 'string' && p.name ? p.name : null,
        kind: p.kind === 'member' ? 'member' : 'collaborator',
    }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What removing will do, in plain words, from the preview counts. */
export function previewLines(kind: Person['kind'], counts: Record<string, unknown>): string[] {
    const n = (k: string) => (Number.isInteger(counts?.[k]) ? (counts[k] as number) : 0);
    if (kind === 'collaborator') {
        return [`${plural(n('shares'), 'share')} you gave them will be revoked`,
                `They leave ${plural(n('groups'), 'group')} you created`,
                'Nothing else changes; their account stays'];
    }
    const lines = [
        `${plural(n('owned_nodes'), 'item')} they added transfer to you, as "Transferred from <their name>"`,
        `${plural(n('access_tuples'), 'access entry', 'access entries')} in this organization removed`,
        `${plural(n('received_shares'), 'share')} they received here revoked; ${plural(n('group_memberships'), 'group seat')} removed`,
        `${plural(n('invitations_sent') + n('invitations_to_them'), 'pending invitation')} cancelled; ${plural(n('links'), 'link')} revoked`,
        `${plural(n('org_conversations'), 'chat')} in this organization hidden, then deleted after 30 days`,
        'Their account and personal history stay; they are removed from the organization in Clerk',
    ];
    return lines;
}
