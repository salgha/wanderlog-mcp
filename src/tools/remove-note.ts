import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  resolveSectionScope,
  type SectionSelector,
} from "../resolvers/section-target.js";
import type { NoteBlock, QuillDelta, TripPlan } from "../types.js";
import { buildAndSubmitOp } from "./shared.js";

export const removeNoteInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  text: z
    .string()
    .min(1)
    .describe("Substring to match against note content (case-insensitive)."),
  day: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional day to search. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to search the entire trip.",
    ),
  section: z.string().trim().min(1).optional().describe(
    "Optional named section to search. Cannot be combined with day.",
  ),
};

export const removeNoteDescription = `
Removes a note block from a Wanderlog trip by matching a substring of its text content.

The match is case-insensitive. If exactly one note matches, it is deleted. If no notes match,
an error is returned. If multiple notes match, a list of previews is returned — supply a more
specific substring to narrow to one.

Use the optional 'day' or 'section' filter to limit the search to one itinerary section.
The two filters are mutually exclusive.
`.trim();

type Args = {
  trip_key: string;
  text: string;
  day?: string;
  section?: string;
};

type RemoveNoteResult =
  | { kind: "error"; text: string }
  | { kind: "success"; preview: string; title: string };

export type NoteMatch = {
  sectionIndex: number;
  blockIndex: number;
  plainText: string;
  block: NoteBlock;
};

export function extractDeltaText(delta: QuillDelta | undefined): string {
  const ops = delta?.ops ?? [];
  return ops.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

export function extractPlainText(block: NoteBlock): string {
  return extractDeltaText(block.text);
}

export function findNoteMatches(
  trip: TripPlan,
  query: string,
  selector: SectionSelector = {},
): NoteMatch[] {
  const lowerQuery = query.toLowerCase();
  const sections = trip.itinerary.sections;
  const matches: NoteMatch[] = [];
  const sectionIndices = resolveSectionScope(trip, selector).indices;

  for (const sectionIndex of sectionIndices) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (block.type !== "note") continue;
      const noteBlock = block as NoteBlock;
      const plainText = extractPlainText(noteBlock);
      if (plainText.toLowerCase().includes(lowerQuery)) {
        matches.push({ sectionIndex, blockIndex, plainText, block: noteBlock });
      }
    }
  }

  return matches;
}

function notePreview(plainText: string): string {
  const flat = plainText.replace(/\n/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export async function removeNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await buildAndSubmitOp<RemoveNoteResult>(ctx, args.trip_key, (trip) => {
      const matches = findNoteMatches(trip, args.text, args);
      if (matches.length === 0) throw new WanderlogNotFoundError("Note", args.text);

      if (matches.length > 1) {
        const lines = matches.slice(0, 5).map((match, index) =>
          `  ${index + 1}. "${notePreview(match.plainText)}"`,
        ).join("\n");
        const suffix = matches.length > 5 ? `\n  (${matches.length - 5} more…)` : "";
        return {
          ops: [],
          result: {
            kind: "error" as const,
            text: `"${args.text}" matches ${matches.length} notes:\n${lines}${suffix}\n\nCall again with a more specific substring or section scope.`,
          },
        };
      }

      const { sectionIndex, blockIndex, block, plainText } = matches[0]!;
      const ops: Json0Op[] = [{
        p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex],
        ld: block,
      }];
      return {
        ops,
        result: {
          kind: "success" as const,
          preview: notePreview(plainText),
          title: trip.title,
        },
      };
    });

    if (result.kind === "error") {
      return { content: [{ type: "text", text: result.text }], isError: true };
    }
    const text = `Removed note "${result.preview}" from "${result.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof WanderlogError
      ? err.toUserMessage()
      : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
