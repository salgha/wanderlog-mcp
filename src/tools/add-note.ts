import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveBlockDestination } from "../resolvers/section-target.js";
import { buildAndSubmitOp, buildNoteBlock, requireUserId } from "./shared.js";

export const addNoteInputSchema = z
  .object({
    trip_key: z
      .string()
      .min(1)
      .describe(
        "The trip to add the note to. Use wanderlog_list_trips if you don't know the key.",
      ),
    text: z
      .string()
      .min(1)
      .describe("The note text. Plain text — can be multi-line."),
    day: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional day to add the note to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Cannot be combined with section. Omit both to add to the 'Places to visit' list.",
      ),
    section: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Optional named section to add the note to. Cannot be combined with day.",
      ),
  })
  .superRefine((value, ctx) => {
    if (value.day && value.section) {
      ctx.addIssue({
        code: "custom",
        message: "Choose either day or section, not both",
        path: ["section"],
      });
    }
  });

export const addNoteDescription = `
Adds a text note to a Wanderlog trip. Notes appear inline between places in a day or named section.
Choose one destination with day or section; omit both for the default Places to visit list.

Use notes for transit directions, practical tips, food recommendations, timing guidance, and
neighborhood context that does not belong on one specific place.

Returns a confirmation of where the note was added.
`.trim();

type Args = z.infer<typeof addNoteInputSchema>;

export async function addNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    const block = buildNoteBlock(userId);
    const result = await buildAndSubmitOp(ctx, args.trip_key, (trip) => {
      const target = resolveBlockDestination(trip, args, "note");
      const insertIndex = target.section.blocks.length;
      const blockPath = ["itinerary", "sections", target.index, "blocks", insertIndex];
      const ops: Json0Op[] = [
        { p: blockPath, li: block },
        {
          p: [...blockPath, "text"],
          t: "rich-text",
          o: [{ insert: `${args.text}\n` }],
        },
      ];
      return { ops, result: { label: target.label, title: trip.title } };
    });

    const preview = args.text.length > 60 ? `${args.text.slice(0, 57)}…` : args.text;
    const text = `Added note "${preview}" to ${result.label} in "${result.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
