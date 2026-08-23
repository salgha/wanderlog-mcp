import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  assertCustomSectionMutable,
  assertHeadingAvailable,
  requireNonEmptyHeading,
  requireSectionRef,
} from "./section-shared.js";
import { buildAndSubmitOp } from "./shared.js";

export const updateSectionInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the custom section."),
  section: z
    .string()
    .trim()
    .min(1)
    .describe("Current section heading. Supports ordinal references for duplicate headings."),
  heading: z
    .string()
    .trim()
    .min(1)
    .describe("A distinct, non-empty replacement heading."),
};

export const updateSectionDescription = `
Renames a custom section in a Wanderlog trip. Day sections, the default Places to visit list,
and system sections are protected. The replacement heading must remain non-empty and distinct
so the section can be referenced safely in later calls.
`.trim();

type Args = {
  trip_key: string;
  section: string;
  heading: string;
};

export async function updateSection(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const newHeading = requireNonEmptyHeading(args.heading);
    const result = await buildAndSubmitOp(ctx, args.trip_key, (trip) => {
      const match = requireSectionRef(trip, args.section);
      assertCustomSectionMutable(trip, match);
      const oldHeading = match.section.heading;
      if (oldHeading === newHeading) {
        return { ops: [], result: { oldHeading, title: trip.title, changed: false } };
      }
      assertHeadingAvailable(trip, newHeading, match.index);
      const ops: Json0Op[] = [{
        p: ["itinerary", "sections", match.index, "heading"],
        od: oldHeading,
        oi: newHeading,
      }];
      return { ops, result: { oldHeading, title: trip.title, changed: true } };
    });
    if (!result.changed) {
      return { content: [{ type: "text", text: `Section is already named "${newHeading}" — no change made.` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Renamed custom section "${result.oldHeading}" to "${newHeading}" in "${result.title}".`,
      }],
    };
  } catch (err) {
    const text = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}
