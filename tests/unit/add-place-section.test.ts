import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { buildSectionObject } from "../../src/tools/section-shared.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function makeContext(): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  calls: { search: number };
  customIndex: number;
} {
  const trip: TripPlan = structuredClone(checklistTrip);
  trip.itinerary.sections.push({ ...buildSectionObject("Food"), id: 900 });
  const customIndex = trip.itinerary.sections.length - 1;
  const submittedOps: Json0Op[][] = [];
  const calls = { search: 0 };
  const entry = { snapshot: trip, version: 1, geos: [] };

  const ctx = {
    userId: 555,
    rest: {
      async searchPlacesAutocomplete() {
        calls.search += 1;
        return [{ place_id: "candidate", description: "Cafe" }];
      },
      async getPlaceDetails() {
        return {
          name: "Test Cafe",
          place_id: "candidate",
          geometry: { location: { lat: 41.4, lng: 2.1 } },
        };
      },
      async getPlacePhotos() {
        return ["photo-key"];
      },
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: () => {},
      invalidate: () => {},
    },
  } as unknown as AppContext;

  return { ctx, submittedOps, calls, customIndex };
}

describe("addPlace custom-section targeting", () => {
  it("inserts one place into the named custom section with image keys", async () => {
    const { ctx, submittedOps, customIndex } = makeContext();
    const result = await addPlace(ctx, {
      trip_key: checklistTrip.key,
      place: "Test Cafe",
      section: "Food",
      note: "Order the flat white",
      start_time: "09:00",
      end_time: "10:00",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('section "Food"');
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]![0]).toMatchObject({
      p: ["itinerary", "sections", customIndex, "blocks", 0],
      li: { type: "place" },
    });
    expect(submittedOps[0]![1]).toEqual({
      p: ["itinerary", "sections", customIndex, "blocks", 0, "imageKeys"],
      oi: ["photo-key"],
    });
    expect(submittedOps[0]![2]).toMatchObject({
      p: ["itinerary", "sections", customIndex, "blocks", 0, "text"],
      t: "rich-text",
    });
    expect(submittedOps[0]![3]).toEqual({
      p: ["itinerary", "sections", customIndex, "blocks", 0, "startTime"],
      oi: "09:00",
    });
    expect(submittedOps[0]![4]).toEqual({
      p: ["itinerary", "sections", customIndex, "blocks", 0, "endTime"],
      oi: "10:00",
    });
  });

  it("rejects day plus section before making a place lookup", async () => {
    const { ctx, submittedOps, calls } = makeContext();
    const result = await addPlace(ctx, {
      trip_key: checklistTrip.key,
      place: "Test Cafe",
      day: "day 1",
      section: "Food",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/either day or section/i);
    expect(calls.search).toBe(0);
    expect(submittedOps).toHaveLength(0);
  });
});
