"use client";
/**
 * Starter questions under the empty chat (S2-102, architecture/question-suggestions-design-2026-11-23.md §3.3):
 * four questions built by the gateway from what this user can open (GET /api/suggestions/starters), no LLM.
 * "More ideas" asks for the next page. Clicking a question asks it like a typed one.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Lightbulb, RefreshCw } from "lucide-react";
import { GATEWAY_URL as GATEWAY } from "@/lib/gateway";
import { readStarters, type Starter } from "@/utils/suggestions";

type Props = {
    onAsk: (question: string) => void;
    disabled?: boolean;
    /** Shown when the conversation is empty; a shorter heading when brought back by "Try asking". */
    intro?: boolean;
};

export default function StarterQuestions({ onAsk, disabled = false, intro = true }: Props) {
    const { getToken, isSignedIn } = useAuth();
    const [page, setPage] = useState(0);
    const [starters, setStarters] = useState<Starter[] | null>(null);
    const [pages, setPages] = useState(1);   // from the gateway (config starter_more_pages)

    const load = useCallback(async (p: number) => {
        if (!isSignedIn) return;
        try {
            const token = await getToken();
            const resp = await fetch(`${GATEWAY}/api/suggestions/starters?page=${p}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!resp.ok) return;
            const body = await resp.json();
            setStarters(readStarters(body));
            if (Number.isInteger(body?.pages) && body.pages > 0) setPages(body.pages);
        } catch { /* keep what is shown */ }
    }, [getToken, isSignedIn]);

    useEffect(() => { load(page); }, [load, page]);

    if (!starters || !starters.length) return null;
    return (
        <div className="flex flex-col gap-3" aria-label="Suggested questions">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
                <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                {intro ? "Ask about your organization's knowledge. Try one of these:" : "Try asking:"}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {starters.map(s => (
                    <button
                        key={s.question}
                        onClick={() => onAsk(s.question)}
                        disabled={disabled}
                        data-kind={s.kind}
                        className="text-left px-4 py-3 rounded-xl text-sm font-medium border border-border bg-white hover:bg-indigo-50 hover:border-indigo-200 text-slate-700 hover:text-indigo-700 transition-all disabled:opacity-50"
                    >
                        {s.question}
                    </button>
                ))}
            </div>
            {pages > 1 && <button
                onClick={() => setPage(p => (p + 1) % pages)}
                disabled={disabled}
                className="self-start flex items-center gap-1.5 text-[11px] font-bold text-slate-400 hover:text-indigo-600 transition-colors disabled:opacity-50"
            >
                <RefreshCw className="w-3 h-3" /> More ideas
            </button>}
        </div>
    );
}
