import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { SubmitOutcome } from "../transport/sharedb.js";
import { resolveSectionRef } from "../resolvers/section-ref.js";
import { resolveBlockDestination } from "../resolvers/section-target.js";
import type {
  Block,
  ChecklistItem,
  Geo,
  PlaceData,
  RentalCarEndpoint,
  Section,
  TransitEndpoint,
  TripPlan,
} from "../types.js";
import { isPlaceBlock } from "../types.js";

/**
 * Per-trip mutex — serializes submits against the same trip so concurrent
 * callers can't race each other on the ShareDB version vector. Without this,
 * parallel Promise.all batches of mutations all read the cache at version N
 * simultaneously and submit stale ops that the server rejects as conflicts.
 */
const submitLocks = new Map<string, Promise<unknown>>();

/** Test-only visibility for lock-lifecycle regression coverage. */
export function submitLockCountForTests(): number {
  return submitLocks.size;
}

async function withSubmitLock<T>(
  tripKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = submitLocks.get(tripKey) ?? Promise.resolve();
  // Chain regardless of whether the previous op succeeded or failed —
  // one failed op should not permanently block the queue.
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  submitLocks.set(tripKey, tail);
  void tail.then(() => {
    // A newer queued call may have replaced this tail while it was pending.
    if (submitLocks.get(tripKey) === tail) submitLocks.delete(tripKey);
  });
  return next;
}

/**
 * Submit a JSON0 op array to the server and apply it to the live cache on
 * success. Encapsulates the version handshake so tools don't touch
 * ShareDBClient directly.
 *
 * Rules:
 * - Trip must already be in the cache (caller should have called tripCache.get()).
 * - Per-trip mutex: concurrent calls on the same trip serialize automatically.
 * - Op fails atomically: if submit rejects, the cache is invalidated so the
 *   next read refetches a fresh snapshot from the server.
 * - On success, cache.applyLocalOp() is called with the server-accepted version.
 */
export async function submitOp(
  ctx: AppContext,
  tripKey: string,
  ops: Json0Op[],
): Promise<void> {
  return withSubmitLock(tripKey, async () => {
    await submitLocked(ctx, tripKey, ops);
  });
}

export async function buildAndSubmitOp<T>(
  ctx: AppContext,
  tripKey: string,
  build: (trip: TripPlan) => { ops: Json0Op[]; result: T },
): Promise<T> {
  return withSubmitLock(tripKey, async () => {
    const entry = await ctx.tripCache.getEntry(tripKey);
    const { ops, result } = build(entry.snapshot);
    if (ops.length > 0) await submitLocked(ctx, tripKey, ops);
    return result;
  });
}

async function submitLocked(
  ctx: AppContext,
  tripKey: string,
  ops: Json0Op[],
): Promise<void> {
  const client = ctx.pool.get(tripKey);
  if (!client.isSubscribed) {
    throw new WanderlogError(
      `Trip ${tripKey} is not subscribed — call tripCache.get() first`,
      "not_subscribed",
    );
  }
  try {
    const outcome = await submitWithRateLimitRetry(client, ops);
    if (outcome?.remoteOpObserved) {
      // The server may have transformed our op against the remote change. Since
      // the ack does not include that transformed op, discard the cache only
      // after the ack and rebuild it from a fresh subscription on the next read.
      ctx.tripCache.invalidate(tripKey);
      return;
    }
    ctx.tripCache.applyLocalOp(tripKey, ops, client.version);
  } catch (err) {
    // Any submit failure leaves our cached view possibly inconsistent with
    // the server. Invalidate so the next get() refetches + resubscribes.
    ctx.tripCache.invalidate(tripKey);
    throw err;
  }
}

const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// A rate-limited op (code 4001) is rejected before the server processes it.
// Resubmission is safe only while no remote op has advanced the subscribed
// document; otherwise the caller must discard and rebuild from a fresh snapshot.
async function submitWithRateLimitRetry(
  client: {
    remoteOpGeneration: number;
    submit(ops: Json0Op[]): Promise<SubmitOutcome | void>;
  },
  ops: Json0Op[],
): Promise<SubmitOutcome | void> {
  const startingRemoteOpGeneration = client.remoteOpGeneration;
  const assertRetryIsFresh = () => {
    if (client.remoteOpGeneration !== startingRemoteOpGeneration) {
      throw new WanderlogError(
        "Cannot retry the rate-limited operation because the remote document advanced",
        "stale_rate_limit_retry",
      );
    }
  };
  let attempt = 0;
  for (;;) {
    try {
      return await client.submit(ops);
    } catch (err) {
      const isRateLimit =
        err instanceof WanderlogError && err.code === "rate_limited";
      if (!isRateLimit || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) {
        throw err;
      }
      assertRetryIsFresh();
      await new Promise((r) =>
        setTimeout(r, RATE_LIMIT_RETRY_DELAYS_MS[attempt]),
      );
      assertRetryIsFresh();
      attempt += 1;
    }
  }
}

/** Wanderlog block IDs are 9-digit numeric. Sections use the same format. */
export function generateBlockId(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Build a new custom section matching the shape Wanderlog inserts from its UI.
 * Always type "normal" / mode "placeList" — day sections are managed by update-trip-dates.
 */
export function buildSectionObject(heading: string): Section {
  return {
    id: generateBlockId(),
    type: "normal",
    mode: "placeList",
    heading,
    date: null,
    blocks: [],
    text: { ops: [{ insert: "\n" }] },
    placeMarkerColor: "#3498db",
    placeMarkerIcon: "map-marker",
  };
}

/**
 * Resolves a natural-language section reference to its index and Section object.
 * Resolution order:
 *   1. "places to visit" / "places" → the default placeList section (via findPlacesToVisitSection)
 *   2. Case-insensitive heading match across all sections
 * Returns null when no section matches.
 */
export function findSectionByRef(
  trip: TripPlan,
  ref: string,
): { index: number; section: Section } | null {
  const result = resolveSectionRef(trip, ref);
  return result.kind === "unique" ? result.match : null;
}

export function requireUserId(ctx: AppContext): number {
  if (ctx.userId == null) {
    throw new WanderlogError(
      "User ID not available — auth probe has not completed",
      "no_user_id",
    );
  }
  return ctx.userId;
}

/**
 * Build a newly-inserted place block matching Wanderlog's schema.
 * Based on the shape captured in HAR during real trip-add operations.
 */
export function buildPlaceBlock(
  place: PlaceData,
  userId: number,
  extras: {
    hotel?: {
      checkIn: string;
      checkOut: string;
      travelerNames?: string[];
      confirmationNumber?: string | null;
    };
    startTime?: string;
    endTime?: string;
  } = {},
): Block {
  const base: Record<string, unknown> = {
    id: generateBlockId(),
    type: "place",
    place,
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    imageSize: "small",
    upvotedBy: [],
    travelMode: null,
    attachments: [],
  };
  if (extras.hotel) {
    base.hotel = {
      checkIn: extras.hotel.checkIn,
      checkOut: extras.hotel.checkOut,
      travelerNames: extras.hotel.travelerNames ?? [],
      confirmationNumber: extras.hotel.confirmationNumber ?? null,
    };
  }
  if (extras.startTime) base.startTime = extras.startTime;
  if (extras.endTime) base.endTime = extras.endTime;
  return base as unknown as Block;
}

/**
 * Finds the "Places to visit" section (the default normal+placeList section
 * at the top of every trip). Returns its index in trip.itinerary.sections.
 */
export function findPlacesToVisitSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (
      s.type === "normal" &&
      s.mode === "placeList" &&
      (s.heading === "Places to visit" || s.heading === "")
    ) {
      return { index: i, section: s };
    }
  }
  return null;
}

/** Finds the first hotels-type section in the trip. */
export function findHotelsSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.type === "hotels") return { index: i, section: s };
  }
  return null;
}

/**
 * Finds a day section by ISO date. Returns null if no matching section exists
 * (e.g. the date is outside the trip range).
 */
export function findDaySectionByDate(
  trip: TripPlan,
  isoDate: string,
): { index: number; section: Section } | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.mode === "dayPlan" && s.date === isoDate) {
      return { index: i, section: s };
    }
  }
  return null;
}

/**
 * Returns a search-biasing location for the trip. Tries in order:
 *   1. The first place block with geometry (most specific)
 *   2. The trip's first associated geo (from /api/tripPlans/{key} resources)
 *   3. Null if both are absent
 */
export function findTripCenter(
  trip: TripPlan,
  geos?: Geo[],
): { lat: number; lng: number } | null {
  for (const section of trip.itinerary.sections) {
    for (const block of section.blocks) {
      if (!isPlaceBlock(block)) continue;
      const loc = block.place.geometry?.location;
      if (loc) return loc;
    }
  }
  const first = geos?.[0];
  if (first) return { lat: first.latitude, lng: first.longitude };
  return null;
}

/**
 * Resolves the target section for adding a block — either a specific day
 * or the "Places to visit" list. Shared by add-place, add-note, add-checklist.
 */
export function findTargetSection(
  trip: TripPlan,
  day?: string,
): { index: number; section: Section; label: string } {
  return resolveBlockDestination(trip, { day }, "note");
}

/** Build a note block matching the shape captured from the Wanderlog UI. */
export function buildNoteBlock(userId: number): Record<string, unknown> {
  return {
    id: generateBlockId(),
    type: "note",
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

export function buildTransitBlock(
  type: "ferry" | "bus" | "train",
  userId: number,
  args: {
    carrier: string;
    depart: TransitEndpoint;
    arrive: TransitEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type,
    carrier: args.carrier,
    depart: args.depart,
    arrive: args.arrive,
    addedBy: { type: "user", userId },
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

export function buildRentalCarBlock(
  userId: number,
  args: {
    pickUp: RentalCarEndpoint;
    dropOff: RentalCarEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type: "rentalCar",
    addedBy: { type: "user", userId },
    pickUp: args.pickUp,
    dropOff: args.dropOff,
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

const TRANSIT_SECTION_META: Record<
  "transit" | "rentalCars",
  { heading: string; placeMarkerIcon: string; placeMarkerColor: string }
> = {
  transit: { heading: "Transit", placeMarkerIcon: "subway", placeMarkerColor: "#17b978" },
  rentalCars: { heading: "Rental cars", placeMarkerIcon: "car", placeMarkerColor: "#38a4a6" },
};

/**
 * Build a JSON0 `li` op that places `block` into the section of `sectionType`.
 * Appends to an existing section's blocks, or inserts a new section (block
 * embedded) at the end of itinerary.sections. Resolve-by-type keeps us safe
 * against unstable indices (invariant #6).
 */
export function sectionInsertOp(
  trip: TripPlan,
  sectionType: "transit" | "rentalCars",
  block: Block,
): Json0Op {
  const sections = trip.itinerary.sections;
  const index = sections.findIndex((s) => s.type === sectionType);
  if (index >= 0) {
    return {
      p: ["itinerary", "sections", index, "blocks", sections[index]!.blocks.length],
      li: block,
    };
  }
  const meta = TRANSIT_SECTION_META[sectionType];
  const section = {
    id: generateBlockId(),
    type: sectionType,
    mode: "placeList",
    heading: meta.heading,
    date: null,
    blocks: [block],
    placeMarkerColor: meta.placeMarkerColor,
    placeMarkerIcon: meta.placeMarkerIcon,
    text: { ops: [{ insert: "\n" }] },
  };
  return { p: ["itinerary", "sections", sections.length], li: section };
}

export function validateChronology(
  startLabel: string,
  startDate: string,
  startTime: string,
  endLabel: string,
  endDate: string,
  endTime: string,
): void {
  for (const [label, d] of [
    [`${startLabel}_date`, startDate],
    [`${endLabel}_date`, endDate],
  ] as const) {
    if (!isValidDate(d)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${d}". Use YYYY-MM-DD.`);
    }
  }
  for (const [label, t] of [
    [`${startLabel}_time`, startTime],
    [`${endLabel}_time`, endTime],
  ] as const) {
    if (!TIME_REGEX.test(t)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${t}". Use HH:mm (00:00–23:59).`);
    }
  }
  // Zero-padded ISO "YYYY-MM-DDTHH:mm" sorts chronologically as a string.
  if (`${endDate}T${endTime}` < `${startDate}T${startTime}`) {
    throw new WanderlogValidationError(
      `${endLabel} (${endDate} ${endTime}) must be on or after ${startLabel} (${startDate} ${startTime}).`,
    );
  }
}

/** Resolve a place-name query to full PlaceData, biased to the trip center. */
export async function resolveEndpointPlace(
  ctx: AppContext,
  trip: TripPlan,
  geos: Geo[] | undefined,
  query: string,
): Promise<PlaceData> {
  const center = findTripCenter(trip, geos);
  if (!center) {
    throw new WanderlogValidationError(
      `Cannot resolve "${query}" in "${trip.title}" because no location anchor is available`,
      "This trip has no associated geo and no existing places.",
    );
  }
  const predictions = await ctx.rest.searchPlacesAutocomplete({
    input: query,
    sessionToken: crypto.randomUUID(),
    location: { latitude: center.lat, longitude: center.lng },
    radius: 15000,
  });
  if (predictions.length === 0) {
    throw new WanderlogError(
      `No place found matching "${query}" near ${trip.title}`,
      "place_not_found",
      "Try a more specific name or check the spelling.",
    );
  }
  return ctx.rest.getPlaceDetails(predictions[0]!.place_id);
}

/** Build a checklist block with pre-populated items. */
export function buildChecklistBlock(
  items: string[],
  title: string,
  userId: number,
): Record<string, unknown> {
  const checklistItems: ChecklistItem[] = items.map((text) => ({
    id: generateBlockId(),
    checked: false,
    text: { ops: [{ insert: `${text}\n` }] },
  }));
  return {
    id: generateBlockId(),
    type: "checklist",
    items: checklistItems,
    title,
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

const TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateTimeInputs(startTime?: string, endTime?: string): void {
  if (startTime && !TIME_REGEX.test(startTime)) {
    throw new WanderlogValidationError(
      `Invalid start_time: "${startTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  if (endTime && !TIME_REGEX.test(endTime)) {
    throw new WanderlogValidationError(
      `Invalid end_time: "${endTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  // Format is validated above, so a lexicographic compare on zero-padded HH:mm
  // is equivalent to a chronological compare.
  if (startTime && endTime && startTime >= endTime) {
    throw new WanderlogValidationError(
      `end_time (${endTime}) must be after start_time (${startTime}).`,
    );
  }
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;

  const [year, month, day] = dateStr.split("-").map((s) => parseInt(s, 10));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

export function validateDateRange(startDate: string, endDate: string): void {
  // Both dates are validated as YYYY-MM-DD before this runs, so a
  // lexicographic compare matches chronological order.
  if (startDate > endDate) {
    throw new WanderlogValidationError(
      `end_date (${endDate}) must be on or after start_date (${startDate}).`,
    );
  }
}
