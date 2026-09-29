/**
 * HTML ENTITIES IN HEADLINES (2026-09-29).
 *
 * Feeds carry titles with entities in them: Google News writes
 * "Kai Cenat&#8217;s", a publisher writes "&amp;" and "&quot;", and a
 * syndication step that escaped an already-escaped title leaves
 * "&amp;#8217;". A reader should meet an apostrophe. This decodes the
 * numeric forms (decimal and hex) and the named ones a headline uses, and
 * repeats until the text stops changing, so a double-encoded entity comes
 * out as its character too. Display and ingestion text only: nothing that
 * scores a signal reads through it.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  aacute: "á",
  ccedil: "ç",
  ntilde: "ñ",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  oacute: "ó",
  iacute: "í",
  uacute: "ú",
};

const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi;

/** At most this many passes: one for a normal entity, one more for a double-encoded one, one for good measure. */
const MAX_PASSES = 3;

function decodeOnce(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Not a character: the control range and anything past Unicode's end stay as written.
      if (!Number.isFinite(code) || code === 0 || (code < 32 && code !== 9 && code !== 10) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED[body] ?? NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

/** "Kai Cenat&#8217;s" → "Kai Cenat’s"; "&amp;#8217;" → "’"; text with no entity comes back as it was. */
export function decodeEntities(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Whether the text still carries something that reads as an entity. */
export function hasEntities(text: string): boolean {
  ENTITY.lastIndex = 0;
  return ENTITY.test(text);
}
