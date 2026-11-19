import { SignIn } from "@clerk/nextjs";

import { AUTH_ROUTES } from "@/lib/session-state";

// After sign-out, Clerk sends users here with ?signed_out=1 (S2-92): say so, then offer sign-in.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const signedOut = params[AUTH_ROUTES.signedOutParam] === "1";
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950">
            {signedOut && (
                <p role="status" className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
                    You have signed out. Sign in again to continue.
                </p>
            )}
            <SignIn 
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
        </div>
    );
}
