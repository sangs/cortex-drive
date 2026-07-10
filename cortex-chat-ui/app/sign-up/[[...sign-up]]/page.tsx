"use client";

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { SignUp } from "@clerk/nextjs";

function SignUpInner() {
    const params = useSearchParams();
    const email = params.get('email') || undefined;

    return (
        <SignUp
            initialValues={{ emailAddress: email }}
            appearance={{
                elements: {
                    formButtonPrimary: 'bg-indigo-600 hover:bg-indigo-500 text-sm',
                    card: 'bg-slate-900 border border-white/10 shadow-2xl',
                    headerTitle: 'text-white',
                    headerSubtitle: 'text-slate-400',
                    socialButtonsBlockButton: 'bg-white/5 border border-white/10 text-white hover:bg-white/10',
                    dividerLine: 'bg-white/10',
                    dividerText: 'text-slate-500',
                    formFieldLabel: 'text-slate-400',
                    formFieldInput: 'bg-slate-800 border-white/10 text-white',
                    footerActionText: 'text-slate-500',
                    footerActionLink: 'text-indigo-400 hover:text-indigo-300'
                }
            }}
        />
    );
}

export default function Page() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-950">
            <Suspense fallback={<div className="text-slate-400 text-sm">Loading…</div>}>
                <SignUpInner />
            </Suspense>
        </div>
    );
}
