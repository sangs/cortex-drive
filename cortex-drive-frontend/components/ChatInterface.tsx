'use client';
import { useState, useRef, useEffect } from 'react';
import { useCortex } from '@/context/CortexContext';
import { useSSE } from '@/hooks/useSSE';
import { Send, Bot, User } from 'lucide-react';

export default function ChatInterface() {
    const [input, setInput] = useState('');
    const { messages, addMessage } = useCortex();
    const { connect } = useSSE();
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = () => {
        if (!input.trim()) return;

        // Add user message to context
        addMessage({ role: 'user', content: input });

        // Trigger SSE connection with the query
        connect(input);

        setInput('');
    };

    return (
        <div className="chat-panel glass">
            <div className="chat-header" style={{ padding: '16px', borderBottom: '1px solid var(--surface-border)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bot size={18} className="neon-text-blue" />
                Cortex AI Assistant
            </div>

            <div className="chat-messages" style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {messages.map((msg, i) => (
                    <div
                        key={i}
                        className={`message ${msg.role}`}
                        style={{
                            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                            background: msg.role === 'user' ? 'rgba(0, 210, 255, 0.1)' : 'rgba(255,255,255,0.05)',
                            padding: '12px 16px',
                            borderRadius: '16px',
                            borderTopRightRadius: msg.role === 'user' ? '4px' : '16px',
                            borderTopLeftRadius: msg.role === 'bot' ? '4px' : '16px',
                            fontSize: '14px',
                            maxWidth: '85%',
                            border: `1px solid ${msg.role === 'user' ? 'rgba(0, 210, 255, 0.2)' : 'rgba(255,255,255,0.1)'}`
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', opacity: 0.6, fontSize: '11px' }}>
                            {msg.role === 'user' ? <User size={12} /> : <Bot size={12} />}
                            {msg.role === 'user' ? 'You' : 'Cortex AI'}
                        </div>
                        {msg.content}
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            <div className="chat-input" style={{ padding: '16px', borderTop: '1px solid var(--surface-border)' }}>
                <div style={{ position: 'relative' }}>
                    <input
                        type="text"
                        placeholder="Ask anything about the model..."
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                        style={{
                            width: '100%',
                            padding: '12px 48px 12px 16px',
                            background: 'rgba(0,0,0,0.3)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '24px',
                            color: 'white',
                            fontSize: '14px',
                            outline: 'none'
                        }}
                    />
                    <button
                        onClick={handleSend}
                        style={{
                            position: 'absolute',
                            right: '6px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '32px',
                            height: '32px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'linear-gradient(135deg, var(--accent-blue), var(--accent-purple))',
                            border: 'none',
                            borderRadius: '50%',
                            color: 'white',
                            cursor: 'pointer'
                        }}
                    >
                        <Send size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
