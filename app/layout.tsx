import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Momentum Terminal",
  description: "Take HIGH or LOW positions on the people shaping culture.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
