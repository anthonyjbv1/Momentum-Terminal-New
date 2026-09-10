import type { Json } from "@/types/database";

/**
 * The canonical behavioral event vocabulary.
 *
 * This constant, not the database, is the source of truth for which
 * event_type values exist. The behavioral_events table only enforces the
 * format (lowercase snake_case), so adding an event type is a one-line change
 * here plus a metadata contract below: no migration.
 *
 * Every event is "user X did <eventType> [to person Y] [with metadata]". The
 * user is always the signed-in user (never client-supplied), the person is a
 * people.id, and metadata is a small JSON object shaped per event type.
 *
 * This module is isomorphic: it runs in the browser (client-side queue) and on
 * the server (route handler, server-side logger). Keep it free of server-only
 * imports.
 */
export const BEHAVIORAL_EVENT_TYPES = [
  "view_person",
  "time_spent",
  "expand_signal",
  "take_position",
  "close_position",
  "follow_person",
  "unfollow_person",
  "search",
  "view_feed",
  "swipe",
  "change_range",
  "view_entry",
  "scroll_depth",
  "filter_change",
] as const;

export type BehavioralEventType = (typeof BEHAVIORAL_EVENT_TYPES)[number];

export const SWIPE_ACTIONS = ["left", "right", "up", "down"] as const;
export type SwipeAction = (typeof SWIPE_ACTIONS)[number];

export interface BehavioralEventDefinition {
  description: string;
  /** Whether personId is mandatory for this event type. */
  requiresPerson: boolean;
  /** The metadata contract, in the shape the frontend should send. */
  metadata: string;
}

/** Documentation + validation rules per event type. */
export const BEHAVIORAL_EVENT_DEFINITIONS: Record<BehavioralEventType, BehavioralEventDefinition> = {
  view_person: {
    description: "Opened a person's profile or card.",
    requiresPerson: true,
    metadata: "{ source?: string }  where the view came from: feed | search | swipe | profile_link | ...",
  },
  time_spent: {
    description: "Dwell time on a person. Coalesced client-side before sending.",
    requiresPerson: true,
    metadata: "{ duration_ms: number (>= 0, integer), surface?: string }",
  },
  expand_signal: {
    description: "Expanded a headline / signal on a person.",
    requiresPerson: true,
    metadata: "{ signal_id?: uuid, headline?: string }",
  },
  take_position: {
    description: "Opened a HIGH or LOW position on a person.",
    requiresPerson: true,
    metadata: "{ direction: 'HIGH' | 'LOW', amount_cents: integer >= 0, position_id?: uuid }",
  },
  close_position: {
    description: "Closed a position on a person.",
    requiresPerson: true,
    metadata: "{ position_id?: uuid, direction?: 'HIGH' | 'LOW', amount_cents?: integer, pnl_cents?: integer }",
  },
  follow_person: {
    description: "Followed a person.",
    requiresPerson: true,
    metadata: "{}",
  },
  unfollow_person: {
    description: "Unfollowed a person.",
    requiresPerson: true,
    metadata: "{}",
  },
  search: {
    description: "Ran a search.",
    requiresPerson: false,
    metadata: "{ query: string (non-empty), result_count?: integer >= 0 }",
  },
  view_feed: {
    description: "Viewed a feed.",
    requiresPerson: false,
    metadata: "{ feed?: string }  e.g. home | trending | for_you",
  },
  swipe: {
    description: "Swiped on a person card.",
    requiresPerson: true,
    metadata: "{ action: 'left' | 'right' | 'up' | 'down' }  ('direction' is accepted as an alias)",
  },
  change_range: {
    description: "Switched the score chart to another time range on a person.",
    requiresPerson: true,
    metadata: "{ range: string (non-empty, e.g. 1h | 24h | 7d | all), surface?: string }",
  },
  view_entry: {
    description: "A feed entry about a person came into view (an impression).",
    requiresPerson: true,
    metadata: "{ entry_id: string (non-empty), kind: 'narrative' | 'signal', feed?: string, position?: integer >= 0, pinned?: boolean }",
  },
  scroll_depth: {
    description: "How far down a feed the user scrolled; logged at milestones.",
    requiresPerson: false,
    metadata: "{ feed: string (non-empty), depth_pct: integer 0..100, entries_seen?: integer >= 0 }",
  },
  filter_change: {
    description: "Changed a filter on a surface (e.g. the category filter on the Feed).",
    requiresPerson: false,
    metadata: "{ surface: string (non-empty), filter: string (non-empty), value: string (non-empty) }",
  },
};

/** Size and rate caps. The database enforces 8 KiB per metadata object; everything else lives here. */
export const BEHAVIORAL_LIMITS = {
  /** Events stored per request. Extra events in a request are dropped and reported. */
  maxBatchSize: 50,
  /** JSON-serialised metadata per event. */
  maxMetadataBytes: 4096,
  /** Keys per metadata object (and items per array). */
  maxMetadataKeys: 32,
  /** Nesting depth of metadata. */
  maxMetadataDepth: 3,
  /** Any string inside metadata is truncated to this many characters. */
  maxStringLength: 512,
  /** Request body size accepted by /api/behavioral/log. */
  maxRequestBytes: 128 * 1024,
  /** time_spent.duration_ms is clamped to this. */
  maxDurationMs: 24 * 60 * 60 * 1000,
  /** Dwell shorter than this is not worth a row. */
  minDwellMs: 500,
  /** Client-side: pending events kept before the oldest are dropped. */
  maxQueueLength: 200,
  /** Client-side: how long to wait for more events before sending. */
  flushDelayMs: 2_000,
  /** Client-side: send immediately once this many events are pending. */
  flushAtSize: 20,
} as const;

/** What screens pass to logEvent / trackEvent. */
export interface BehavioralEventInput {
  eventType: BehavioralEventType;
  personId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Usually omitted: the client queue and the server logger fill it in. */
  sessionId?: string | null;
}

export type BehavioralMetadata = { [key: string]: Json | undefined };

/** An event that passed validation and is ready to be stored. */
export interface ValidatedBehavioralEvent {
  eventType: BehavioralEventType;
  personId: string | null;
  metadata: BehavioralMetadata | null;
  sessionId: string | null;
}

export type BehavioralValidation = { ok: true; event: ValidatedBehavioralEvent } | { ok: false; reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBehavioralEventType(value: unknown): value is BehavioralEventType {
  return typeof value === "string" && (BEHAVIORAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

function readKey(input: Record<string, unknown>, camel: string, snake: string): unknown {
  return input[camel] !== undefined ? input[camel] : input[snake];
}

type MetadataLimits = Pick<typeof BEHAVIORAL_LIMITS, "maxMetadataKeys" | "maxMetadataDepth" | "maxStringLength">;

function sanitizeValue(value: unknown, depth: number, limits: MetadataLimits): Json | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > limits.maxStringLength ? value.slice(0, limits.maxStringLength) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (depth >= limits.maxMetadataDepth) return undefined;
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value.slice(0, limits.maxMetadataKeys)) {
      const clean = sanitizeValue(item, depth + 1, limits);
      if (clean !== undefined) out.push(clean);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= limits.maxMetadataKeys) break;
      const clean = sanitizeValue(item, depth + 1, limits);
      if (clean === undefined) continue;
      out[key.slice(0, 64)] = clean;
      count += 1;
    }
    return out;
  }
  // functions, symbols, bigint, undefined
  return undefined;
}

/**
 * Turns arbitrary caller-supplied metadata into a small, JSON-safe object:
 * drops undefined / functions / non-finite numbers, truncates long strings,
 * caps keys and depth, rejects non-objects and oversized payloads.
 */
export function sanitizeMetadata(
  value: unknown,
  limits: typeof BEHAVIORAL_LIMITS = BEHAVIORAL_LIMITS,
): { ok: true; metadata: BehavioralMetadata | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, metadata: null };
  if (!isPlainObject(value)) return { ok: false, reason: "metadata must be an object" };

  const clean = sanitizeValue(value, 0, limits);
  if (!isPlainObject(clean)) return { ok: false, reason: "metadata must be an object" };
  if (Object.keys(clean).length === 0) return { ok: true, metadata: null };

  if (utf8Length(JSON.stringify(clean)) > limits.maxMetadataBytes) {
    return { ok: false, reason: `metadata exceeds ${limits.maxMetadataBytes} bytes` };
  }
  return { ok: true, metadata: clean as BehavioralMetadata };
}

type TypeCheck = (metadata: BehavioralMetadata | null) => { ok: true; metadata: BehavioralMetadata | null } | { ok: false; reason: string };

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function normalizeDirection(value: unknown): "HIGH" | "LOW" | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return upper === "HIGH" || upper === "LOW" ? upper : null;
}

const TYPE_CHECKS: Partial<Record<BehavioralEventType, TypeCheck>> = {
  time_spent: (metadata) => {
    const raw = metadata?.duration_ms;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return { ok: false, reason: "time_spent requires metadata.duration_ms (number >= 0)" };
    }
    return {
      ok: true,
      metadata: { ...metadata, duration_ms: Math.min(Math.round(raw), BEHAVIORAL_LIMITS.maxDurationMs) },
    };
  },
  take_position: (metadata) => {
    const direction = normalizeDirection(metadata?.direction);
    if (!direction) return { ok: false, reason: "take_position requires metadata.direction (HIGH | LOW)" };
    if (!isNonNegativeInteger(metadata?.amount_cents)) {
      return { ok: false, reason: "take_position requires metadata.amount_cents (integer cents >= 0)" };
    }
    if (metadata?.position_id !== undefined && !isUuid(metadata.position_id)) {
      return { ok: false, reason: "metadata.position_id must be a UUID" };
    }
    return { ok: true, metadata: { ...metadata, direction } };
  },
  close_position: (metadata) => {
    const out: BehavioralMetadata = { ...metadata };
    if (out.direction !== undefined) {
      const direction = normalizeDirection(out.direction);
      if (!direction) return { ok: false, reason: "metadata.direction must be HIGH or LOW" };
      out.direction = direction;
    }
    if (out.position_id !== undefined && !isUuid(out.position_id)) {
      return { ok: false, reason: "metadata.position_id must be a UUID" };
    }
    if (out.amount_cents !== undefined && !isInteger(out.amount_cents)) {
      return { ok: false, reason: "metadata.amount_cents must be an integer" };
    }
    if (out.pnl_cents !== undefined && !isInteger(out.pnl_cents)) {
      return { ok: false, reason: "metadata.pnl_cents must be an integer" };
    }
    return { ok: true, metadata: Object.keys(out).length > 0 ? out : null };
  },
  search: (metadata) => {
    const query = typeof metadata?.query === "string" ? metadata.query.trim() : "";
    if (!query) return { ok: false, reason: "search requires metadata.query (non-empty string)" };
    if (metadata?.result_count !== undefined && !isNonNegativeInteger(metadata.result_count)) {
      return { ok: false, reason: "metadata.result_count must be an integer >= 0" };
    }
    return { ok: true, metadata: { ...metadata, query } };
  },
  swipe: (metadata) => {
    const raw = metadata?.action ?? metadata?.direction;
    const action = typeof raw === "string" ? raw.toLowerCase() : "";
    if (!(SWIPE_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, reason: `swipe requires metadata.action (${SWIPE_ACTIONS.join(" | ")})` };
    }
    const out: BehavioralMetadata = { ...metadata, action };
    delete out.direction;
    return { ok: true, metadata: out };
  },
  expand_signal: (metadata) => {
    if (metadata?.signal_id !== undefined && !isUuid(metadata.signal_id)) {
      return { ok: false, reason: "metadata.signal_id must be a UUID" };
    }
    return { ok: true, metadata };
  },
  change_range: (metadata) => {
    const range = typeof metadata?.range === "string" ? metadata.range.trim().toLowerCase() : "";
    if (!range) return { ok: false, reason: "change_range requires metadata.range (non-empty string)" };
    return { ok: true, metadata: { ...metadata, range } };
  },
  view_entry: (metadata) => {
    const entryId = typeof metadata?.entry_id === "string" ? metadata.entry_id.trim() : "";
    if (!entryId) return { ok: false, reason: "view_entry requires metadata.entry_id (non-empty string)" };
    const kind = typeof metadata?.kind === "string" ? metadata.kind.trim().toLowerCase() : "";
    if (kind !== "narrative" && kind !== "signal") {
      return { ok: false, reason: "view_entry requires metadata.kind (narrative | signal)" };
    }
    if (metadata?.position !== undefined && !isNonNegativeInteger(metadata.position)) {
      return { ok: false, reason: "metadata.position must be an integer >= 0" };
    }
    return { ok: true, metadata: { ...metadata, entry_id: entryId, kind } };
  },
  scroll_depth: (metadata) => {
    const feed = typeof metadata?.feed === "string" ? metadata.feed.trim() : "";
    if (!feed) return { ok: false, reason: "scroll_depth requires metadata.feed (non-empty string)" };
    const depth = metadata?.depth_pct;
    if (!isNonNegativeInteger(depth) || depth > 100) {
      return { ok: false, reason: "scroll_depth requires metadata.depth_pct (integer 0..100)" };
    }
    if (metadata?.entries_seen !== undefined && !isNonNegativeInteger(metadata.entries_seen)) {
      return { ok: false, reason: "metadata.entries_seen must be an integer >= 0" };
    }
    return { ok: true, metadata: { ...metadata, feed } };
  },
  filter_change: (metadata) => {
    const surface = typeof metadata?.surface === "string" ? metadata.surface.trim() : "";
    const filter = typeof metadata?.filter === "string" ? metadata.filter.trim() : "";
    const value = typeof metadata?.value === "string" ? metadata.value.trim() : "";
    if (!surface || !filter || !value) {
      return { ok: false, reason: "filter_change requires metadata.surface, metadata.filter and metadata.value (non-empty strings)" };
    }
    return { ok: true, metadata: { ...metadata, surface, filter, value } };
  },
};

/**
 * Validates one event from ANY source (a screen, the API route body, a server
 * action). Accepts camelCase (eventType, personId, sessionId) and snake_case
 * keys. Never throws. A user id in the input is ignored: the acting user is
 * always taken from the session by the caller.
 */
export function validateBehavioralEvent(input: unknown, defaults: { sessionId?: string | null } = {}): BehavioralValidation {
  if (!isPlainObject(input)) return { ok: false, reason: "event must be an object" };

  const eventType = readKey(input, "eventType", "event_type");
  if (typeof eventType !== "string" || eventType.length === 0) return { ok: false, reason: "eventType is required" };
  if (!isBehavioralEventType(eventType)) {
    return { ok: false, reason: `unknown eventType "${eventType.slice(0, 40)}"` };
  }
  const definition = BEHAVIORAL_EVENT_DEFINITIONS[eventType];

  const rawPerson = readKey(input, "personId", "person_id");
  let personId: string | null = null;
  if (rawPerson !== undefined && rawPerson !== null && rawPerson !== "") {
    if (!isUuid(rawPerson)) return { ok: false, reason: "personId must be a UUID" };
    personId = rawPerson.toLowerCase();
  }
  if (definition.requiresPerson && !personId) {
    return { ok: false, reason: `${eventType} requires personId` };
  }

  const rawSession = readKey(input, "sessionId", "session_id");
  const sessionSource = rawSession !== undefined && rawSession !== null ? rawSession : defaults.sessionId;
  const sessionId = isUuid(sessionSource) ? sessionSource.toLowerCase() : null;

  const sanitized = sanitizeMetadata(input.metadata);
  if (!sanitized.ok) return sanitized;

  const check = TYPE_CHECKS[eventType];
  const checked = check ? check(sanitized.metadata) : { ok: true as const, metadata: sanitized.metadata };
  if (!checked.ok) return checked;

  return { ok: true, event: { eventType, personId, metadata: checked.metadata, sessionId } };
}
