/**
 * EVERY WORD ON THE MEMBER PROFILE AND THE DELETION SCREEN (Phase 32), in
 * one file so lib/profile/copy.test.ts can hold them to the house rules and
 * to the Privacy notice: the deletion screen must say what the database
 * actually does.
 */

export const PROFILE = {
  joined: "Joined {date}",
  photo: {
    add: "Add a photo",
    change: "Change photo",
    remove: "Remove photo",
    hint: "JPEG, PNG or WebP, up to 2 MB. Only you and the operator can see it.",
    saved: "Photo saved.",
    removed: "Photo removed.",
    tooBig: "That photo is over 2 MB. Choose a smaller one.",
  },
  stats: {
    following: "Following",
    forecasts: "Forecasts",
    trades: "Trades",
  },
  edit: {
    button: "Edit profile",
    title: "Edit profile",
    description: "Your photo, your name and a line about you. Only you and the operator can see your profile.",
    photo: "Photo",
    bio: "Bio",
    bioHint: "Optional. Plain text, up to 150 characters, no links.",
    saved: "Saved.",
    save: "Save",
  },
  activity: {
    title: "Activity",
    openPositions: "Open positions",
    trades: "Trades",
    forecasts: "Forecasts",
    portfolio: "Open portfolio",
  },
  record: {
    title: "Forecast record",
    body: "How your forecasts compare with what actually happened will appear here, once there is enough history to measure it fairly.",
  },
  following: {
    title: "Following",
    none: "You do not follow anyone yet. Following adds a Following filter on Home.",
    change: "Change",
    pick: "Pick people",
  },
  referral: {
    title: "Your referral link",
    body: "Anyone who joins the waitlist through this link is recorded as referred by you. That is all it does: there is no reward.",
    copy: "Copy link",
    copied: "Copied",
  },
  settings: {
    title: "Settings",
    email: "Email",
    emailHint: "Sign-in links go to this address.",
    displayName: "Display name",
    displayNameHint: "Shown on your profile. Up to 80 characters.",
    save: "Save",
    saved: "Saved.",
    updates: "Email me occasional product updates",
    updatesHint: "Off unless you turn it on. Invitations and sign-in links are sent either way.",
    tour: "Take the tour again",
    tourHint: "The short walk through one person's page: the score, the market price, the forces, and where Portfolio and Feed are.",
  },
  account: {
    title: "Account",
    delete: "Delete account",
    deleteHint: "Deletes your personal details. Paper trades and forecasts are kept without your name.",
  },
} as const;

export const DELETE_PAGE = {
  title: "Delete your account",
  intro: "This cannot be undone. Here is exactly what happens before you confirm.",
  deleted: {
    title: "Deleted",
    items: [
      "Your email address, username, display name and photo",
      "Your bio",
      "The people you follow",
      "The record of what you opened and tapped in the app",
      "The network hash stored with your trades",
      "Your waitlist entry and invitation details",
      "Your sign-in: you are signed out, and this address can no longer sign in",
    ],
  },
  kept: {
    title: "Kept, without your name",
    body: "Your paper trades, the paper ledger and your forecasts stay under an anonymous “Deleted account”, with no link back to you, so the market’s history and every other member’s balance still add up.",
  },
  backups: "Database backups are kept for seven days, so the deleted details leave the backups within seven days.",
  confirm: "I understand that this deletes my account and cannot be undone.",
  submit: "Delete my account",
  cancel: "Keep my account",
  rejoin: "To come back later, you would need a new invitation.",
  portfolio: "Open portfolio",
} as const;

/** Every string above, for the rules test. */
export function allProfileStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk({ PROFILE, DELETE_PAGE });
  return out;
}
