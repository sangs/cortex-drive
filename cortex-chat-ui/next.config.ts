import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run sits behind Google's load balancer which sets x-forwarded-host.
  // Without this, Next.js ignores that header and Clerk SSR sees the wrong host,
  // causing a post-login redirect loop on app.cortex-drive.com.
  // trustHostHeader is a valid runtime option in Next.js 16 but absent from its TypeScript types.
  experimental: { trustHostHeader: true } as any,
};

export default nextConfig;
