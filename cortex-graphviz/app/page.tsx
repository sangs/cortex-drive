import Sidebar from "@/components/Sidebar";
import GraphView from "@/components/GraphView";
import ChatInterface from "@/components/ChatInterface";

export default function Home() {
  return (
    <>
      <Sidebar />
      <main className="main-content">
        <header className="header">
          <div className="brand neon-text-blue">CortexModel</div>
          <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Status:</span>
            <span style={{ color: 'var(--accent-blue)' }}>Connected to Graph</span>
          </div>
        </header>

        <GraphView />
      </main>
      <ChatInterface />
    </>
  );
}
