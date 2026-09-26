import { MINIMUM_AGE, TERMS_VERSION } from "./versions";

/**
 * THE BETA TERMS (Phase 32): DRAFT FOR COUNSEL.
 *
 * Written with the build, so every sentence describes what the product
 * actually does today; no lawyer has read it. The banner says so on the
 * page. What a lawyer must add (governing law, liability, consumer-law
 * carve-outs) is listed in the last section rather than guessed at.
 *
 * Every word on /terms is here; lib/legal/terms.test.ts holds them to the
 * house copy rules. Changing a sentence a person agrees to means a new
 * TERMS_VERSION, so the consent record names the text that was accepted.
 */

export const TERMS_CONTACT_EMAIL = "info@momentumterminal.app";

export const TERMS = {
  title: "Beta Terms",
  version: TERMS_VERSION,
  draft: {
    label: "DRAFT FOR COUNSEL",
    body: "These terms have not yet been reviewed by a lawyer. They describe how the beta works today, so that everyone invited knows what they are agreeing to. A reviewed version will replace them, with a new version label.",
  },
  intro: "These terms are between you and Momentum Terminal, and apply while you use the closed beta. Please read them with the Privacy notice, which says what is collected and how to have it deleted.",
  sections: [
    {
      title: "The beta",
      body: [
        "Momentum Terminal is in a closed beta, open by invitation only. Features can change, pause or stop while it is being built.",
        "During the beta, paper balances and positions can be adjusted or reset, for example after a fault or when the market's rules change. A reset applies alike to everyone it affects.",
      ],
    },
    {
      title: "Who can join",
      body: [
        `You must be ${MINIMUM_AGE} or older.`,
        "An invitation is for one email address and works once. One account per person.",
        "Signing in works through links sent to your email address (or your Google account, where offered), so keep access to that inbox to yourself.",
      ],
    },
    {
      title: "Paper trading, and nothing else",
      body: [
        "Every trade on the platform uses paper credit. Paper credit is not money. It cannot be bought, sold, withdrawn, transferred or exchanged for anything, and it has no cash equivalent. No prize is offered for any balance or ranking.",
        "You cannot lose more than you put into a position: there is no borrowing, and no selling of shares you do not hold.",
        "Nothing on the platform is financial advice. The platform offers no trading with real money.",
      ],
    },
    {
      title: "What the numbers mean",
      body: [
        "The Momentum Score is an automated reading of public signals about where a person's momentum is heading. It measures trajectory. It is not a judgement of anyone's character, and it can be wrong.",
        "The market price moves with paper trading and drifts back toward the score. How both work is explained in plain language on the How the price works page.",
        "The people tracked on the platform are not affiliated with it and have not endorsed it, unless the platform says otherwise.",
        "Forecasts are opinions about momentum, shared by members. They never move a score.",
      ],
    },
    {
      title: "Fair use",
      body: [
        "Do not use more than one account, coordinate with others to move a market price, trade or read the platform by automated means, try to reach another member's account, or get around a limit or a security measure.",
        "Do not harass or impersonate anyone, including the people the platform tracks. A username, display name or photo must be yours to use and must not mislead.",
        "Trading is monitored for manipulation. An account can be frozen while it is reviewed, and closed if it breaks these terms. A name or photo that breaks them can be removed.",
      ],
    },
    {
      title: "Your account",
      body: [
        "You can delete your account at any time from your profile. Your personal details are deleted; your paper trades, the paper ledger and your forecasts are kept without your name, so the market's history and everyone else's balances still add up. The Privacy notice has the detail.",
        "The beta can end, or your access to it can end, with notice in the app or by email where that is practical.",
      ],
    },
    {
      title: "As it is",
      body: [
        "The beta is provided as it is, while it is being built. It may contain errors, lose data or be unavailable, and figures on it may be wrong.",
      ],
    },
    {
      title: "Changes and contact",
      body: [
        "If these terms change, the new version is posted here with a new version label and date.",
        "Questions about these terms: {contact}.",
      ],
    },
    {
      title: "For counsel",
      body: [
        "Not yet drafted, and needed before the beta opens beyond invited testers: governing law and courts; limitation of liability and the consumer-law rights it cannot exclude; the legal entity and address; how a change to these terms is accepted; whether any jurisdiction treats a paper-trading game with rankings as regulated; and the standard of age check the service needs.",
      ],
    },
  ],
} as const;

/** Every string on /terms, for the rules test. */
export function allTermsStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(TERMS);
  return out;
}
