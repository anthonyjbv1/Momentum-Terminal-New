import { GeistSans } from "geist/font/sans";
import localFont from "next/font/local";

/**
 * The two typefaces, self-hosted through next/font (no runtime requests, no
 * layout shift). Each exposes a CSS variable that app/styles/tokens.css maps
 * onto --font-sans / --font-mono. To change a face: swap the import here and
 * keep the variable name, or point the token at a new variable.
 *
 *   sans  Geist Sans          interface text
 *   mono  JetBrains Mono      every number, label and timer (the terminal voice)
 */
export const jetBrainsMono = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
      weight: "100 800",
      style: "normal",
    },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const geistSans = GeistSans;

/** Put this on <html> so the font variables are available everywhere. */
export const fontVariables = `${geistSans.variable} ${jetBrainsMono.variable}`;
