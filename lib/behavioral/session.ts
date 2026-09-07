/**
 * Browsing-session grouping for behavioral events.
 *
 * Design: the CLIENT generates a UUID and keeps it in a plain (non-HttpOnly)
 * session cookie, `mt_bsid`, whose value is `<uuid>.<lastActiveMs>`.
 *
 *   * Session cookie (no Max-Age): it disappears when the browser closes.
 *   * Idle rollover: if the last activity is more than 30 minutes old, a new
 *     id is minted. So "session" means what analytics usually means by it.
 *   * Shared across tabs: two tabs of the same visit are one session, which
 *     is the right grouping for sequence-based recommendations.
 *   * Readable on the server: Server Actions and Route Handlers see the same
 *     cookie, so events logged server-side (a trade) land in the same session
 *     as the clicks that led to it, without the client passing anything.
 *
 * It was chosen over sessionStorage (per tab, invisible to the server) and
 * over a server-issued token (an extra round trip and server state for no
 * gain: nothing is authorised by this id, it is only a grouping key, and the
 * server never trusts it for anything else).
 *
 * This module is isomorphic; only getBehavioralSessionId() touches the DOM.
 */

export const BEHAVIORAL_SESSION_COOKIE = "mt_bsid";
export const BEHAVIORAL_SESSION_IDLE_MS = 30 * 60 * 1000;
/** Rewrite the cookie's activity stamp at most this often, to avoid churn. */
export const BEHAVIORAL_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export interface ParsedSessionCookie {
  id: string;
  lastActiveAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSessionCookie(value: string | null | undefined): ParsedSessionCookie | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;
  const id = value.slice(0, dot).toLowerCase();
  const lastActiveAt = Number(value.slice(dot + 1));
  if (!UUID_PATTERN.test(id) || !Number.isFinite(lastActiveAt) || lastActiveAt < 0) return null;
  return { id, lastActiveAt };
}

export function serializeSessionCookie(session: ParsedSessionCookie): string {
  return `${session.id}.${Math.floor(session.lastActiveAt)}`;
}

export function isSessionFresh(session: ParsedSessionCookie, now: number, idleMs = BEHAVIORAL_SESSION_IDLE_MS): boolean {
  return now - session.lastActiveAt <= idleMs;
}

/**
 * For server code: the session id carried by an mt_bsid cookie value, or null
 * when the cookie is missing, malformed or idle-expired.
 */
export function sessionIdFromCookieValue(value: string | null | undefined, now: number = Date.now()): string | null {
  const session = parseSessionCookie(value);
  return session && isSessionFresh(session, now) ? session.id : null;
}

/** Cryptographically random v4 UUID, with a fallback for old runtimes. */
export function generateUuid(): string {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Tracker (pure; the browser adapter is below)
// ---------------------------------------------------------------------------

export interface SessionCookieStore {
  read(): string | null;
  write(value: string): void;
}

export interface SessionTrackerOptions {
  cookies: SessionCookieStore;
  now?: () => number;
  idleMs?: number;
  touchIntervalMs?: number;
  randomUUID?: () => string;
}

export interface SessionTracker {
  /** Current session id, minting a new one when none exists or it went idle. Also records activity. */
  getSessionId(): string;
  /** Forces a new session id (e.g. on sign-out). */
  reset(): string;
}

export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const { cookies } = options;
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? BEHAVIORAL_SESSION_IDLE_MS;
  const touchIntervalMs = options.touchIntervalMs ?? BEHAVIORAL_SESSION_TOUCH_INTERVAL_MS;
  const randomUUID = options.randomUUID ?? generateUuid;

  // Last value we know is in the cookie, so a blocked cookie jar still yields a stable id.
  let memory: ParsedSessionCookie | null = null;

  const persist = (session: ParsedSessionCookie) => {
    memory = session;
    try {
      cookies.write(serializeSessionCookie(session));
    } catch {
      // Cookies blocked: the in-memory copy keeps the id stable for this page.
    }
  };

  const start = (at: number): string => {
    const session = { id: randomUUID(), lastActiveAt: at };
    persist(session);
    return session.id;
  };

  return {
    getSessionId() {
      const at = now();
      let current: ParsedSessionCookie | null = null;
      try {
        current = parseSessionCookie(cookies.read());
      } catch {
        current = null;
      }
      current = current ?? memory;
      if (!current || !isSessionFresh(current, at, idleMs)) return start(at);
      if (at - current.lastActiveAt >= touchIntervalMs) persist({ id: current.id, lastActiveAt: at });
      else memory = current;
      return current.id;
    },
    reset() {
      return start(now());
    },
  };
}

// ---------------------------------------------------------------------------
// Browser adapter
// ---------------------------------------------------------------------------

export function createBrowserCookieStore(name = BEHAVIORAL_SESSION_COOKIE): SessionCookieStore | null {
  if (typeof document === "undefined") return null;
  return {
    read() {
      const prefix = `${name}=`;
      for (const part of document.cookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
      }
      return null;
    },
    write(value) {
      const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${secure}`;
    },
  };
}

let browserTracker: SessionTracker | null = null;

/**
 * The browser's current behavioral session id (minting one if needed), or
 * null outside a browser. The client queue calls this for every event.
 */
export function getBehavioralSessionId(): string | null {
  const cookies = createBrowserCookieStore();
  if (!cookies) return null;
  if (!browserTracker) browserTracker = createSessionTracker({ cookies });
  try {
    return browserTracker.getSessionId();
  } catch {
    return null;
  }
}

/** Starts a fresh session in the browser (call on sign-out). No-op on the server. */
export function resetBehavioralSession(): void {
  const cookies = createBrowserCookieStore();
  if (!cookies) return;
  if (!browserTracker) browserTracker = createSessionTracker({ cookies });
  try {
    browserTracker.reset();
  } catch {
    // ignore
  }
}
