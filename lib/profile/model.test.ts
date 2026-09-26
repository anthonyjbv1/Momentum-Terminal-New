import { describe, expect, it } from "vitest";

import { copyViolations } from "@/lib/copy-rules";

import {
  AVATAR_MAX_BYTES,
  AVATAR_PATH_PATTERN,
  DELETE_REFUSALS,
  avatarObjectPath,
  avatarSource,
  checkAvatar,
  joinDate,
  sniffImage,
  validateDisplayName,
} from "./model";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")]);
const GIF = new Uint8Array([...Buffer.from("GIF89a")]);
const SVG = new Uint8Array([...Buffer.from("<svg xmlns=")]);
const UID = "0f8e6f0c-1234-4abc-9def-0123456789ab";

describe("display name", () => {
  it("trims, collapses spaces and keeps within 80 characters", () => {
    expect(validateDisplayName("  Ada   Lovelace ")).toEqual({ ok: true, value: "Ada Lovelace" });
    expect(validateDisplayName("")).toMatchObject({ ok: false });
    expect(validateDisplayName("   ")).toMatchObject({ ok: false });
    expect(validateDisplayName("x".repeat(80))).toMatchObject({ ok: true });
    expect(validateDisplayName("x".repeat(81))).toMatchObject({ ok: false });
    expect(validateDisplayName(null)).toMatchObject({ ok: false });
  });
});

describe("photo", () => {
  it("knows a JPEG, a PNG and a WebP by their bytes, and nothing else", () => {
    expect(sniffImage(JPEG)).toBe("jpg");
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(GIF)).toBeNull();
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("refuses empty, oversized and disguised files", () => {
    expect(checkAvatar(0, JPEG)).toMatchObject({ ok: false });
    expect(checkAvatar(AVATAR_MAX_BYTES + 1, JPEG)).toMatchObject({ ok: false });
    expect(checkAvatar(100, SVG)).toMatchObject({ ok: false });
    expect(checkAvatar(AVATAR_MAX_BYTES, PNG)).toEqual({ ok: true, extension: "png", contentType: "image/png" });
  });

  it("stores under the owner's folder with a fresh random name the database accepts", () => {
    const path = avatarObjectPath(UID, "a1b2c3d4e5f6a7b8", "webp");
    expect(path).toBe(`${UID}/a1b2c3d4e5f6a7b8.webp`);
    expect(AVATAR_PATH_PATTERN.test(path)).toBe(true);
    expect(() => avatarObjectPath("../etc", "a1b2c3d4e5f6a7b8", "jpg")).toThrow();
    expect(() => avatarObjectPath(UID, "short", "jpg")).toThrow();
  });

  it("shows an uploaded photo through the signed-in route, else a provider photo, else initials", () => {
    expect(avatarSource({ avatar_path: `${UID}/a1b2c3d4e5f6a7b8.jpg`, avatar_url: "https://x/y.png" })).toBe("/api/me/avatar?v=a1b2c3d4e5f6a7b8.jpg");
    expect(avatarSource({ avatar_path: null, avatar_url: "https://x/y.png" })).toBe("https://x/y.png");
    expect(avatarSource({})).toBeNull();
  });
});

describe("profile words", () => {
  it("dates a join in words", () => {
    expect(joinDate("2026-09-26T23:30:00Z")).toBe("26 September 2026");
  });

  it("explains every deletion refusal without breaking the house rules", () => {
    for (const code of ["open_positions", "operator", "unknown", "unavailable", "unconfirmed"]) expect(DELETE_REFUSALS[code]).toBeTruthy();
    expect(Object.values(DELETE_REFUSALS).flatMap((line) => copyViolations(line))).toEqual([]);
  });
});
