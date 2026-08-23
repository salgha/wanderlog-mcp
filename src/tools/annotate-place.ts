import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { resolveSectionScope } from "../resolvers/section-target.js";
import { isPlaceBlock } from "../types.js";
import { buildAndSubmitOp, validateTimeInputs } from "./shared.js";

export const annotatePlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip containing the place."),
  place: z.string().min(1).describe(
    "Natural-language place reference. Supports partial names and ordinals for duplicates.",
  ),
  day: z.string().trim().min(1).optional().describe(
    "Optional day scope for resolving the place. Cannot be combined with section.",
  ),
  section: z.string().trim().min(1).optional().describe(
    "Optional named section scope for resolving the place. Cannot be combined with day.",
  ),
  note: z.string().optional().describe(
    "Set or replace the inline note on this place. Practical context: transit, tips, timing, what to see.",
  ),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, "must be HH:mm").optional().describe(
    "Set or replace the start time (HH:mm format).",
  ),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, "must be HH:mm").optional().describe(
    "Set or replace the end time (HH:mm format).",
  ),
};

export const annotatePlaceDescription = `
Updates an existing place in a Wanderlog trip with an inline note, start/end time, or both.
Use day or section to scope duplicate place names; omit both to search the whole trip.
At least one of note, start_time, or end_time must be provided.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  day?: string;
  section?: string;
  note?: string;
  start_time?: string;
  end_time?: string;
};

type AnnotatePlaceResult =
  | { kind: "error"; text: string }
  | { kind: "success"; placeName: string; title: string };

function hasQuillOps(value: unknown): value is { ops: Array<{ insert?: unknown }> } {
  return typeof value === "object" && value !== null &&
    Array.isArray((value as { ops?: unknown }).ops);
}

function quillDocumentLength(ops: Array<{ insert?: unknown }>): number {
  return ops.reduce((length, op) => {
    if (typeof op.insert === "string") return length + op.insert.length;
    return op.insert === undefined ? length : length + 1;
  }, 0);
}

export async function annotatePlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    validateTimeInputs(args.start_time, args.end_time);
    if (!args.note && !args.start_time && !args.end_time) {
      throw new WanderlogValidationError(
        "At least one of note, start_time, or end_time must be provided",
      );
    }

    const result = await buildAndSubmitOp<AnnotatePlaceResult>(ctx, args.trip_key, (trip) => {
      const scope = resolveSectionScope(trip, args);
      const resolved = resolvePlaceRef(trip, args.place, scope.indices);
      if (resolved.kind === "none") {
        throw new WanderlogError(
          `No place matching "${args.place}" found in ${scope.label} of "${trip.title}"`,
          "place_ref_not_found",
          { hint: "Check the place name or use wanderlog_get_trip to inspect the itinerary." },
        );
      }
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates.map((candidate, index) => {
          const name = isPlaceBlock(candidate.block) ? candidate.block.place.name : `${candidate.block.type} block`;
          const location = candidate.section.date
            ? `day ${candidate.section.date}`
            : candidate.section.heading || "unscheduled";
          return `  ${index + 1}. ${name} (${location})`;
        });
        return {
          ops: [],
          result: {
            kind: "error" as const,
            text: `Multiple places match "${args.place}":\n${lines.join("\n")}\n\nRetry with a more specific reference, ordinal, day, or section.`,
          },
        };
      }

      const { sectionIndex, blockIndex, block } = resolved.match;
      const blockPath = ["itinerary", "sections", sectionIndex, "blocks", blockIndex];
      const placeName = isPlaceBlock(block) ? block.place.name : `${block.type} block`;
      const existingBlock = block as Record<string, unknown>;
      const ops: Json0Op[] = [];

      if (args.note) {
        const replacement = `${args.note}\n`;
        const existingText = existingBlock.text;
        if (hasQuillOps(existingText)) {
          const length = quillDocumentLength(existingText.ops);
          const deltaOps: Array<Record<string, unknown>> = [];
          if (length > 0) deltaOps.push({ delete: length });
          deltaOps.push({ insert: replacement });
          ops.push({
            p: [...blockPath, "text"],
            t: "rich-text",
            o: deltaOps,
          });
        } else {
          ops.push({
            p: [...blockPath, "text"],
            oi: { ops: [{ insert: replacement }] },
          });
        }
      }
      if (args.start_time) {
        const op: Json0Op = { p: [...blockPath, "startTime"], oi: args.start_time };
        if ("startTime" in existingBlock) op.od = existingBlock.startTime as string | null;
        ops.push(op);
      }
      if (args.end_time) {
        const op: Json0Op = { p: [...blockPath, "endTime"], oi: args.end_time };
        if ("endTime" in existingBlock) op.od = existingBlock.endTime as string | null;
        ops.push(op);
      }
      return {
        ops,
        result: { kind: "success" as const, placeName, title: trip.title },
      };
    });

    if (result.kind === "error") {
      return { content: [{ type: "text", text: result.text }], isError: true };
    }
    const parts = [`Updated ${result.placeName} in "${result.title}".`];
    if (args.start_time) parts.push(`Time: ${args.start_time}${args.end_time ? `–${args.end_time}` : ""}.`);
    if (args.note) {
      const preview = args.note.length > 60 ? `${args.note.slice(0, 57)}…` : args.note;
      parts.push(`Note: "${preview}"`);
    }
    return { content: [{ type: "text", text: parts.join(" ") }] };
  } catch (err) {
    const msg = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
