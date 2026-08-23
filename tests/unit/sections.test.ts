import { describe, expect, it } from "vitest";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import {
  resolveSectionRef,
  type SectionRefResult,
} from "../../src/resolvers/section-ref.ts";
import {
  assertCustomSectionMutable,
  buildSectionObject,
  resolveContentTarget,
} from "../../src/tools/section-shared.ts";
import type { Section, TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function fresh(trip: TripPlan): TripPlan {
  return structuredClone(trip);
}

function withCustomSections(...headings: string[]): TripPlan {
  const trip = fresh(checklistTrip);
  for (const [offset, heading] of headings.entries()) {
    trip.itinerary.sections.push({
      ...buildSectionObject(heading),
      id: 900 + offset,
    });
  }
  return trip;
}

function expectUnique(result: SectionRefResult): { index: number; section: Section } {
  expect(result.kind).toBe("unique");
  if (result.kind !== "unique") throw new Error("expected unique section");
  return result.match;
}

describe("buildSectionObject", () => {
  it("builds the wire shape used by a custom place-list section", () => {
    const section = buildSectionObject("Food & Drink");
    expect(section).toMatchObject({
      type: "normal",
      mode: "placeList",
      heading: "Food & Drink",
      date: null,
      blocks: [],
      text: { ops: [{ insert: "\n" }] },
      placeMarkerColor: "#3498db",
      placeMarkerIcon: "map-marker",
    });
    expect(section.id).toBeGreaterThanOrEqual(0);
    expect(section.id).toBeLessThan(1_000_000_000);
  });
});

describe("resolveSectionRef", () => {
  it("resolves a custom heading case-insensitively", () => {
    const result = expectUnique(resolveSectionRef(withCustomSections("Food & Drink"), "food & drink"));
    expect(result.section.heading).toBe("Food & Drink");
  });

  it("resolves the default list through explicit aliases", () => {
    expect(expectUnique(resolveSectionRef(checklistTrip, "places")).section.heading).toBe("Places to visit");
    expect(expectUnique(resolveSectionRef(checklistTrip, "places to visit")).section.heading).toBe("Places to visit");
  });

  it("does not silently choose between duplicate headings", () => {
    const result = resolveSectionRef(withCustomSections("Food", "Food"), "Food");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("supports ordinal disambiguation for duplicate headings", () => {
    const trip = withCustomSections("Food", "Food");
    expect(expectUnique(resolveSectionRef(trip, "2nd Food")).index).toBe(trip.itinerary.sections.length - 1);
    expect(expectUnique(resolveSectionRef(trip, "last Food")).index).toBe(trip.itinerary.sections.length - 1);
  });

  it("returns none for an unknown or out-of-range reference", () => {
    expect(resolveSectionRef(checklistTrip, "Unknown")).toEqual({ kind: "none" });
    expect(resolveSectionRef(withCustomSections("Food"), "2nd Food")).toEqual({ kind: "none" });
  });
});

describe("resolveContentTarget", () => {
  it("preserves existing day targeting", () => {
    const target = resolveContentTarget(checklistTrip, { day: "day 1" });
    expect(target.section.date).toBe("2026-06-01");
  });

  it("targets a custom place-list section", () => {
    const target = resolveContentTarget(withCustomSections("Food"), { section: "Food" });
    expect(target.section.heading).toBe("Food");
    expect(target.label).toBe('section "Food"');
  });

  it("rejects day and section together instead of duplicating a place", () => {
    expect(() => resolveContentTarget(withCustomSections("Food"), {
      day: "day 1",
      section: "Food",
    })).toThrow(/either day or section/i);
  });

  it("rejects ambiguous and non-place-list section targets", () => {
    expect(() => resolveContentTarget(withCustomSections("Food", "Food"), { section: "Food" })).toThrow(/multiple sections/i);
    expect(() => resolveContentTarget(checklistTrip, { section: "Notes" })).toThrow(/cannot contain places/i);
  });
});

describe("assertCustomSectionMutable", () => {
  it("allows custom sections", () => {
    const trip = withCustomSections("Food");
    const match = expectUnique(resolveSectionRef(trip, "Food"));
    expect(() => assertCustomSectionMutable(trip, match)).not.toThrow();
  });

  it("protects day, default, and system sections", () => {
    const trip = fresh(checklistTrip);
    const day = { index: 2, section: trip.itinerary.sections[2]! };
    const places = expectUnique(resolveSectionRef(trip, "places"));
    const hotels: Section = {
      id: 999,
      type: "hotels",
      mode: "placeList",
      heading: "Hotels",
      date: null,
      blocks: [],
    };
    trip.itinerary.sections.push(hotels);

    expect(() => assertCustomSectionMutable(trip, day)).toThrow(/day sections/i);
    expect(() => assertCustomSectionMutable(trip, places)).toThrow(/places to visit/i);
    expect(() => assertCustomSectionMutable(trip, {
      index: trip.itinerary.sections.length - 1,
      section: hotels,
    })).toThrow(/system section|custom place-list/i);
  });

  it("protects text-only and unknown section types by default", () => {
    const trip = fresh(checklistTrip);
    expect(() => assertCustomSectionMutable(trip, {
      index: 0,
      section: trip.itinerary.sections[0]!,
    })).toThrow(/custom place-list/i);
    const unknown: Section = {
      id: 1001,
      type: "futureSystemType",
      mode: "placeList",
      heading: "Future system section",
      date: null,
      blocks: [],
    };
    expect(() => assertCustomSectionMutable(trip, { index: 99, section: unknown })).toThrow(/custom place-list/i);
  });
});

describe("section JSON0 operations", () => {
  it("inserts, renames, and deletes a custom section without touching siblings", () => {
    const original = fresh(checklistTrip);
    const section = buildSectionObject("Food");
    const insertIndex = original.itinerary.sections.length;
    const insert: Json0Op[] = [{ p: ["itinerary", "sections", insertIndex], li: section }];
    const inserted = applyOp(original, insert);
    expect(inserted.itinerary.sections[insertIndex]!.heading).toBe("Food");

    const rename: Json0Op[] = [{
      p: ["itinerary", "sections", insertIndex, "heading"],
      od: "Food",
      oi: "Restaurants",
    }];
    const renamed = applyOp(inserted, rename);
    expect(renamed.itinerary.sections[insertIndex]!.heading).toBe("Restaurants");
    expect(renamed.itinerary.sections[0]).toEqual(original.itinerary.sections[0]);

    const target = renamed.itinerary.sections[insertIndex]!;
    const remove: Json0Op[] = [{ p: ["itinerary", "sections", insertIndex], ld: target }];
    const removed = applyOp(renamed, remove);
    expect(removed.itinerary.sections).toEqual(original.itinerary.sections);
  });
});
