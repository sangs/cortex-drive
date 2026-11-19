import type { Metadata } from "next";
import { Outfit, Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import SessionGuard from "@/components/SessionGuard";
import { AFTER_SIGN_OUT_URL, AUTH_ROUTES } from "@/lib/session-state";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cortex-Drive | Living Context Graph",
  description: "Cortex-Drive: The Living Memory for LLMs and the Definitive Source of Truth for Humans.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Routes come from config/auth-session.json (S2-92), so every build uses the in-app pages.
    <ClerkProvider
      signInUrl={AUTH_ROUTES.signIn}
      signUpUrl={AUTH_ROUTES.signUp}
      signInFallbackRedirectUrl={AUTH_ROUTES.afterSignIn}
      signUpFallbackRedirectUrl={AUTH_ROUTES.afterSignUp}
      afterSignOutUrl={AFTER_SIGN_OUT_URL}
    >
      <html lang="en" className="light" suppressHydrationWarning>
        <body
          className={`${outfit.variable} ${inter.variable} antialiased bg-background text-foreground min-h-screen`}
          suppressHydrationWarning
        >
          <SessionGuard />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
