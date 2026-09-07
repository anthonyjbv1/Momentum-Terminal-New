import { LLMError } from "./types";

/**
 * Pulls a JSON value out of model text. Tolerates ```json fences, leading
 * prose and trailing commentary by falling back to the outermost {...} or
 * [...] span. Throws an LLMError(kind: "invalid_response") when nothing parses.
 */
export function extractJson(text: string, provider = "unknown"): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  for (const open of ["{", "["]) {
    const close = open === "{" ? "}" : "]";
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }

  throw new LLMError(`Model response was not valid JSON: ${trimmed.slice(0, 120)}`, {
    kind: "invalid_response",
    provider,
  });
}
