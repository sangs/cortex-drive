"use client";

import { useState, useEffect } from "react";
import { UserButton } from "@clerk/nextjs";
import {
    Plus,
    Search,
    BrainCircuit,
    MessageSquare,
    History,
    Settings,
    SendHorizontal,
    Wifi,
    WifiOff
} from "lucide-react";
import A2UIRenderer from "@/components/a2ui/A2UIRenderer";
import { useMCP } from "@/hooks/use-mcp";

export default function DashboardPage() {
    const { isConnected, responses, callTool } = useMCP();
    const [messages, setMessages] = useState<any[]>([
        {
            role: "assistant",
            content: "Hello! I'm your Cortex Brain. Ask me anything about your podcast library, or start an analysis.",
        }
    ]);
    const [input, setInput] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);

    // Sync MCP responses to message list
    useEffect(() => {
        if (responses.length > 0) {
            const lastResponse = responses[responses.length - 1];

            // Handle tool call results
            if (lastResponse.result && lastResponse.result.content) {
                const textContent = lastResponse.result.content[0].text;
                try {
                    // Attempt to parse tool output as A2UI JSON
                    const data = JSON.parse(textContent);

                    // If it's a list (like from search_episodes), we might want to render multiple nodes
                    if (Array.isArray(data)) {
                        data.forEach(item => {
                            setMessages(prev => [...prev, {
                                role: "assistant",
                                content: {
                                    type: "knowledge-node",
                                    props: {
                                        title: item.episode_name || item.name,
                                        description: item.chunk_text || item.description,
                                        episodeNumber: item.episode_number || 0,
                                        sourceUrl: item.episode_link || item.link
                                    }
                                }
                            }]);
                        });
                    } else {
                        setMessages(prev => [...prev, { role: "assistant", content: data }]);
                    }
                } catch {
                    // Fallback to text
                    setMessages(prev => [...prev, { role: "assistant", content: textContent }]);
                }
                setIsProcessing(false);
            }
        }
    }, [responses]);

    const handleSend = async () => {
        if (!input.trim() || !isConnected || isProcessing) return;

        const userMsg = input;
        setMessages(prev => [...prev, { role: "user", content: userMsg }]);
        setInput("");
        setIsProcessing(true);

        try {
            // Trigger the search tool
            await callTool("search_episodes_gds_by_question_tool", {
                question: userMsg,
                k: 5,
                limit: 5
            });
        } catch (err) {
            console.error("Tool call failed", err);
            setMessages(prev => [...prev, {
                role: "assistant",
                content: "I encountered an error communicating with your Knowledge Graph."
            }]);
            setIsProcessing(false);
        }
    };

    return (
        <div className="flex h-screen bg-slate-950 overflow-hidden text-slate-100">
            {/* Sidebar */}
            <aside className="w-72 border-r border-white/5 flex flex-col bg-slate-900/50 backdrop-blur-xl">
                <div className="p-6 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <BrainCircuit className="text-white w-6 h-6" />
                    </div>
                    <span className="text-xl font-bold tracking-tight">Cortex OS</span>
                </div>

                <nav className="flex-1 px-4 space-y-2 py-4">
                    <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-all group">
                        <Plus className="w-5 h-5 text-indigo-400 group-hover:scale-110 transition-transform" />
                        <span className="font-medium">New Analysis</span>
                    </button>

                    <div className="pt-6 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-widest flex items-center justify-between">
                        <span>Server Status</span>
                        {isConnected ? (
                            <Wifi className="w-3 h-3 text-emerald-500" />
                        ) : (
                            <WifiOff className="w-3 h-3 text-red-500" />
                        )}
                    </div>

                    <div className="px-4 py-2">
                        <div className={`text-[10px] px-2 py-1 rounded inline-block ${isConnected ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                            {isConnected ? "REMOTE CONNECTED" : "OFFLINE"}
                        </div>
                    </div>
                </nav>

                <div className="p-4 border-t border-white/5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <UserButton afterSignOutUrl="/" />
                        <div className="flex flex-col">
                            <span className="text-sm font-medium">My Brain</span>
                            <span className="text-xs text-slate-500 truncate max-w-[120px]">Authenticated</span>
                        </div>
                    </div>
                    <button className="p-2 text-slate-500 hover:text-white transition-colors">
                        <Settings className="w-5 h-5" />
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 flex flex-col relative overflow-hidden">
                {/* Header */}
                <header className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-slate-950/50 backdrop-blur-md z-10">
                    <div className="flex items-center gap-4">
                        <History className="w-5 h-5 text-slate-500" />
                        <span className="text-sm text-slate-500">Conversation History</span>
                    </div>
                    <div className="flex items-center gap-4 bg-white/5 rounded-full px-4 py-1.5 border border-white/5">
                        <Search className="w-4 h-4 text-slate-500" />
                        <input
                            type="text"
                            placeholder="Search concepts..."
                            className="bg-transparent border-none focus:outline-none text-sm w-48 text-slate-300 placeholder:text-slate-600"
                        />
                    </div>
                </header>

                {/* Messages area */}
                <div className="flex-1 overflow-y-auto p-8 space-y-8 pb-32">
                    {messages.map((msg, i) => (
                        <div
                            key={i}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div className={`max-w-2xl ${msg.role === 'user' ? 'bg-indigo-600/10 border border-indigo-500/20 p-4 rounded-2xl shadow-lg shadow-indigo-500/5' : ''}`}>
                                <A2UIRenderer message={msg.content} />
                            </div>
                        </div>
                    ))}
                    {isProcessing && (
                        <div className="flex justify-start">
                            <div className="flex items-center gap-2 text-slate-500 text-sm animate-pulse">
                                <BrainCircuit className="w-4 h-4" />
                                Processing graph...
                            </div>
                        </div>
                    )}
                </div>

                {/* Input area */}
                <div className="absolute bottom-0 left-0 right-0 p-8 pt-0 bg-gradient-to-t from-slate-950 via-slate-950 to-transparent">
                    <div className="max-w-3xl mx-auto relative">
                        <input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                            disabled={!isConnected || isProcessing}
                            placeholder={isConnected ? "Query your Mental Model..." : "Connecting to brain..."}
                            className="w-full bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-2xl p-4 pr-16 shadow-2xl focus:outline-none focus:border-indigo-500/50 transition-all text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <button
                            onClick={handleSend}
                            disabled={!isConnected || isProcessing || !input.trim()}
                            className="absolute right-3 top-2.5 p-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 rounded-xl transition-all shadow-lg shadow-indigo-600/20 active:scale-95"
                        >
                            <SendHorizontal className="w-5 h-5 text-white" />
                        </button>
                    </div>
                </div>
            </main>
        </div>
    );
}
