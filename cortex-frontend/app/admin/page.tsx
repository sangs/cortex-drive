"use client";

import { useState } from "react";
import {
    Users,
    CheckCircle,
    XCircle,
    ShieldAlert,
    ArrowLeft
} from "lucide-react";
import Link from "next/link";

export default function AdminPage() {
    // Mock users data - in reality, this would fetch from a database or Clerk API
    const [users, setUsers] = useState([
        { id: "user_1", name: "Sangeetha R", email: "sangs@example.com", status: "APPROVED", joined: "2024-02-20" },
        { id: "user_2", name: "John Doe", email: "john@example.com", status: "PENDING", joined: "2024-02-26" },
        { id: "user_3", name: "Jane Smith", email: "jane@example.com", status: "PENDING", joined: "2024-02-27" },
    ]);

    const toggleApproval = (id: string) => {
        setUsers(prev => prev.map(u => {
            if (u.id === id) {
                return { ...u, status: u.status === 'APPROVED' ? 'PENDING' : 'APPROVED' };
            }
            return u;
        }));
    };

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 p-8">
            <div className="max-w-5xl mx-auto">
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-4">
                        <Link href="/dashboard" className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                            <ArrowLeft className="w-5 h-5" />
                        </Link>
                        <h1 className="text-3xl font-bold flex items-center gap-3">
                            <ShieldAlert className="text-amber-500" />
                            Admin Control Center
                        </h1>
                    </div>
                    <div className="px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium">
                        System Admin
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 shadow-xl">
                        <div className="text-slate-500 text-sm font-medium mb-1">Total Users</div>
                        <div className="text-3xl font-bold">{users.length}</div>
                    </div>
                    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 shadow-xl">
                        <div className="text-slate-500 text-sm font-medium mb-1">Pending Approval</div>
                        <div className="text-3xl font-bold text-amber-500">
                            {users.filter(u => u.status === 'PENDING').length}
                        </div>
                    </div>
                    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 shadow-xl">
                        <div className="text-slate-500 text-sm font-medium mb-1">Active Trials</div>
                        <div className="text-3xl font-bold text-indigo-500">12</div>
                    </div>
                </div>

                <div className="bg-white/5 rounded-2xl border border-white/5 overflow-hidden shadow-2xl">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="border-b border-white/5 bg-white/5 text-slate-400 text-xs uppercase tracking-widest">
                                <th className="px-6 py-4 font-semibold">User</th>
                                <th className="px-6 py-4 font-semibold">Joined</th>
                                <th className="px-6 py-4 font-semibold">Status</th>
                                <th className="px-6 py-4 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {users.map((user) => (
                                <tr key={user.id} className="hover:bg-white/5 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-400">
                                                {user.name.charAt(0)}
                                            </div>
                                            <div>
                                                <div className="font-medium">{user.name}</div>
                                                <div className="text-xs text-slate-500">{user.email}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-sm text-slate-400">
                                        {user.joined}
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold tracking-tighter ${user.status === 'APPROVED' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                                            }`}>
                                            {user.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <button
                                            onClick={() => toggleApproval(user.id)}
                                            className={`p-2 rounded-lg transition-all ${user.status === 'APPROVED'
                                                    ? 'text-slate-500 hover:text-red-400 hover:bg-red-500/10'
                                                    : 'text-indigo-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                                                }`}
                                        >
                                            {user.status === 'APPROVED' ? <XCircle className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
