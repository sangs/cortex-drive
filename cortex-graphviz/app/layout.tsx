import { ClerkProvider } from "@clerk/nextjs";
import { CortexProvider } from "@/context/CortexContext";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CortexModel | Knowledge Mesh",
  description: "AI-powered organizational mental models",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <CortexProvider>
        <html lang="en">
          <body>
            <div className="app-container">
              {children}
            </div>
          </body>
        </html>
      </CortexProvider>
    </ClerkProvider>
  );
}
