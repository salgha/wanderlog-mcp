import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addExpense } from "../../src/tools/add-expense.ts";
import { addHotel } from "../../src/tools/add-hotel.ts";
import { addJournal } from "../../src/tools/add-journal.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { addSection } from "../../src/tools/add-section.ts";
import { editExpense } from "../../src/tools/edit-expense.ts";
import { editJournal } from "../../src/tools/edit-journal.ts";
import { removeExpense } from "../../src/tools/remove-expense.ts";
import { removeJournal } from "../../src/tools/remove-journal.ts";
import { removePlace } from "../../src/tools/remove-place.ts";
import { buildAndSubmitOp } from "../../src/tools/shared.ts";
import type { TripPlan } from "../../src/types.ts";
import { budgetTrip } from "../fixtures/budget-trip.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";
import { journalTrip } from "../fixtures/journal-trip.ts";

function makeLiveContext(initial: TripPlan): {
  ctx: AppContext;
  snapshot: () => TripPlan;
  submittedOps: Json0Op[][];
} {
  let snapshot = structuredClone(initial);
  const submittedOps: Json0Op[][] = [];
  const client = {
    isSubscribed: true,
    version: 1,
    remoteOpGeneration: 0,
    async submit(ops: Json0Op[]) {
      submittedOps.push(ops);
      this.version += 1;
    },
  };
  const ctx = {
    userId: 555,
    rest: {
      async searchPlacesAutocomplete() {
        return [{ place_id: "resolved-place", description: "Resolved place" }];
      },
      async getPlaceDetails(placeId: string) {
        return {
          name: placeId === "hotel-place" ? "Test Hotel" : "Resolved place",
          place_id: placeId,
          geometry: { location: { lat: 41.4, lng: 2.17 } },
        };
      },
      async getPlacePhotos() {
        return [];
      },
    },
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
  return { ctx, snapshot: () => snapshot, submittedOps };
}

function hotelTrip(): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections.splice(1, 0, {
    id: 150,
    type: "hotels",
    mode: "placeList",
    heading: "Hotels and lodging",
    date: null,
    blocks: [],
  });
  return trip;
}

describe("locked JSON0 path construction", () => {
  it("keeps a hotel in the hotels section when add_section shifts section indices", async () => {
    const trip = hotelTrip();
    const { ctx, snapshot } = makeLiveContext(trip);
    const [hotelResult, sectionResult] = await Promise.all([
      addHotel(ctx, {
        trip_key: trip.key,
        hotel: "Test Hotel",
        check_in: "2026-06-01",
        check_out: "2026-06-02",
      }),
      addSection(ctx, {
        trip_key: trip.key,
        heading: "Food",
        after_section: "Notes",
      }),
    ]);

    expect(hotelResult.isError).toBeUndefined();
    expect(sectionResult.isError).toBeUndefined();
    const current = snapshot();
    expect(current.itinerary.sections.find((section) => section.heading === "Food")?.blocks).toHaveLength(0);
    expect(current.itinerary.sections.find((section) => section.type === "hotels")?.blocks).toHaveLength(1);
  });

  it("assigns successive indices to concurrent expense additions", async () => {
    const { ctx, snapshot, submittedOps } = makeLiveContext(budgetTrip);
    const results = await Promise.all([
      addExpense(ctx, {
        trip_key: budgetTrip.key,
        amount: 10,
        currency: "USD",
        category: "food",
        description: "Concurrent expense A",
        date: "2026-06-01",
      }),
      addExpense(ctx, {
        trip_key: budgetTrip.key,
        amount: 20,
        currency: "USD",
        category: "food",
        description: "Concurrent expense B",
        date: "2026-06-01",
      }),
    ]);

    expect(results.every((result) => result.isError === undefined)).toBe(true);
    expect(submittedOps.map((ops) => ops[0]!.p.at(-1))).toEqual([4, 5]);
    expect(snapshot().itinerary.budget?.expenses).toHaveLength(6);
  });

  it("re-resolves an expense edit after a concurrent expense removal shifts indices", async () => {
    const { ctx, snapshot } = makeLiveContext(budgetTrip);
    const [removeResult, editResult] = await Promise.all([
      removeExpense(ctx, { trip_key: budgetTrip.key, description: "subway" }),
      editExpense(ctx, {
        trip_key: budgetTrip.key,
        description: "museum",
        new_description: "Museum admission",
      }),
    ]);

    expect(removeResult.isError).toBeUndefined();
    expect(editResult.isError).toBeUndefined();
    expect(snapshot().itinerary.budget?.expenses?.map((expense) => expense.description)).toEqual([
      "Lunch at Ichiran Ramen",
      "Dinner at Ichiran Ramen",
      "Museum admission",
    ]);
  });

  it("reports the current trip title after a delayed add_place lookup", async () => {
    const { ctx } = makeLiveContext(checklistTrip);
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    ctx.rest.searchPlacesAutocomplete = async () => {
      lookupStarted();
      await release;
      return [{ place_id: "resolved-place", description: "Resolved place" }];
    };

    const addPromise = addPlace(ctx, {
      trip_key: checklistTrip.key,
      place: "Resolved place",
    });
    await started;
    await buildAndSubmitOp(ctx, checklistTrip.key, (trip) => ({
      ops: [{ p: ["title"], od: trip.title, oi: "Renamed Barcelona trip" }],
      result: undefined,
    }));
    releaseLookup();
    const result = await addPromise;

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('in "Renamed Barcelona trip".');
  });

  it("assigns successive indices to concurrent journal additions", async () => {
    const { ctx, snapshot, submittedOps } = makeLiveContext(journalTrip);
    const results = await Promise.all([
      addJournal(ctx, {
        trip_key: journalTrip.key,
        place: "Ohori",
        title: "Concurrent stop A",
        date: "2026-05-29",
      }),
      addJournal(ctx, {
        trip_key: journalTrip.key,
        place: "Ohori",
        title: "Concurrent stop B",
        date: "2026-05-30",
      }),
    ]);

    expect(results.every((result) => result.isError === undefined)).toBe(true);
    expect(submittedOps.map((ops) => ops[0]!.p.at(-1))).toEqual([3, 4]);
    expect(snapshot().itinerary.journal?.stops).toHaveLength(5);
  });

  it("fails closed when a queued removal deletes the place before add_journal acquires the lock", async () => {
    const { ctx, snapshot, submittedOps } = makeLiveContext(journalTrip);
    const originalGetEntry = ctx.tripCache.getEntry.bind(ctx.tripCache);
    let releaseStaleEntry!: () => void;
    let staleEntryCaptured!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseStaleEntry = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      staleEntryCaptured = resolve;
    });
    let firstGet = true;
    ctx.tripCache.getEntry = async (tripKey: string) => {
      if (!firstGet) return originalGetEntry(tripKey);
      firstGet = false;
      const staleSnapshot = structuredClone(snapshot());
      staleEntryCaptured();
      await release;
      return { snapshot: staleSnapshot, version: 1, geos: [] };
    };

    const addPromise = addJournal(ctx, {
      trip_key: journalTrip.key,
      place: "Ohori",
      title: "Removed place journal stop",
      date: "2026-05-29",
    });
    await captured;
    const removeResult = await removePlace(ctx, {
      trip_key: journalTrip.key,
      place_ref: "Ōhori Park",
    });
    releaseStaleEntry();
    const addResult = await addPromise;

    expect(removeResult.isError).toBeUndefined();
    expect(addResult.isError).toBe(true);
    expect(addResult.content[0]!.text).toContain(
      `"Ohori" isn't a place in "${journalTrip.title}" yet`,
    );
    expect(snapshot().itinerary.sections[0]!.blocks).toHaveLength(0);
    expect(snapshot().itinerary.journal?.stops).toHaveLength(3);
    expect(submittedOps).toHaveLength(1);
  });

  it("re-resolves a journal edit after a concurrent stop removal shifts indices", async () => {
    const { ctx, snapshot } = makeLiveContext(journalTrip);
    const [removeResult, editResult] = await Promise.all([
      removeJournal(ctx, {
        trip_key: journalTrip.key,
        title: "Ganso",
        date: "2026-05-29",
      }),
      editJournal(ctx, {
        trip_key: journalTrip.key,
        title: "Fushimi",
        new_title: "Fushimi at dawn",
      }),
    ]);

    expect(removeResult.isError).toBeUndefined();
    expect(editResult.isError).toBeUndefined();
    expect(snapshot().itinerary.journal?.stops?.map((stop) => stop.title)).toEqual([
      "Fushimi at dawn",
      "Ganso Hakata Mentaiju",
    ]);
  });
});
