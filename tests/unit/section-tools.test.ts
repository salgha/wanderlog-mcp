import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addSection } from "../../src/tools/add-section.ts";
import { deleteSection } from "../../src/tools/delete-section.ts";
import { buildSectionObject } from "../../src/tools/section-shared.ts";
import { updateSection } from "../../src/tools/update-section.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function withCustomSection(heading = "Food"): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections.push({ ...buildSectionObject(heading), id: 900 });
  return trip;
}

function makeFakeContext(trip: TripPlan, submitDelay = 0): { ctx: AppContext; submittedOps: Json0Op[][] } {
  const submittedOps: Json0Op[][] = [];
  let snapshot = structuredClone(trip);
  const ctx = {
    userId: 555,
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          if (submitDelay > 0) await new Promise((resolve) => setTimeout(resolve, submitDelay));
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => ({ snapshot, version: 1, geos: [] }),
      applyLocalOp: (_tripKey: string, ops: Json0Op[]) => {
        snapshot = applyOp(snapshot, ops);
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps };
}

describe("addSection", () => {
  it("appends a distinct named section", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addSection(ctx, { trip_key: checklistTrip.key, heading: "Food" });
    expect(result.isError).toBeUndefined();
    const op = submittedOps[0]![0] as { p: (string | number)[]; li: { heading: string } };
    expect(op.p).toEqual(["itinerary", "sections", checklistTrip.itinerary.sections.length]);
    expect(op.li.heading).toBe("Food");
  });

  it("refuses duplicate headings", async () => {
    const { ctx, submittedOps } = makeFakeContext(withCustomSection());
    const result = await addSection(ctx, { trip_key: checklistTrip.key, heading: "food" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/already exists/i);
    expect(submittedOps).toHaveLength(0);
  });

  it("defensively refuses an empty heading even outside MCP schema validation", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addSection(ctx, { trip_key: checklistTrip.key, heading: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/non-empty/i);
    expect(submittedOps).toHaveLength(0);
  });

  it("rejects headings that collide with ordinal reference syntax", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await addSection(ctx, { trip_key: checklistTrip.key, heading: "2nd Avenue" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/ordinal/i);
    expect(submittedOps).toHaveLength(0);
  });

  it("serializes validation with submit so concurrent duplicate adds cannot both succeed", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip, 20);
    const [first, second] = await Promise.all([
      addSection(ctx, { trip_key: checklistTrip.key, heading: "Food" }),
      addSection(ctx, { trip_key: checklistTrip.key, heading: "Food" }),
    ]);
    expect([first.isError, second.isError].filter(Boolean)).toHaveLength(1);
    expect(submittedOps).toHaveLength(1);
  });
});

describe("updateSection", () => {
  it("renames a custom section with a compare-and-replace op", async () => {
    const { ctx, submittedOps } = makeFakeContext(withCustomSection());
    const result = await updateSection(ctx, {
      trip_key: checklistTrip.key,
      section: "Food",
      heading: "Restaurants",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps[0]![0]).toMatchObject({ od: "Food", oi: "Restaurants" });
  });

  it("protects the default section", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await updateSection(ctx, {
      trip_key: checklistTrip.key,
      section: "places",
      heading: "Ideas",
    });
    expect(result.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });
});

describe("deleteSection", () => {
  it("deletes a custom section using the full stale-value guard", async () => {
    const trip = withCustomSection();
    const { ctx, submittedOps } = makeFakeContext(trip);
    const result = await deleteSection(ctx, { trip_key: checklistTrip.key, section: "Food" });
    expect(result.isError).toBeUndefined();
    const op = submittedOps[0]![0] as { p: (string | number)[]; ld: { heading: string } };
    expect(op.p).toEqual(["itinerary", "sections", trip.itinerary.sections.length - 1]);
    expect(op.ld.heading).toBe("Food");
  });

  it("protects day sections", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    const result = await deleteSection(ctx, { trip_key: checklistTrip.key, section: "Arrival day" });
    expect(result.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });
});
