"use client";
/**
 * The signed-in user's account menu, the same on every signed-in page (S2-92).
 * Design: documents/architecture/sign-out-and-sign-in-design-2026-11-18.md §3.1.
 *
 * Clerk's UserButton gives "Manage account" (profile, security, active devices → sign out of other
 * devices). The visible Sign out button ends this session; SessionGuard then clears browser state.
 */
import { OrganizationSwitcher, UserButton, useClerk, useOrganization, useUser } from '@clerk/nextjs';
import { LogOut } from 'lucide-react';

import { AFTER_SIGN_OUT_URL, AUTH_ROUTES } from '@/lib/session-state';

const PERSONAL_ACCOUNT_LABEL = 'Personal account';

const THEMES = {
    light: {
        name: 'text-slate-900', sub: 'text-slate-500',
        button: 'text-slate-500 hover:text-red-600 hover:bg-red-50 border-slate-200',
        switcher: 'w-full justify-start p-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 transition-colors shadow-sm font-bold text-slate-900',
    },
    dark: {
        name: 'text-white', sub: 'text-slate-400',
        button: 'text-slate-300 hover:text-red-300 hover:bg-white/10 border-white/10',
        switcher: 'w-full justify-start p-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors font-bold text-white',
    },
} as const;

interface AccountMenuProps {
    /** Sidebar layout shows the org switcher above the user row; header layout is one compact row. */
    layout?: 'sidebar' | 'header';
    theme?: keyof typeof THEMES;
    /** Extra page links shown next to the user (e.g. the dashboard's Costs and Settings icons). */
    children?: React.ReactNode;
}

export default function AccountMenu({ layout = 'header', theme = 'light', children }: AccountMenuProps) {
    const { user } = useUser();
    const { organization } = useOrganization();
    const { signOut } = useClerk();
    const t = THEMES[theme];

    const signOutButton = (
        <button
            type="button"
            onClick={() => signOut({ redirectUrl: AFTER_SIGN_OUT_URL })}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-colors ${t.button}`}
            title="Sign out"
            aria-label="Sign out"
        >
            <LogOut className="w-3.5 h-3.5" />
            {layout === 'header' && <span>Sign out</span>}
        </button>
    );

    const identity = (
        <div className="flex items-center gap-3 min-w-0">
            <UserButton userProfileMode="modal" />
            <div className="flex flex-col min-w-0">
                <span className={`text-xs font-black truncate max-w-[140px] ${t.name}`}>
                    {user?.fullName || user?.primaryEmailAddress?.emailAddress || ''}
                </span>
                <span className={`text-[10px] font-bold truncate max-w-[140px] ${t.sub}`}>
                    {organization?.name || PERSONAL_ACCOUNT_LABEL}
                </span>
            </div>
        </div>
    );

    if (layout === 'header') {
        return (
            <div className="flex items-center gap-3" data-testid="account-menu">
                {identity}
                {children}
                {signOutButton}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3" data-testid="account-menu">
            <div className="px-1">
                <OrganizationSwitcher
                    afterCreateOrganizationUrl={AUTH_ROUTES.afterSignIn}
                    appearance={{ elements: { rootBox: 'w-full', organizationSwitcherTrigger: t.switcher } }}
                />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-white rounded-xl border border-slate-200 shadow-sm">
                {identity}
                <div className="flex items-center gap-2 shrink-0">
                    {children}
                    {signOutButton}
                </div>
            </div>
        </div>
    );
}
