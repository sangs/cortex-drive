import Link from "next/link";
import { BrainCircuit, Sparkles, Network, Database, ShieldCheck } from "lucide-react";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-6xl h-[500px] bg-indigo-600/10 blur-[120px] rounded-full -z-10" />
      
      {/* Header */}
      <header className="container mx-auto px-6 h-24 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <BrainCircuit className="text-white w-6 h-6" />
          </div>
          <span className="text-2xl font-bold tracking-tight">CortexDrive</span>
        </div>
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-400">
          <Link href="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
          <a href="http://localhost:3002" target="_blank" className="hover:text-white transition-colors">Graph Viz</a>
          <Link href="/admin" className="hover:text-white transition-colors">Admin</Link>
        </nav>
      </header>

      {/* Hero Section */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 pt-20 pb-32">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold mb-8 animate-fade-in">
          <Sparkles className="w-3 h-3" />
          <span>Intelligent Mental Models are here</span>
        </div>
        
        <h1 className="max-w-4xl text-5xl md:text-7xl font-extrabold tracking-tight mb-8 leading-[1.1]">
          Connect Your Brain to the <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Knowledge Cloud</span>
        </h1>
        
        <p className="max-w-2xl text-lg md:text-xl text-slate-400 mb-12 leading-relaxed">
          CortexDrive is your personal mental model accelerator. We turn your podcast library, 
          reading list, and thoughts into a structured knowledge graph you can chat with.
        </p>

        <div className="flex flex-col sm:flex-row gap-4">
          <Link 
            href="/dashboard" 
            className="h-14 px-10 rounded-2xl bg-indigo-600 text-white font-bold text-lg flex items-center justify-center hover:bg-indigo-500 transition-all shadow-xl shadow-indigo-600/20 active:scale-95"
          >
            Enter Your Brain
          </Link>
          <a 
            href="http://localhost:3002" 
            target="_blank"
            className="h-14 px-10 rounded-2xl bg-white/5 border border-white/10 text-white font-bold text-lg flex items-center justify-center hover:bg-white/10 transition-all active:scale-95"
          >
            View Graph Viz
          </a>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-40 container mx-auto text-left">
          <div className="p-8 rounded-3xl bg-white/5 border border-white/5 hover:border-indigo-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-indigo-600/20 flex items-center justify-center mb-6">
              <Network className="text-indigo-400 w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold mb-4">Semantic Graph</h3>
            <p className="text-slate-400 leading-relaxed text-sm">
              We don't just search; we understand context. Your data is structured as a living knowledge graph.
            </p>
          </div>

          <div className="p-8 rounded-3xl bg-white/5 border border-white/5 hover:border-cyan-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-cyan-600/20 flex items-center justify-center mb-6">
              <Database className="text-cyan-400 w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold mb-4">Open Infrastructure</h3>
            <p className="text-slate-400 leading-relaxed text-sm">
              Powered by Model Context Protocol (MCP) and Neo4j. Your data follows industry standards.
            </p>
          </div>

          <div className="p-8 rounded-3xl bg-white/5 border border-white/5 hover:border-emerald-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-emerald-600/20 flex items-center justify-center mb-6">
              <ShieldCheck className="text-emerald-400 w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold mb-4">Enterprise Security</h3>
            <p className="text-slate-400 leading-relaxed text-sm">
              Multi-tenancy and authentication via Clerk ensures your mental model stays private and secure.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12">
        <div className="container mx-auto px-6 flex flex-col md:row items-center justify-between gap-6 text-slate-500 text-sm">
          <p>© 2024 CortexDrive Platform. All rights reserved.</p>
          <div className="flex items-center gap-8">
            <Link href="/privacy" className="hover:text-slate-300">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-slate-300">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
