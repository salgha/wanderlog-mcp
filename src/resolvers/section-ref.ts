import { parseOrdinal } from "./place-ref.js";
import type { Section, TripPlan } from "../types.js";

export type SectionRefMatch = {
  index: number;
  section: Section;
};

export type SectionRefResult =
  | { kind: "unique"; match: SectionRefMatch }
  | { kind: "ambiguous"; candidates: SectionRefMatch[] }
  | { kind: "none" };

export function resolveSectionRef(trip: TripPlan, ref: string): SectionRefResult {
  const normalized = normalize(ref);
  if (!normalized) return { kind: "none" };

  const ordinal = parseOrdinal(normalized);
  const body = ordinal?.rest ?? normalized;
  const candidates = findCandidates(trip, body);

  if (ordinal) {
    const index = ordinal.position === "last"
      ? candidates.length - 1
      : ordinal.position - 1;
    if (index < 0 || index >= candidates.length) return { kind: "none" };
    return { kind: "unique", match: candidates[index]! };
  }

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "unique", match: candidates[0]! };
  return { kind: "ambiguous", candidates };
}

function findCandidates(trip: TripPlan, ref: string): SectionRefMatch[] {
  if (ref === "places" || ref === "places to visit") {
    const matches: SectionRefMatch[] = [];
    for (let index = 0; index < trip.itinerary.sections.length; index++) {
      const section = trip.itinerary.sections[index]!;
      if (
        section.type === "normal" &&
        section.mode === "placeList" &&
        (section.heading === "Places to visit" || section.heading === "")
      ) {
        matches.push({ index, section });
      }
    }
    return matches;
  }

  const matches: SectionRefMatch[] = [];
  for (let index = 0; index < trip.itinerary.sections.length; index++) {
    const section = trip.itinerary.sections[index]!;
    if (normalize(section.heading) === ref) matches.push({ index, section });
  }
  return matches;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
