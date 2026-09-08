import type { Metadata, Viewport } from "next";

import { fontVariables } from "@/lib/fonts";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Momentum Terminal",
    template: "%s · Momentum Terminal",
  },
  description: "Take HIGH or LOW positions on the people shaping culture. Scores move every 30 seconds.",
  applicationName: "Momentum Terminal",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Momentum" },
};

export const viewport: Viewport = {
  // Browser chrome cannot read CSS, so this mirrors --color-canvas from
  // app/styles/tokens.css. Keep the two in step when recolouring the ground.
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables}>
      <body className="min-h-dvh bg-canvas text-fg antialiased">{children}</body>
    </html>
  );
}
