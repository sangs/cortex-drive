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
    Podcast: {
        hsl: 'hsl(220, 70%, 50%)',      // Professional Blue
        tailwind: 'bg-indigo-600 shadow-[0_0_8px_rgba(79,70,229,0.5)]',
        radius: 14
    },
    Episode: {
        hsl: 'hsl(210, 80%, 45%)',      // Deep Blue
        tailwind: 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)]',
        radius: 10
    },
    Topic: {
        hsl: 'hsl(270, 70%, 55%)',      // Vibrant Purple (Innovation)
        tailwind: 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]',
        radius: 8
    },
    Person: {
        hsl: 'hsl(142, 70%, 45%)',      // Emerald (Growth)
        tailwind: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]',
        radius: 7
    },
    Chunk: {
        hsl: 'hsl(45, 90%, 50%)',       // Amber (Insight)
        tailwind: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]',
        radius: 4
    },
    Technology: {
        hsl: 'hsl(217, 90%, 60%)',      // Indigo
        tailwind: 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]',
        radius: 8
    },

    // 3. COMMON & PROFESSIONAL LANDMARKS
    Company: {
        hsl: 'hsl(210, 20%, 40%)',      // Dark Slate
        tailwind: 'bg-slate-700 shadow-[0_0_8px_rgba(51,65,85,0.5)]',
        radius: 12
    },
    Startup: {
        hsl: 'hsl(260, 70%, 50%)',      // Electric Purple
        tailwind: 'bg-purple-600 shadow-[0_0_8px_rgba(147,51,234,0.5)]',
        radius: 12
    },
    Hackathon: {
        hsl: 'hsl(215, 80%, 45%)',      // Royal Blue
        tailwind: 'bg-blue-700 shadow-[0_0_8px_rgba(29,78,216,0.5)]',
        radius: 10
    },
    ThoughtLeadership: {
        hsl: 'hsl(245, 70%, 50%)',      // Indigo Core
        tailwind: 'bg-indigo-700 shadow-[0_0_8px_rgba(67,56,202,0.5)]',
        radius: 11
    },
    Certification: {
        hsl: 'hsl(142, 60%, 40%)',      // Forest Green
        tailwind: 'bg-emerald-700 shadow-[0_0_8px_rgba(4,120,87,0.5)]',
        radius: 9
    },
    Degree: {
        hsl: 'hsl(25, 80%, 50%)',       // Achievement Orange
        tailwind: 'bg-orange-600 shadow-[0_0_8px_rgba(234,88,12,0.5)]',
        radius: 8
    },
    Institution: {
        hsl: 'hsl(210, 20%, 30%)',      // Slate Heavy
        tailwind: 'bg-slate-800 shadow-[0_0_8px_rgba(30,41,59,0.5)]',
        radius: 11
    },
    Education: {
        hsl: 'hsl(25, 80%, 50%)',       
        tailwind: 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)]',
        radius: 9
    },
    SocialLearning: {
        hsl: 'hsl(330, 70%, 50%)',      // Pink Social
        tailwind: 'bg-pink-600 shadow-[0_0_8px_rgba(219,39,119,0.5)]',
        radius: 8
    },
    Publication: {
        hsl: 'hsl(200, 70%, 40%)',      // Teal/Bule Knowledge
        tailwind: 'bg-sky-700 shadow-[0_0_8px_rgba(3,105,161,0.5)]',
        radius: 9
    },
    Location: {
        hsl: 'hsl(0, 70%, 60%)',        // Rose
        tailwind: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]',
        radius: 5
    },
    Year: {
        hsl: 'hsl(226, 70%, 94%)',
        tailwind: 'bg-indigo-100 shadow-[0_0_8px_rgba(199,210,254,0.5)]',
        radius: 12
    },

    // 4. WEBSITE ENTITIES (added 2026-08-29 — was falling through to DEFAULT_THEME's gray)
    WebsiteSource: {
        hsl: 'hsl(190, 80%, 50%)',      // Cyan — unused elsewhere in this palette, distinct
                                         // from podcast's blue/indigo family and career's
                                         // slate/orange family, reads naturally as "web"
        tailwind: 'bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.5)]',
        radius: 12
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
