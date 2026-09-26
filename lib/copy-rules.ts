/**
 * THE HOUSE COPY RULES (Phase 28, shared from Phase 32).
 *
 * The words the brief forbids, and the frames it forbids, as patterns. The
 * landing, the onboarding screens, the join page and the Terms all test
 * their strings against these; each test says which rules apply to it (the
 * Terms, being a contract, may say "value" of paper credit, for one).
 */

/** No countdown, no "act now", no manufactured scarcity: the one rule every signup surface shares. */
export const URGENCY = /\b(hurry|limited (time|spots|places)|only \d+ (left|spots|places)|last chance|act now|don.t miss)\b/i;

export const HOUSE_BANNED: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "invest", pattern: /\binvest\w*/i },
  { name: "bet", pattern: /\bbet(s|ting|tor|tors)?\b/i },
  { name: "gamble", pattern: /\bgambl\w*/i },
  { name: "wager", pattern: /\bwager\w*/i },
  { name: "earn", pattern: /\bearn(s|ed|ing|ings)?\b/i },
  { name: "profit", pattern: /\bprofit\w*/i },
  { name: "returns", pattern: /\breturn(s|ed|ing)?\b/i },
  { name: "income", pattern: /\bincome\b/i },
  { name: "get paid", pattern: /\bget(s|ting)? paid\b|\bpaid\b|\bpayout\w*/i },
  { name: "worth (a person's)", pattern: /\bworth\b/i },
  { name: "value (a person's)", pattern: /\bvalue[sd]?\b|\bvaluation\b/i },
  { name: "real money coming", pattern: /real[- ]money (trading )?(is|will|soon|coming|later|next)/i },
  { name: "Oracle", pattern: /\boracle\b/i },
  { name: "Black Mirror", pattern: /black mirror/i },
  { name: "Nosedive", pattern: /nosedive/i },
  // No manufactured urgency.
  { name: "urgency", pattern: URGENCY },
  // The founder is never a pronoun.
  { name: "pronoun", pattern: /\b(he|him|his|she|her|hers)\b/ },
];

/** Every rule a string breaks, by name. */
export function copyViolations(text: string, rules: ReadonlyArray<{ name: string; pattern: RegExp }> = HOUSE_BANNED): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}
