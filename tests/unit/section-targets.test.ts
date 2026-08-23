import { describe, expect, it } from "vitest";
import {
  resolveBlockDestination,
  resolveSectionScope,
} from "../../src/resolvers/section-target.ts";
import type { TripPlan } from "../../src/types.ts";
import { addChecklistInputSchema } from "../../src/tools/add-checklist.ts";
import { addNoteInputSchema } from "../../src/tools/add-note.ts";
import { addPlaceInputSchema } from "../../src/tools/add-place.ts";
import { annotatePlaceInputSchema } from "../../src/tools/annotate-place.ts";
import { editNoteInputSchema } from "../../src/tools/edit-note.ts";
import { removeNoteInputSchema } from "../../src/tools/remove-note.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

function tripWithSections(): TripPlan {
  const trip = structuredClone(checklistTrip);
  trip.itinerary.sections.push(
    {
      id: 900,
      type: "normal",
      mode: "placeList",
      heading: "Plan: Major Stops",
      date: null,
      blocks: [],
    },
    {
      id: 901,
      type: "textOnly",
      mode: "placeList",
      heading: "Research Notes",
      date: null,
      blocks: [],
    },
    {
      id: 902,
      type: "hotels",
      mode: "placeList",
      heading: "Hotels",
      date: null,
      blocks: [],
    },
  );
  return trip;
}

function schemaShape(schema: unknown): Record<string, unknown> {
  if (typeof schema === "object" && schema !== null && "shape" in schema) {
    return (schema as { shape: Record<string, unknown> }).shape;
  }
  return schema as Record<string, unknown>;
}

describe("tool schemas", () => {
  it("exposes section targeting on all requested tools", () => {
    for (const schema of [
      addPlaceInputSchema,
      addNoteInputSchema,
      addChecklistInputSchema,
      editNoteInputSchema,
      removeNoteInputSchema,
      annotatePlaceInputSchema,
    ]) {
      expect(schemaShape(schema)).toHaveProperty("section");
    }
  });

  it("rejects explicit blank day selectors instead of treating them as unscoped", () => {
    for (const schema of [
      addPlaceInputSchema,
      addNoteInputSchema,
      addChecklistInputSchema,
      editNoteInputSchema,
      removeNoteInputSchema,
      annotatePlaceInputSchema,
    ]) {
      const day = schemaShape(schema).day as {
        safeParse(value: unknown): { success: boolean };
      };
      expect(day.safeParse("   ").success).toBe(false);
    }
  });
});

describe("resolveBlockDestination", () => {
  it("preserves the default list and day destinations", () => {
    const trip = tripWithSections();
    expect(resolveBlockDestination(trip, {}, "place").section.heading).toBe("Places to visit");
    expect(resolveBlockDestination(trip, { day: "day 1" }, "note").section.date).toBe("2026-06-01");
  });

  it("resolves named custom sections for places, notes, and checklists", () => {
    const trip = tripWithSections();
    for (const kind of ["place", "note", "checklist"] as const) {
      const target = resolveBlockDestination(trip, { section: "Plan: Major Stops" }, kind);
      expect(target.section.heading).toBe("Plan: Major Stops");
      expect(target.label).toBe('section "Plan: Major Stops"');
    }
  });

  it("allows notes and checklists, but not places, in text-only sections", () => {
    const trip = tripWithSections();
    expect(resolveBlockDestination(trip, { section: "Research Notes" }, "note").section.type).toBe("textOnly");
    expect(resolveBlockDestination(trip, { section: "Research Notes" }, "checklist").section.type).toBe("textOnly");
    expect(() => resolveBlockDestination(trip, { section: "Research Notes" }, "place")).toThrow(/cannot contain places/i);
  });

  it("rejects system sections and mutually exclusive selectors", () => {
    const trip = tripWithSections();
    expect(() => resolveBlockDestination(trip, { section: "Hotels" }, "note")).toThrow(/cannot contain itinerary content/i);
    expect(() => resolveBlockDestination(trip, {
      day: "day 1",
      section: "Plan: Major Stops",
    }, "note")).toThrow(/either day or section/i);
  });
});

describe("resolveSectionScope", () => {
  it("returns all section indices when unscoped", () => {
    const trip = tripWithSections();
    expect(resolveSectionScope(trip, {}).indices).toEqual(
      Array.from({ length: trip.itinerary.sections.length }, (_, index) => index),
    );
  });

  it("returns exactly one day or named section", () => {
    const trip = tripWithSections();
    const day = resolveSectionScope(trip, { day: "day 2" });
    expect(day.indices).toHaveLength(1);
    expect(trip.itinerary.sections[day.indices[0]!]!.date).toBe("2026-06-02");

    const section = resolveSectionScope(trip, { section: "Plan: Major Stops" });
    expect(section.indices).toHaveLength(1);
    expect(trip.itinerary.sections[section.indices[0]!]!.heading).toBe("Plan: Major Stops");
  });

  it("rejects day and section together", () => {
    expect(() => resolveSectionScope(tripWithSections(), {
      day: "day 1",
      section: "Plan: Major Stops",
    })).toThrow(/either day or section/i);
  });
});
