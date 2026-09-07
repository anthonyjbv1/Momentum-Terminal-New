import { describe, expect, it } from "vitest";

import { extractJson } from "./json";
import { LLMError } from "./types";

describe("extractJson", () => {
  it("parses plain JSON, fenced JSON and JSON wrapped in prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```\nDone.')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! {"label":"positive","confidence":0.8} hope that helps')).toEqual({ label: "positive", confidence: 0.8 });
    expect(extractJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("throws an LLMError when nothing parses", () => {
    expect(() => extractJson("no json here", "anthropic")).toThrow(LLMError);
    try {
      extractJson("{broken", "anthropic");
    } catch (error) {
      expect(error).toMatchObject({ kind: "invalid_response", provider: "anthropic" });
    }
  });
});
