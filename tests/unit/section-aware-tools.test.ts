import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addChecklist } from "../../src/tools/add-checklist.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { annotatePlace } from "../../src/tools/annotate-place.ts";
import { editNote } from "../../src/tools/edit-note.ts";
import { removeNote } from "../../src/tools/remove-note.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function scopedTrip(): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections.push(
    {
      id: 900,
      type: "normal",
      mode: "placeList",
      heading: "Plan: Major Stops",
      date: null,
      blocks: [
        { id: 901, type: "note", text: { ops: [{ insert: "Shared planning note\n" }] } },
        {
          id: 902,
          type: "place",
          place: { name: "Duplicate Cafe", place_id: "plan-cafe" },
          text: { ops: [{ insert: "Old plan annotation\n" }] },
        },
      ],
    },
    {
      id: 910,
      type: "normal",
      mode: "placeList",
      heading: "Other Ideas",
      date: null,
      blocks: [
        { id: 911, type: "note", text: { ops: [{ insert: "Shared planning note\n" }] } },
        {
          id: 912,
          type: "place",
          place: { name: "Duplicate Cafe", place_id: "other-cafe" },
          text: { ops: [{ insert: "Old other annotation\n" }] },
        },
      ],
    },
  );
  return trip;
}

function makeContext(initial: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  snapshot: () => TripPlan;
} {
  let snapshot = structuredClone(initial);
  const submittedOps: Json0Op[][] = [];
  const client = {
    isSubscribed: true,
    version: 1,
    async submit(ops: Json0Op[]) {
      submittedOps.push(ops);
      this.version += 1;
    },
  };
  const ctx = {
    userId: 555,
    pool: { get: () => client },
    tripCache: {
      get: async () => snapshot,
      getEntry: async () => ({ snapshot, version: client.version, geos: [] }),
      applyLocalOp: (_tripKey: string, ops: Json0Op[]) => {
        snapshot = applyOp(snapshot, ops);
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submittedOps, snapshot: () => snapshot };
}

const planIndex = (trip: TripPlan) => trip.itinerary.sections.findIndex((s) => s.heading === "Plan: Major Stops");

describe("section-aware add tools", () => {
  it("adds a note atomically to a named section", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps, snapshot } = makeContext(trip);
    const result = await addNote(ctx, {
      trip_key: trip.key,
      text: "Section-specific note",
      section: "Plan: Major Stops",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
    const blocks = snapshot().itinerary.sections[planIndex(trip)]!.blocks;
    expect(blocks.at(-1)?.type).toBe("note");
  });

  it("serializes concurrent note additions and resolves each index from the updated snapshot", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps, snapshot } = makeContext(trip);
    const initialLength = trip.itinerary.sections[planIndex(trip)]!.blocks.length;

    const results = await Promise.all([
      addNote(ctx, {
        trip_key: trip.key,
        text: "Concurrent note A",
        section: "Plan: Major Stops",
      }),
      addNote(ctx, {
        trip_key: trip.key,
        text: "Concurrent note B",
        section: "Plan: Major Stops",
      }),
    ]);

    expect(results.every((result) => result.isError === undefined)).toBe(true);
    expect(submittedOps).toHaveLength(2);
    expect(submittedOps.map((ops) => ops[0]!.p.at(-1))).toEqual([
      initialLength,
      initialLength + 1,
    ]);
    const blocks = snapshot().itinerary.sections[planIndex(trip)]!.blocks;
    expect(blocks).toHaveLength(initialLength + 2);
  });

  it("adds a checklist to a named section", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps, snapshot } = makeContext(trip);
    const result = await addChecklist(ctx, {
      trip_key: trip.key,
      title: "Research",
      items: ["Verify route"],
      section: "Plan: Major Stops",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(snapshot().itinerary.sections[planIndex(trip)]!.blocks.at(-1)?.type).toBe("checklist");
  });
});

describe("section-aware edit and remove tools", () => {
  it("edits only the matching note inside the selected section", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps } = makeContext(trip);
    const result = await editNote(ctx, {
      trip_key: trip.key,
      old_text: "Shared planning note",
      new_text: "Plan-only replacement",
      section: "Plan: Major Stops",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]![0]!.p).toContain(planIndex(trip));
  });

  it("removes only the matching note inside the selected section", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps, snapshot } = makeContext(trip);
    const result = await removeNote(ctx, {
      trip_key: trip.key,
      text: "Shared planning note",
      section: "Plan: Major Stops",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(snapshot().itinerary.sections[planIndex(trip)]!.blocks.some((b) => b.id === 901)).toBe(false);
    expect(snapshot().itinerary.sections.some((s) => s.blocks.some((b) => b.id === 911))).toBe(true);
  });
});

describe("section-aware place annotation", () => {
  it("uses section scope to disambiguate duplicate place names and replaces the annotation atomically", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps, snapshot } = makeContext(trip);
    const result = await annotatePlace(ctx, {
      trip_key: trip.key,
      place: "Duplicate Cafe",
      section: "Plan: Major Stops",
      note: "Updated plan annotation",
      start_time: "09:00",
    });
    expect(result.isError).toBeUndefined();
    expect(submittedOps).toHaveLength(1);
    expect(submittedOps[0]).toHaveLength(2);
    expect(submittedOps[0]![0]!.p).toContain(planIndex(trip));
    const updated = snapshot().itinerary.sections[planIndex(trip)]!.blocks.find(
      (block) => block.id === 902,
    );
    expect(updated?.text?.ops).toEqual([{ insert: "Updated plan annotation\n" }]);
  });

  it("rejects day and section together without mutation", async () => {
    const trip = scopedTrip();
    const { ctx, submittedOps } = makeContext(trip);
    const result = await annotatePlace(ctx, {
      trip_key: trip.key,
      place: "Duplicate Cafe",
      day: "day 1",
      section: "Plan: Major Stops",
      note: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/either day or section/i);
    expect(submittedOps).toHaveLength(0);
  });
});
