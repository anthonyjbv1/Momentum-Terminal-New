/**
 * The onboarding screens' data shapes and the one choice they make (Phase
 * 32, Phase 32b). Isomorphic: the follow picker imports it in the browser.
 */

export interface RosterEntry {
  id: string;
  slug: string;
  name: string;
  category: string;
  avatarUrl: string | null;
}

/** A people row as the tour's picker reads it. `tradingMode` null is the default, tradeable. */
export interface TourCandidate {
  slug: string;
  tradingMode: string | null;
}

/** The person the tour prefers to show: a real, tradeable page everyone knows. */
export const TOUR_PREFERRED_SLUG = "mrbeast";

/**
 * Who the tour runs on (Phase 32b): the preferred person when their market
 * is open, else the first tradeable person in board order; never a
 * display-only or paused person, whose Buy the tour could not point at.
 * Null when nobody qualifies, and the tour is skipped.
 */
export function pickTourPerson(candidates: TourCandidate[]): string | null {
  const tradeable = candidates.filter((person) => person.tradingMode === null || person.tradingMode === "tradeable");
  const preferred = tradeable.find((person) => person.slug === TOUR_PREFERRED_SLUG);
  return preferred?.slug ?? tradeable[0]?.slug ?? null;
}
