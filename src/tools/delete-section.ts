import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  assertCustomSectionMutable,
  requireSectionRef,
} from "./section-shared.js";
import { buildAndSubmitOp } from "./shared.js";

export const deleteSectionInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the custom section."),
  section: z
    .string()
    .trim()
    .min(1)
    .describe("Custom section heading. Supports ordinal references for duplicate headings."),
};

export const deleteSectionDescription = `
Permanently deletes a custom section and every block inside it. Day sections, the default
Places to visit list, and system sections are protected. This operation cannot be undone through
this MCP tool, so use it only when the user explicitly asks to delete the section.
`.trim();

type Args = {
  trip_key: string;
  section: string;
};

export async function deleteSection(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await buildAndSubmitOp(ctx, args.trip_key, (trip) => {
      const match = requireSectionRef(trip, args.section);
      assertCustomSectionMutable(trip, match);
      const ops: Json0Op[] = [{
        p: ["itinerary", "sections", match.index],
        ld: match.section,
      }];
      return {
        ops,
        result: {
          heading: match.section.heading,
          blockCount: match.section.blocks.length,
          title: trip.title,
        },
      };
    });

    return {
      content: [{
        type: "text",
        text: `Deleted custom section "${result.heading}" and its ${result.blockCount} block(s) from "${result.title}".`,
      }],
    };
  } catch (err) {
    const text = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}
