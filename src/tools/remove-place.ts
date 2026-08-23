import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { buildAndSubmitOp } from "./shared.js";

export const removePlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip to remove from."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place you want to remove. Examples: 'Queenstown Gardens', 'the hotel', 'the sushi place on day 3'. Supports ordinal prefixes for duplicates: '1st Queenstown Gardens', 'second Queenstown Gardens', 'last Queenstown Gardens'. Supports day filters via ' on ': 'Queenstown Gardens on May 4'. Ordinals and day filters can be combined: '2nd Queenstown Gardens on May 4'.",
    ),
};

export const removePlaceDescription = `
Removes a place (or flight, train, hotel — any block) from a Wanderlog trip based on a
natural-language reference.

Supported reference forms:
  - Exact or partial name: "Queenstown Gardens", "Gardens"
  - Role keywords: "the hotel", "the flight", "the train"
  - Day filter: "Queenstown Gardens on May 4" or "... on day 3"
  - Ordinal prefix (for duplicates): "1st Queenstown Gardens", "second X", "last X"
  - Combined: "2nd Queenstown Gardens on May 4"

If the reference is ambiguous (multiple places match), the tool returns a numbered list of
candidates and does NOT make any change. Re-call with an ordinal prefix ("1st X", "2nd X") or
a more specific filter to pick the one you want.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
};

type RemovePlaceResult =
  | { kind: "ambiguous"; text: string }
  | { kind: "removed"; name: string; location: string; title: string };

export async function removePlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await buildAndSubmitOp<RemovePlaceResult>(ctx, args.trip_key, (trip) => {
      const resolved = resolvePlaceRef(trip, args.place_ref);
      if (resolved.kind === "none") {
        throw new WanderlogNotFoundError("Place", args.place_ref);
      }
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates
          .slice(0, 10)
          .map((candidate, index) => {
            const name = isPlaceBlock(candidate.block)
              ? candidate.block.place.name
              : `${candidate.block.type} block`;
            return `  ${index + 1}. ${name} — ${formatLocation(candidate.section)} (${ordinalLabel(index + 1)})`;
          })
          .join("\n");
        const firstCandidateName = isPlaceBlock(resolved.candidates[0]!.block)
          ? resolved.candidates[0]!.block.place.name
          : "the block";
        const retryHint = `Call this tool again with an ordinal to pick one, e.g. place_ref: "1st ${firstCandidateName}" or "last ${firstCandidateName}". You can also combine with a day filter, e.g. "2nd ${firstCandidateName} on day 2".`;
        return {
          ops: [],
          result: {
            kind: "ambiguous" as const,
            text: `"${args.place_ref}" matches ${resolved.candidates.length} places:\n${lines}\n\n${retryHint}`,
          },
        };
      }

      const { sectionIndex, blockIndex, block, section } = resolved.match;
      const ops: Json0Op[] = [{
        p: ["itinerary", "sections", sectionIndex, "blocks", blockIndex],
        ld: block,
      }];
      return {
        ops,
        result: {
          kind: "removed" as const,
          name: isPlaceBlock(block) ? block.place.name : `${block.type} block`,
          location: formatLocation(section),
          title: trip.title,
        },
      };
    });

    if (result.kind === "ambiguous") {
      return { content: [{ type: "text", text: result.text }], isError: true };
    }
    const text = `Removed ${result.name} from ${result.location} in "${result.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

function formatLocation(section: {
  heading?: string;
  type?: string;
  mode?: string;
  date?: string | null;
}): string {
  if (section.mode === "dayPlan" && section.date) {
    return `day ${section.date}`;
  }
  if (section.heading) return `"${section.heading}"`;
  return `"${section.type ?? "section"}"`;
}

function ordinalLabel(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}
