import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RailAI — Rhine–Ruhr Control",
  description: "An interactive railway dispatch laboratory for the Köln–Düsseldorf–Dortmund corridor. Explore train movements, resolve conflicts, and compare classical scheduling with local QAOA.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
