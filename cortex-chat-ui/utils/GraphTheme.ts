/**
 * GraphTheme.ts
 * Central source of truth for Universal Graph Visuals.
 * Maps node types (labels) to HSL (Canvas) and Tailwind (Legend) colors.
 */

export interface ThemeToken {
    hsl: string;
    tailwind: string;
    radius: number;
}

export const GRAPH_THEME: Record<string, ThemeToken> = {
    // 1. PROFESSIONAL ENTITIES
    Category: {
        hsl: 'hsl(210, 80%, 45%)',      // Deep Blue
        tailwind: 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)]',
        radius: 12
    },
    Project: {
        hsl: 'hsl(200, 70%, 55%)',      // Sky Blue
        tailwind: 'bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]',
        radius: 8
    },
    Hackathon: {
        hsl: 'hsl(270, 70%, 55%)',      // Vibrant Purple
        tailwind: 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]',
        radius: 8
    },
    ThoughtLeadership: {
        hsl: 'hsl(280, 60%, 50%)',      // Deep Purple
        tailwind: 'bg-indigo-600 shadow-[0_0_8px_rgba(79,70,229,0.5)]',
        radius: 8
    },
    Role: {
        hsl: 'hsl(180, 60%, 45%)',      // Teal
        tailwind: 'bg-teal-500 shadow-[0_0_8px_rgba(20,184,166,0.5)]',
        radius: 7
    },
    Outcome: {
        hsl: 'hsl(45, 90%, 50%)',       // Gold
        tailwind: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]',
        radius: 5
    },
    Achievement: {
        hsl: 'hsl(45, 90%, 50%)',       // Gold
        tailwind: 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]',
        radius: 5
    },

    // 2. PODCAST ENTITIES
    Episode: {
        hsl: 'hsl(210, 80%, 45%)',      // Match Category for hierarchy
        tailwind: 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)]',
        radius: 10
    },
    Topic: {
        hsl: 'hsl(270, 70%, 55%)',      // Match Hackathon for innovation
        tailwind: 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]',
        radius: 8
    },
    Person: {
        hsl: 'hsl(142, 70%, 45%)',      // Emerald
        tailwind: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]',
        radius: 7
    },
    Chunk: {
        hsl: 'hsl(45, 90%, 50%)',       // Amber
        tailwind: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]',
        radius: 4
    },
    Technology: {
        hsl: 'hsl(217, 90%, 60%)',      // Indigo
        tailwind: 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]',
        radius: 8
    },

    // 3. COMMON ENTITIES
    Company: {
        hsl: 'hsl(210, 20%, 40%)',      // Dark Slate
        tailwind: 'bg-slate-600 shadow-[0_0_8px_rgba(71,85,105,0.5)]',
        radius: 7
    },
    Education: {
        hsl: 'hsl(25, 80%, 50%)',       // Orange
        tailwind: 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)]',
        radius: 7
    },
    Location: {
        hsl: 'hsl(0, 70%, 60%)',        // Rose
        tailwind: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]',
        radius: 5
    }
};

export const DEFAULT_THEME: ThemeToken = {
    hsl: 'hsl(210, 20%, 65%)',          // Medium Slate
    tailwind: 'bg-slate-400 shadow-[0_0_8px_rgba(148,163,184,0.5)]',
    radius: 6
};

/**
 * Utility to get theme for any node type
 */
export const getThemeForType = (type: string): ThemeToken => {
    return GRAPH_THEME[type] || DEFAULT_THEME;
};
