import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

import { AUTH_ROUTES, PUBLIC_ROUTES } from "./lib/session-state";

// Public routes (incl. /graph-view guest links) are listed once in config/auth-session.json (S2-92).
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTES]);

export default clerkMiddleware(async (auth, request) => {
    if (!isPublicRoute(request)) {
        await auth.protect();
    }
}, { signInUrl: AUTH_ROUTES.signIn, signUpUrl: AUTH_ROUTES.signUp });

export const config = {
    matcher: [
        // Skip Next.js internals and all static files, unless found in search params
        "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
        // Always run for API routes
        "/(api|trpc)(.*)",
    ],
};
