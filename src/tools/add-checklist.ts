import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveBlockDestination } from "../resolvers/section-target.js";
import { buildAndSubmitOp, buildChecklistBlock, requireUserId } from "./shared.js";

export const addChecklistInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the checklist to. Use wanderlog_list_trips if you don't know the key."),
  items: z.array(z.string().min(1)).min(1).describe(
    "Checklist items. Each string becomes one checkbox item, initially unchecked.",
  ),
  title: z.string().optional().describe(
    "Optional title for the checklist (e.g. 'Packing list'). Omit for an untitled checklist.",
  ),
  day: z.string().trim().min(1).optional().describe(
    "Optional day to add the checklist to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to add to the 'Places to visit' list.",
  ),
  section: z.string().trim().min(1).optional().describe(
    "Optional named section to add the checklist to. Cannot be combined with day.",
  ),
};

export const addChecklistDescription = `
Adds a checklist to a Wanderlog trip. Each item starts unchecked and can be ticked off in the
Wanderlog app. Choose one destination with day or section; omit both for the default list.

Common uses include packing lists, arrival-day tasks, advance bookings, and section-specific
research or preparation lists.

Returns a confirmation including the checklist title and item count.
`.trim();

type Args = {
  trip_key: string;
  items: string[];
  title?: string;
  day?: string;
  section?: string;
};

export async function addChecklist(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    const block = buildChecklistBlock(args.items, args.title ?? "", userId);
    const result = await buildAndSubmitOp(ctx, args.trip_key, (trip) => {
      const target = resolveBlockDestination(trip, args, "checklist");
      const insertIndex = target.section.blocks.length;
      const ops: Json0Op[] = [{
        p: ["itinerary", "sections", target.index, "blocks", insertIndex],
        li: block,
      }];
      return { ops, result: { label: target.label, title: trip.title } };
    });

    const titlePart = args.title ? `"${args.title}" ` : "";
    const text = `Added checklist ${titlePart}(${args.items.length} items) to ${result.label} in "${result.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
