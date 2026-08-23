import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { PlaceData } from "../types.js";
import { resolveBlockDestination } from "../resolvers/section-target.js";
import {
  buildAndSubmitOp,
  buildPlaceBlock,
  findTripCenter,
  requireUserId,
  validateTimeInputs,
} from "./shared.js";

export const addPlaceInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add to. Use wanderlog_list_trips if you don't know the key."),
  place: z
    .string()
    .min(1)
    .describe(
      "Name of the place to add. Examples: 'Sensō-ji', 'a ramen place in Shinjuku', 'Louvre'. Will be matched against Google Places near the trip's destination; if multiple match, the top result is used.",
    ),
  day: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional day to add the place to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to add the place to the trip's 'Places to visit' list (unscheduled).",
    ),
  section: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional custom place-list section identified by its heading (e.g. 'Food & Drink'). Cannot be combined with day. Duplicate headings require an ordinal such as '2nd Food'.",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "Optional inline note attached directly to this place. Use for practical context: transit directions, what to order, booking tips, time guidance. Appears on the place itself in Wanderlog (not as a separate note block).",
    ),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional start time in HH:mm format (e.g. '09:00'). Adds a scheduled time to the place."),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional end time in HH:mm format (e.g. '11:30'). Only used with start_time."),
};

export const addPlaceDescription = `
Adds a place to a Wanderlog trip. Searches for the place near the trip's destination, picks the
best match, and inserts it into one destination: a specific day, a named custom section, or the
general "Places to visit" list. Day and section are mutually exclusive.

PREFERRED: Use the "note" parameter to attach practical context directly to each place — transit
directions, what to order, booking tips, time guidance. This is better than a separate
wanderlog_add_note call because the note lives on the place itself in the itinerary. Use the
"start_time" and "end_time" parameters to give the place a scheduled time window.

Use standalone wanderlog_add_note only for freestanding commentary between places (neighborhood
context, multi-stop transit, day-level tips that aren't about a specific place).

Returns a confirmation including the resolved place name and where it was added.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  day?: string;
  section?: string;
  note?: string;
  start_time?: string;
  end_time?: string;
};

export async function addPlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    validateTimeInputs(args.start_time, args.end_time);
    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;

    // Validate the requested destination before making external place lookups.
    // It is resolved again after those lookups because section indices can shift.
    resolveBlockDestination(trip, { day: args.day, section: args.section }, "place");

    const center = findTripCenter(trip, entry.geos);
    if (!center) {
      throw new WanderlogValidationError(
        `Cannot add places to "${trip.title}" because no location anchor is available`,
        "This trip has no associated geo and no existing places. Add a place via the Wanderlog UI first.",
      );
    }
    const predictions = await ctx.rest.searchPlacesAutocomplete({
      input: args.place,
      sessionToken: crypto.randomUUID(),
      location: { latitude: center.lat, longitude: center.lng },
      radius: 15000,
    });
    if (predictions.length === 0) {
      throw new WanderlogError(
        `No place found matching "${args.place}" near ${trip.title}`,
        "place_not_found",
        {
          hint: "Try a more specific name, or widen the search with wanderlog_search_places first.",
          followUps: [
            `Call wanderlog_search_places with trip_key "${args.trip_key}" and a broader query to see nearby candidates.`,
            "Retry wanderlog_add_place with a more specific place name (include the city or neighborhood).",
          ],
        },
      );
    }
    const topPrediction = predictions[0]!;
    const detail: PlaceData = await ctx.rest.getPlaceDetails(topPrediction.place_id);
    const imageKeys = await ctx.rest.getPlacePhotos(detail);

    const block = buildPlaceBlock(detail, userId);
    const destination = await buildAndSubmitOp(ctx, args.trip_key, (currentTrip) => {
      const target = resolveBlockDestination(currentTrip, {
        day: args.day,
        section: args.section,
      }, "place");
      const insertIndex = target.section.blocks.length;
      const blockPath = ["itinerary", "sections", target.index, "blocks", insertIndex];
      const ops: Json0Op[] = [{ p: blockPath, li: block }];

      if (imageKeys.length > 0) {
        ops.push({ p: [...blockPath, "imageKeys"], oi: imageKeys });
      }
      if (args.note) {
        ops.push({
          p: [...blockPath, "text"],
          t: "rich-text",
          o: [{ insert: `${args.note}\n` }],
        });
      }
      if (args.start_time) {
        ops.push({ p: [...blockPath, "startTime"], oi: args.start_time });
      }
      if (args.end_time) {
        ops.push({ p: [...blockPath, "endTime"], oi: args.end_time });
      }
      return {
        ops,
        result: { label: target.label, tripTitle: currentTrip.title },
      };
    });

    const parts = [`Added ${detail.name} to ${destination.label} in "${destination.tripTitle}".`];
    if (args.start_time) {
      parts.push(`Scheduled: ${args.start_time}${args.end_time ? `–${args.end_time}` : ""}.`);
    }
    if (args.note) {
      const preview = args.note.length > 60 ? `${args.note.slice(0, 57)}…` : args.note;
      parts.push(`Note: "${preview}"`);
    }
    const text = parts.join(" ");
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

