import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run sits behind Google's load balancer which sets x-forwarded-host.
  // Without this, Next.js ignores that header and Clerk SSR sees the wrong host,
  // causing a post-login redirect loop on app.cortex-drive.com.
  // trustHostHeader is a valid runtime option in Next.js 16 but absent from its TypeScript types.
  // Production-only (NODE_ENV=production, set by `next start`/Cloud Run): with no load balancer
  // in front on plain `next dev`, this flag makes the dev server try to proxy requests to itself
  // based on a malformed forwarded-host, which 500s every route (confirmed 2026-09-24 — /sign-in
  // failed with "socket hang up" regardless of auth state).
  ...(process.env.NODE_ENV === "production" ? { experimental: { trustHostHeader: true } as any } : {}),
};

export default nextConfig;
