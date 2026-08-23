import { WanderlogValidationError } from "../errors.js";
import { parseOrdinal } from "../resolvers/place-ref.js";
import {
  requireSectionRef,
  resolveBlockDestination,
} from "../resolvers/section-target.js";
import { resolveSectionRef, type SectionRefMatch } from "../resolvers/section-ref.js";
import type { Section, TripPlan } from "../types.js";
import { buildSectionObject, findPlacesToVisitSection } from "./shared.js";

export { buildSectionObject };

export { requireSectionRef };

export function resolveContentTarget(
  trip: TripPlan,
  target: { day?: string; section?: string },
): { index: number; section: Section; label: string } {
  return resolveBlockDestination(trip, target, "place");
}

export function assertCustomSectionMutable(
  trip: TripPlan,
  match: SectionRefMatch,
): void {
  const { section, index } = match;
  if (section.mode === "dayPlan") {
    throw new WanderlogValidationError(
      "Day sections cannot be changed with custom-section tools",
      "Use wanderlog_rename_day or wanderlog_update_trip_dates instead.",
    );
  }
  if (findPlacesToVisitSection(trip)?.index === index) {
    throw new WanderlogValidationError(
      'The default "Places to visit" section is protected',
      "Create a custom section instead.",
    );
  }
  if (section.type !== "normal" || section.mode !== "placeList") {
    throw new WanderlogValidationError(
      `The "${section.heading || section.type}" section is not a custom place-list section`,
    );
  }
}

export function requireNonEmptyHeading(heading: string): string {
  const normalized = heading.trim();
  if (!normalized) {
    throw new WanderlogValidationError("Custom section headings must be non-empty");
  }
  if (parseOrdinal(normalized.toLowerCase())) {
    throw new WanderlogValidationError(
      "Custom section headings cannot start with ordinal reference syntax",
      "Avoid prefixes such as '2nd', 'second', or 'last'.",
    );
  }
  return normalized;
}

export function assertHeadingAvailable(
  trip: TripPlan,
  heading: string,
  exceptIndex?: number,
): void {
  const result = resolveSectionRef(trip, heading);
  if (result.kind === "none") return;
  const matches = result.kind === "unique" ? [result.match] : result.candidates;
  if (matches.some((match) => match.index !== exceptIndex)) {
    throw new WanderlogValidationError(
      `A section named "${heading}" already exists in trip "${trip.title}"`,
      "Use a distinct heading so future section references stay unambiguous.",
    );
  }
}
