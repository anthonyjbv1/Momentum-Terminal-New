import { describe, expect, it } from "vitest";

import { decodeEntities, hasEntities } from "./entities";

describe("HTML entities in headlines (2026-09-29)", () => {
  it("decodes the numeric and named entities a feed writes, and a double-encoded one", () => {
    expect(decodeEntities("Kai Cenat&#8217;s live audience is up")).toBe("Kai Cenat’s live audience is up");
    expect(decodeEntities("Kai Cenat&amp;#8217;s stream")).toBe("Kai Cenat’s stream");
    expect(decodeEntities("Drake&#8217;s &#8220;Quebec&#8221; &amp; more")).toBe("Drake’s “Quebec” & more");
    expect(decodeEntities("&quot;Musk&quot; &#x27;film&#x27; &mdash; a review&hellip;")).toBe('"Musk" \'film\' — a review…');
    expect(decodeEntities("Tom&nbsp;Brady &lt;3 &gt; Mahomes")).toBe("Tom Brady <3 > Mahomes");
    expect(decodeEntities("Beyonc&eacute;")).toBe("Beyoncé");
  });

  it("leaves text without entities, an unknown name and a non-character code as they are", () => {
    expect(decodeEntities("A plain headline with an & sign")).toBe("A plain headline with an & sign");
    expect(decodeEntities("&notanentity; stays")).toBe("&notanentity; stays");
    expect(decodeEntities("&#0; and &#xD800; stay")).toBe("&#0; and &#xD800; stay");
    expect(hasEntities("Kai Cenat&#8217;s")).toBe(true);
    expect(hasEntities("Kai Cenat’s")).toBe(false);
  });
});
