/**
 * THE MEMBER PROFILE's rules (Phase 32): what a display name may be, what a
 * photo may be, where a photo lives, and the words the page and the deletion
 * screen use. Isomorphic, and free of server imports, so the forms can share
 * the limits the server enforces.
 */

export const DISPLAY_NAME_MAX = 80;

export type DisplayNameResult = { ok: true; value: string } | { ok: false; message: string };

/** Trimmed, inner whitespace collapsed, 1 to 80 characters, no control characters. */
export function validateDisplayName(raw: unknown): DisplayNameResult {
  const value = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (value.length === 0) return { ok: false, message: "Enter a display name." };
  if ([...value].length > DISPLAY_NAME_MAX) return { ok: false, message: `Keep it to ${DISPLAY_NAME_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: "Use letters, numbers and punctuation only." };
  return { ok: true, value };
}

/** Matches the storage bucket's own limit (2 MB) and its allowed types. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type AvatarExtension = (typeof AVATAR_TYPES)[keyof typeof AVATAR_TYPES];

/** The database's check on users.avatar_path, mirrored: <user id>/<random>.<ext>. */
export const AVATAR_PATH_PATTERN = /^[0-9a-f-]{36}\/[a-z0-9]{16,64}\.(jpg|png|webp)$/;

/**
 * What the bytes actually are, by their first bytes, whatever the browser
 * claimed. A file that is none of the three is refused before it is stored.
 */
export function sniffImage(bytes: Uint8Array): AvatarExtension | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export type AvatarCheck = { ok: true; extension: AvatarExtension; contentType: keyof typeof AVATAR_TYPES } | { ok: false; message: string };

export function checkAvatar(size: number, bytes: Uint8Array): AvatarCheck {
  if (size === 0) return { ok: false, message: "Choose a photo first." };
  if (size > AVATAR_MAX_BYTES) return { ok: false, message: "That photo is over 2 MB. Choose a smaller one." };
  const extension = sniffImage(bytes);
  if (!extension) return { ok: false, message: "Use a JPEG, PNG or WebP photo." };
  const contentType = (Object.keys(AVATAR_TYPES) as Array<keyof typeof AVATAR_TYPES>).find((type) => AVATAR_TYPES[type] === extension)!;
  return { ok: true, extension, contentType };
}

/** A fresh object path for a user's photo: a new name every upload, so no cached copy is ever stale. */
export function avatarObjectPath(userId: string, random: string, extension: AvatarExtension): string {
  const path = `${userId.toLowerCase()}/${random.toLowerCase()}.${extension}`;
  if (!AVATAR_PATH_PATTERN.test(path)) throw new Error("Bad avatar path");
  return path;
}

/**
 * The image a member's avatar shows: an uploaded photo through the signed-in
 * redirect route (the bucket is private), else a provider photo URL, else
 * nothing (initials). The version is the object's random name, so a new
 * upload is a new URL.
 */
export function avatarSource(profile: { avatar_path?: string | null; avatar_url?: string | null }): string | null {
  if (profile.avatar_path && AVATAR_PATH_PATTERN.test(profile.avatar_path)) {
    return `/api/me/avatar?v=${encodeURIComponent(profile.avatar_path.split("/")[1])}`;
  }
  return profile.avatar_url ?? null;
}

/** "26 September 2026", in UTC, from parts so no runtime punctuation leaks in. */
export function joinDate(at: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
}

/** Why deletion was refused, in plain words, by the code delete_my_account() returns. */
export const DELETE_REFUSALS: Record<string, string> = {
  open_positions: "You still hold open positions. Sell them from your portfolio first, then come back: deletion keeps the ledger whole, and an open position would be left with nobody to close it.",
  operator: "Operator accounts cannot be deleted from the app.",
  unknown: "This account could not be found. It may already have been deleted.",
  unavailable: "Deletion could not reach the server. Nothing was changed. Try again in a moment.",
  unconfirmed: "Tick the box to confirm.",
};
