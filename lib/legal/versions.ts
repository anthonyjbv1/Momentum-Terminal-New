/**
 * The versions a new account agrees to (Phase 32). Each is recorded against
 * the account in user_consents at the moment the join form is submitted, so
 * changing a text means changing its version here, and every account keeps
 * the version it actually saw.
 */

/** The beta Terms. DRAFT FOR COUNSEL until counsel signs it off; the version says so. */
export const TERMS_VERSION = "beta-draft-2026-09-26";

/** The Privacy notice, as updated for accounts in Phase 32. */
export const PRIVACY_VERSION = "2026-09-26";

/** The minimum age a new account attests to. */
export const MINIMUM_AGE = 18;
