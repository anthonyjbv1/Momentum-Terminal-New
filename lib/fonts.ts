import localFont from "next/font/local";

/**
 * The two typefaces, self-hosted through next/font (no runtime requests, no
 * layout shift). Each exposes a CSS variable that app/styles/tokens.css maps
 * onto --font-sans / --font-mono. To change a face: point `path` at a new
 * file and keep the variable name.
 *
 *   sans  Inter            the interface: headings, body, labels, buttons
 *   mono  JetBrains Mono   numbers only, through the `num` utility
 */
export const inter = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
  ],
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: "Arial",
});

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

/** Put this on <html> so the font variables are available everywhere. */
export const fontVariables = `${inter.variable} ${jetBrainsMono.variable}`;
