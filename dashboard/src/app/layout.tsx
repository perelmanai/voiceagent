import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aural Intel",
  description: "Live voice intelligence — transcript, context, and dispatch.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="antialiased">
      <body className="min-h-[100dvh] bg-bg text-fg">{children}</body>
    </html>
  );
}
