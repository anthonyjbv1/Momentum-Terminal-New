/**
 * The onboarding screens' data shapes and the one choice they make (Phase
 * 32). Isomorphic: the follow picker and the forecast screen import it in
 * the browser.
 */

export interface RosterEntry {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatarUrl: string | null;
}

/** When nobody was followed, the forecast screen offers the top of the board. */
export const FORECAST_FALLBACK_COUNT = 6;

/** Who the forecast screen offers: the people just followed, in board order; or the top of the board when nobody was. */
export function forecastChoices(roster: RosterEntry[], following: string[]): RosterEntry[] {
  const followed = new Set(following);
  const picked = roster.filter((person) => followed.has(person.id));
  return picked.length > 0 ? picked : roster.slice(0, FORECAST_FALLBACK_COUNT);
}
