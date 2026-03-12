export default function Sidebar() {
    return (
        <aside className="sidebar glass">
            <div className="logo brand">CortexModel</div>

            <div className="section">
                <h3 className="text-secondary" style={{ fontSize: '12px', textTransform: 'uppercase', marginBottom: '16px' }}>
                    User Profile
                </h3>
                <div className="profile-card glass" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'linear-gradient(45deg, #00d2ff, #9d50bb)' }}></div>
                    <div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>Sangeetha R</div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Architect</div>
                    </div>
                </div>
            </div>

            <div className="section" style={{ marginTop: 'auto' }}>
                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', fontSize: '12px' }}>
                    <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>Model Version</div>
                    <div className="neon-text-blue">v2.4.0-neural</div>
                </div>
            </div>
        </aside>
    );
}
