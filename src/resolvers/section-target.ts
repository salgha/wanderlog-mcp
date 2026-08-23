import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Section, TripPlan } from "../types.js";
import { resolveDay } from "./day.js";
import { resolveSectionRef, type SectionRefMatch } from "./section-ref.js";

export type SectionSelector = {
  day?: string;
  section?: string;
};

export type BlockKind = "place" | "note" | "checklist";

export type BlockDestination = {
  index: number;
  section: Section;
  label: string;
};

export type SectionScope = {
  indices: number[];
  label: string;
};

export function requireSectionRef(trip: TripPlan, ref: string): SectionRefMatch {
  const result = resolveSectionRef(trip, ref);
  if (result.kind === "none") {
    throw new WanderlogValidationError(
      `Section "${ref}" not found in trip "${trip.title}"`,
      "Use wanderlog_get_trip to review the current section headings.",
    );
  }
  if (result.kind === "ambiguous") {
    throw new WanderlogValidationError(
      `Multiple sections match "${ref}" in trip "${trip.title}"`,
      `Use an ordinal reference such as "1st ${ref}", "2nd ${ref}", or "last ${ref}".`,
    );
  }
  return result.match;
}

export function resolveBlockDestination(
  trip: TripPlan,
  selector: SectionSelector,
  kind: BlockKind,
): BlockDestination {
  assertExclusiveSelector(selector);

  if (selector.day) {
    const section = resolveDay(trip, selector.day);
    const index = trip.itinerary.sections.indexOf(section);
    if (index < 0) throw new WanderlogValidationError(`Day ${selector.day} not found in trip`);
    return { index, section, label: `day ${section.date}` };
  }

  if (selector.section) {
    const match = requireSectionRef(trip, selector.section);
    assertSectionAcceptsBlock(match.section, kind, selector.section);
    return {
      index: match.index,
      section: match.section,
      label: `section "${match.section.heading || selector.section}"`,
    };
  }

  const match = findDefaultPlaceList(trip);
  if (!match) {
    throw new WanderlogError(
      "Trip has no 'Places to visit' list",
      "no_places_section",
      "This is unexpected — Wanderlog usually creates one automatically. Try a specific day or section instead.",
    );
  }
  return { ...match, label: "places to visit" };
}

export function resolveSectionScope(
  trip: TripPlan,
  selector: SectionSelector,
): SectionScope {
  assertExclusiveSelector(selector);
  if (selector.day) {
    const section = resolveDay(trip, selector.day);
    const index = trip.itinerary.sections.indexOf(section);
    if (index < 0) throw new WanderlogValidationError(`Day ${selector.day} not found in trip`);
    return { indices: [index], label: `day ${section.date}` };
  }
  if (selector.section) {
    const match = requireSectionRef(trip, selector.section);
    return {
      indices: [match.index],
      label: `section "${match.section.heading || selector.section}"`,
    };
  }
  return {
    indices: Array.from({ length: trip.itinerary.sections.length }, (_, index) => index),
    label: "the trip",
  };
}

function assertExclusiveSelector(selector: SectionSelector): void {
  if (selector.day && selector.section) {
    throw new WanderlogValidationError(
      "Choose either day or section, not both",
      "Make separate calls if you intentionally want to target two locations.",
    );
  }
}

function assertSectionAcceptsBlock(section: Section, kind: BlockKind, ref: string): void {
  if (section.mode === "dayPlan") {
    throw new WanderlogValidationError(
      `Section reference "${ref}" points to a trip day`,
      "Use the day parameter for dated itinerary sections.",
    );
  }
  if (kind === "place") {
    if (section.type !== "normal" || section.mode !== "placeList") {
      throw new WanderlogValidationError(
        `Section "${section.heading || ref}" cannot contain places`,
        "Choose a normal custom place-list section or a trip day.",
      );
    }
    return;
  }
  if ((section.type !== "normal" && section.type !== "textOnly") || section.mode !== "placeList") {
    throw new WanderlogValidationError(
      `Section "${section.heading || ref}" cannot contain itinerary content`,
      "Choose a normal or text-only custom section, the default list, or a trip day.",
    );
  }
}

export function findDefaultPlaceList(trip: TripPlan): SectionRefMatch | null {
  for (let index = 0; index < trip.itinerary.sections.length; index++) {
    const section = trip.itinerary.sections[index]!;
    if (
      section.type === "normal" &&
      section.mode === "placeList" &&
      (section.heading === "Places to visit" || section.heading === "")
    ) {
      return { index, section };
    }
  }
  return null;
}
