"use client";

import { useState } from "react";
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { BrainCircuit, Sparkles, Network, Database, ShieldCheck, ChevronRight, Activity, ArrowRight, Play, X, UserSearch } from "lucide-react";

export default function Home() {
  const [showDemo, setShowDemo] = useState(false);
  const [demoStep, setDemoStep] = useState(1);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground overflow-hidden font-sans">
      {/* Editorial Gradient Header */}
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-accent to-primary" />
      
      {/* Background Neural Textures */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] bg-primary/5 blur-[120px] rounded-full -z-10" />
      
      {/* Navigation Header */}
      <header className="container mx-auto px-8 h-20 flex items-center justify-between z-50">
        <div className="flex items-center gap-3 group cursor-pointer">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center shadow-xl shadow-primary/20 group-hover:scale-110 transition-transform">
            <BrainCircuit className="text-white w-6 h-6" />
          </div>
          <span className="text-2xl font-extrabold tracking-tighter font-display">CortexDrive</span>
        </div>
        
        <nav className="hidden md:flex items-center gap-10">
          <button className="text-sm font-bold opacity-40 cursor-not-allowed">Case Studies</button>
          <button className="text-sm font-bold opacity-40 cursor-not-allowed">Infrastructure</button>
          <div className="h-4 w-px bg-border mx-2" />
          <SignedIn>
            <Link href="/dashboard" className="text-sm font-bold text-primary flex items-center gap-2 hover:translate-x-1 transition-transform">
              Go to Dashboard <ChevronRight className="w-4 h-4" />
            </Link>
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button className="px-5 py-2 rounded-xl border border-primary/20 text-sm font-black text-primary hover:bg-primary/5 transition-colors">Sign In</button>
            </SignInButton>
          </SignedOut>
        </nav>
      </header>

      {/* Main Hero: The Executive Archive */}
      <main className="flex-1 flex flex-col container mx-auto px-8 pt-24 pb-32">
        {/* Hero */}
        <div className="flex flex-col items-start gap-8">
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-primary/5 border border-primary/10 text-primary text-[10px] font-black uppercase tracking-[0.2em]">
            <Activity className="w-3 h-3 animate-pulse" />
            <span>RE-HYDRATE YOUR ENTERPRISE LLM WITH LIVE INSTITUTIONAL CONTEXT</span>
          </div>

          <h1 className="text-6xl md:text-8xl font-black font-display tracking-tighter leading-[0.9] text-slate-900">
            Your LLM <span className="text-transparent bg-clip-text bg-gradient-to-br from-primary to-indigo-400">knows the world.</span><br />
            <span className="opacity-40 italic">It doesn&apos;t know your organization.</span>
          </h1>

          <p className="max-w-2xl text-lg md:text-xl text-muted-foreground leading-relaxed font-medium">
            Every enterprise LLM is reasoning against frozen data. It cannot know what your organization decided, who made the call, or why.{" "}
            <span className="text-primary font-bold">CortexDrive re-hydrates LLM reasoning</span> with live institutional context —{" "}
            <span className="text-foreground font-bold">verified, grounded, and always current.</span>
          </p>

          <div className="flex flex-col sm:flex-row gap-5 mt-4">
            <SignedIn>
              <Link
                href="/dashboard"
                className="h-16 px-12 rounded-2xl bg-primary text-white font-black text-lg flex items-center justify-center hover:scale-[1.05] transition-all shadow-2xl shadow-primary/30 active:scale-95 group"
              >
                Ask CortexDrive
                <ArrowRight className="ml-3 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </SignedIn>
            <SignedOut>
              <SignInButton mode="modal" fallbackRedirectUrl="/dashboard">
                <button className="h-16 px-12 rounded-2xl bg-primary text-white font-black text-lg flex items-center justify-center hover:scale-[1.05] transition-all shadow-2xl shadow-primary/30 active:scale-95 group">
                  Ask CortexDrive
                  <ArrowRight className="ml-3 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>
              </SignInButton>
            </SignedOut>
          </div>
        </div>

        {/* Full-Width Video Placeholder */}
        <section className="mt-20 relative">
          <button
            onClick={() => { setShowDemo(true); setDemoStep(1); }}
            className="w-full group relative block"
          >
            <div className="relative z-10 p-2 bg-slate-900 rounded-[2.5rem] shadow-[0_40px_100px_-20px_rgba(2,6,23,0.4)] border border-slate-800 overflow-hidden">
              <div className="aspect-video bg-slate-950 rounded-[2rem] flex flex-col items-center justify-center relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-transparent pointer-events-none" />
                <div className="w-24 h-24 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/20 group-hover:scale-110 group-hover:bg-white/20 transition-all duration-300">
                  <Play className="text-white fill-white w-10 h-10 ml-1" />
                </div>
                <div className="mt-6 text-center">
                  <p className="text-sm font-black text-white uppercase tracking-[0.2em]">Watch CortexDrive in Action</p>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-2">3 queries · live graph · no narration</p>
                </div>
              </div>
            </div>
            <div className="absolute -bottom-4 -right-4 w-full h-full bg-primary/5 rounded-[2.5rem] -z-10 rotate-1 border border-primary/10" />
          </button>
        </section>

        {/* Strategic Proof points */}
        <section className="mt-48 grid grid-cols-1 md:grid-cols-3 gap-12">
          <div className="flex flex-col gap-4">
             <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center text-primary border border-primary/10 mb-2">
                <Network className="w-6 h-6" />
             </div>
             <h3 className="text-xl font-black font-display tracking-tightest text-slate-800">Explainable Memory</h3>
             <p className="text-muted-foreground text-sm leading-relaxed font-medium">
               Every fact in an LLM answer is traceable to a specific node, chunk, or field returned by a tool call in that turn. The graph on screen is the citation map for the answer.
             </p>
          </div>
          <div className="flex flex-col gap-4">
             <div className="w-12 h-12 rounded-xl bg-violet-500/5 flex items-center justify-center text-violet-600 border border-violet-500/10 mb-2">
                <Database className="w-6 h-6" />
             </div>
             <h3 className="text-xl font-black font-display tracking-tightest text-slate-800">Infrastructure-Grade Intelligence</h3>
             <p className="text-muted-foreground text-sm leading-relaxed font-medium">
                Built on Neo4j and MCP. A zero-write virtualized layer — session bridges exist only in memory, never persisted to the database. The knowledge base stays clean.
             </p>
          </div>
          <div className="flex flex-col gap-4">
             <div className="w-12 h-12 rounded-xl bg-emerald-500/5 flex items-center justify-center text-emerald-600 border border-emerald-500/10 mb-2">
                <ShieldCheck className="w-6 h-6" />
             </div>
             <h3 className="text-xl font-black font-display tracking-tightest text-slate-800">Sovereign Graph Security</h3>
             <p className="text-muted-foreground text-sm leading-relaxed font-medium">
                Security is a topological property, not a filter. An LLM cannot be prompted into revealing data the graph cannot physically traverse to. Identity-anchored access, bounded by geometry.
             </p>
          </div>
        </section>

        {/* Discovery Strip */}
        <section className="mt-24 flex items-center justify-center gap-4 py-8 border-t border-slate-100">
          <UserSearch className="w-5 h-5 text-slate-400 shrink-0" />
          <p className="text-sm font-medium text-slate-500">
            Explore the career and philosophy of the architect behind CortexDrive.{" "}
            <button
              onClick={() => { setShowDemo(true); setDemoStep(1); }}
              className="text-primary font-bold underline underline-offset-2 hover:opacity-70 transition-opacity"
            >
              Meet the Architect →
            </button>
          </p>
        </section>
      </main>

      {/* Meet the Architect Popover */}
      {showDemo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 sm:p-12">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-xl" onClick={() => setShowDemo(false)} />
          
          <div className="relative w-full max-w-5xl bg-white rounded-[2.5rem] shadow-2xl border border-white/20 overflow-hidden animate-in fade-in zoom-in duration-300">
            {/* Popover Header */}
            <div className="p-8 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/20">
                  <UserSearch className="text-white w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-black tracking-tight leading-none italic uppercase">Introducing the Architect</h2>
                  <p className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-widest">
                    {demoStep === 1 && "Phase 1: Decision Logic & Philosophy"}
                    {demoStep === 2 && "Phase 2: Chronological Institutional Memory"}
                    {demoStep === 3 && "Phase 3: Academic Foundations & Continuous Learning"}
                  </p>
                </div>
              </div>
              <button onClick={() => setShowDemo(false)} className="p-2 rounded-full hover:bg-slate-100 transition-colors">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>

            {/* Popover Content */}
            <div className="grid grid-cols-1 lg:grid-cols-5 min-h-[550px]">
              {/* Query Panel */}
              <div className="lg:col-span-2 bg-slate-50/50 p-8 border-r border-slate-100 flex flex-col gap-8">
                <div className="flex flex-col gap-4">
                  <p className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">Discovery Query:</p>
                  <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-sm">
                    <p className="text-sm font-black text-slate-800 leading-relaxed italic">
                      {demoStep === 1 && "\"Who is the architect behind CortexDrive and what is her core philosophy?\""}
                      {demoStep === 2 && "\"Meet the Founder: Show me Sangeetha's professional trajectory.\""}
                      {demoStep === 3 && "\"Show me Sangeetha's academic foundations and specialized certifications.\""}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-6 mt-auto">
                   <div className="flex items-center gap-4 p-4 bg-primary/5 rounded-2xl border border-primary/10">
                      <Sparkles className="w-5 h-5 text-primary shrink-0" />
                      <p className="text-xs font-bold text-slate-600 leading-snug">
                        {demoStep === 1 && "Connecting Identity to Vision via the Decision Trace."}
                        {demoStep === 2 && "Extracting temporal links across institutional silos."}
                        {demoStep === 3 && "Mapping the evolution of technical expertise and specialized domains."}
                      </p>
                   </div>
                   
                   <button 
                    onClick={() => {
                        if (demoStep < 3) setDemoStep(demoStep + 1);
                        else setShowDemo(false);
                    }}
                    className="h-14 w-full rounded-xl bg-slate-900 text-white font-black text-sm flex items-center justify-center hover:bg-primary transition-colors gap-2"
                   >
                     {demoStep === 1 && "Analyze Professional Trajectory"}
                     {demoStep === 2 && "Explore Academic Foundations"}
                     {demoStep === 3 && "Return to Vision"}
                     <ArrowRight className="w-4 h-4" />
                   </button>
                </div>
              </div>

              {/* Graph Panel */}
              <div className="lg:col-span-3 p-8 relative flex items-center justify-center overflow-hidden bg-white">
                 {demoStep === 1 && (
                   /* Philosophy Graph (Mocked) */
                   <div className="relative w-full h-full flex items-center justify-center">
                      <div className="absolute inset-0 bg-radial-gradient from-primary/5 to-transparent" />
                      {/* Sangeetha Node */}
                      <div className="z-10 w-32 h-32 rounded-3xl bg-white border-2 border-primary shadow-2xl flex flex-col items-center justify-center gap-2 p-2 group transition-transform hover:scale-105">
                         <div className="w-16 h-16 rounded-2xl bg-slate-200 overflow-hidden relative">
                           <div className="w-full h-full bg-gradient-to-br from-primary to-indigo-400" />
                           <div className="absolute inset-0 flex items-center justify-center">
                              <BrainCircuit className="text-white/50 w-8 h-8" />
                           </div>
                         </div>
                         <p className="text-[10px] font-black text-slate-900 uppercase">Sangeetha R.</p>
                      </div>
                      
                      <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                         <line x1="50%" y1="50%" x2="20%" y2="30%" stroke="#4f46e5" strokeWidth="2" strokeDasharray="4 4" />
                         <line x1="50%" y1="50%" x2="80%" y2="30%" stroke="#4f46e5" strokeWidth="2" strokeDasharray="4 4" />
                         <line x1="50%" y1="50%" x2="50%" y2="80%" stroke="#4f46e5" strokeWidth="2" strokeDasharray="4 4" />
                      </svg>
                      
                      <div className="absolute top-[20%] left-[10%] p-3 bg-slate-900 rounded-xl text-white text-[9px] font-black uppercase shadow-xl animate-bounce">Decision Trace</div>
                      <div className="absolute top-[20%] right-[10%] p-3 bg-primary rounded-xl text-white text-[9px] font-black uppercase tracking-widest shadow-xl">Built CortexDrive</div>
                      <div className="absolute bottom-[10%] left-1/2 -translate-x-1/2 p-3 bg-indigo-100 border border-primary/20 rounded-xl text-primary text-[9px] font-black uppercase italic shadow-lg">Institutional Memory</div>
                   </div>
                 )}

                 {demoStep === 2 && (
                   /* Trajectory Graph (Chronological) */
                   <div className="w-full h-full flex flex-col gap-10 items-center justify-center py-4">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-6 w-full">
                         {[
                           { name: "Cortex-Drive", dates: "08/2025 - Present", type: "Venture", color: "bg-primary" },
                           { name: "JPMorgan Chase", dates: "06/2021 - 07/2025", type: "VP / Lead SWE", color: "bg-slate-900" },
                           { name: "Mezocliq LLC", dates: "02/2013 - 02/2021", type: "Sr. Software Engineer", color: "bg-slate-800" },
                           { name: "Goldman Sachs", dates: "06/2007 - 12/2009", type: "Sr. SWE, Consultant", color: "bg-slate-700" },
                           { name: "GE Healthcare", dates: "05/1999 - 01/2006", type: "IT Systems Specialist", color: "bg-slate-600" },
                           { name: "Macmet India", dates: "08/1997 - 04/1999", type: "Software Engineer", color: "bg-slate-500" }
                         ].map((pos, i) => (
                           <div key={i} className="p-5 bg-white border border-slate-100 rounded-[2rem] shadow-sm flex flex-col gap-3 hover:border-primary hover:shadow-md transition-all cursor-default group">
                             <div className={`w-8 h-1.5 rounded-full ${pos.color} group-hover:w-full transition-all duration-500`} />
                             <div className="space-y-1">
                               <p className="text-[13px] font-black text-slate-900 leading-tight uppercase tracking-tight">{pos.name}</p>
                               <p className="text-[10px] font-bold text-primary italic leading-none">{pos.dates}</p>
                             </div>
                             <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-slate-400 pt-1 border-t border-slate-50">
                                <span>{pos.type}</span>
                                <ChevronRight className="w-3 h-3 text-slate-200 group-hover:text-primary transition-colors" />
                             </div>
                           </div>
                         ))}
                      </div>
                      <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center gap-4 w-full">
                        <Activity className="w-5 h-5 text-emerald-500 animate-pulse" />
                        <div>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Graph Synthesis Output:</p>
                          <p className="text-[10px] font-bold text-slate-600 italic">"Full 26-year temporal spine established across institutional silos (1997-2026)."</p>
                        </div>
                      </div>
                   </div>
                 )}

                 {demoStep === 3 && (
                   /* Education Graph (Simulated actual response) */
                   <div className="w-full h-full flex flex-col gap-8 items-center justify-center py-4">
                      <div className="grid grid-cols-2 gap-6 w-full">
                         {[
                           { name: "MIT: Applied Data Science", year: "2024", type: "Professional Education", institution: "MIT Professional Education" },
                           { name: "InfoQ Certified Architect", year: "2026", type: "Latest Advancement", institution: "InfoQ Architecture Cohort" },
                           { name: "Master's Degree (CS)", year: "2011", type: "Graduate Degree", institution: "Illinois Institute of Technology" },
                           { name: "Bachelor's Degree (E&C)", year: "1997", type: "Undergraduate", institution: "NIT Bhopal" }
                         ].map((edu, i) => (
                           <div key={i} className="p-6 bg-slate-50 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col gap-3 group hover:bg-white hover:border-primary transition-all">
                             <div className="flex items-center justify-between">
                                <span className={`px-3 py-1 bg-white rounded-full text-[8px] font-black uppercase tracking-widest border ${edu.year === '2026' ? 'text-primary border-primary' : 'text-slate-400 border-slate-200'}`}>{edu.year}</span>
                                <Database className={`w-4 h-4 ${edu.year === '2026' ? 'text-primary' : 'text-slate-200'} group-hover:text-primary transition-colors`} />
                             </div>
                             <div className="space-y-1">
                               <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">{edu.name}</p>
                               <p className="text-[9px] font-bold text-slate-400">{edu.institution}</p>
                             </div>
                             <p className="text-[8px] font-black text-primary uppercase tracking-[0.2em] mt-2 group-hover:translate-x-1 transition-transform">{edu.type}</p>
                           </div>
                         ))}
                      </div>
                      <div className="w-full p-4 border border-dashed border-slate-200 rounded-2xl text-center">
                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Bridging Academic Rigor with Industry-Scale Architecture</p>
                      </div>
                   </div>
                 )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modern High-End Footer */}
      <footer className="border-t border-border py-16 bg-slate-50/50 backdrop-blur-md mt-auto">
        <div className="container mx-auto px-8 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex flex-col gap-4 items-center md:items-start">
             <div className="flex items-center gap-2">
                <BrainCircuit className="w-5 h-5 text-primary" />
                <span className="font-black text-lg tracking-tighter">CortexDrive Engine</span>
             </div>
             <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">The reasoning layer your enterprise AI was missing.</p>
          </div>
          <div className="flex items-center gap-10 text-[10px] font-black uppercase tracking-widest text-slate-500">
            <button className="hover:text-primary transition-colors opacity-40">Architecture</button>
            <button className="hover:text-primary transition-colors opacity-40">Privacy Vault</button>
            <button className="hover:text-primary transition-colors opacity-40">Executive Demo</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
