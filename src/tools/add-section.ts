import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  assertHeadingAvailable,
  buildSectionObject,
  requireNonEmptyHeading,
  requireSectionRef,
} from "./section-shared.js";
import { buildAndSubmitOp } from "./shared.js";

export const addSectionInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the section to."),
  heading: z
    .string()
    .trim()
    .min(1)
    .describe("A distinct, non-empty heading for the new custom section."),
  after_section: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional existing section after which to insert the new section. Supports ordinal references for duplicate headings."),
};

export const addSectionDescription = `
Adds an empty custom place-list section to a Wanderlog trip. The heading must be non-empty and
must not duplicate another section heading. Omit after_section to append it at the end, or name
an existing section to insert it immediately afterward. Add places later with
wanderlog_add_place using its section parameter.
`.trim();

type Args = {
  trip_key: string;
  heading: string;
  after_section?: string;
};

export async function addSection(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const heading = requireNonEmptyHeading(args.heading);
    const result = await buildAndSubmitOp(ctx, args.trip_key, (trip) => {
      assertHeadingAvailable(trip, heading);
      let insertIndex = trip.itinerary.sections.length;
      let position = "at the end";
      if (args.after_section) {
        const after = requireSectionRef(trip, args.after_section);
        insertIndex = after.index + 1;
        position = `after "${after.section.heading || args.after_section}"`;
      }
      const section = buildSectionObject(heading);
      const ops: Json0Op[] = [{ p: ["itinerary", "sections", insertIndex], li: section }];
      return { ops, result: { position, title: trip.title } };
    });

    return {
      content: [{
        type: "text",
        text: `Added custom section "${heading}" ${result.position} in "${result.title}".`,
      }],
    };
  } catch (err) {
    const text = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}
