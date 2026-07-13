/**
 * injectContext — the auto-read hook's path: SURFACE relevant facts, don't answer.
 *
 * Requirement: exact corpus terms surface raw facts directly; otherwise the
 * librarian (its OWN Haiku), not the host Claude, decides what to surface. It
 * must GROUND strictly — the failure mode is confabulation (inventing a
 * scenario/answer when the corpus has nothing). Grounds on the gated top-k
 * chunks, never load-all.
 */
import { loadConfig } from "../config.js";
import { synthesize } from "../synthesize.js";
import { retrieveContext } from "./retrieveContext.js";

export async function injectContext(prompt: string): Promise<string> {
  const raw = await retrieveContext(prompt); // gate + relevant chunks
  if (!raw.context) return ""; // nothing passed the relevance gate → stay silent
  if (raw.keywordOverride) {
    const terms = raw.matchedTerms?.length
      ? `Exact corpus term matched: ${raw.matchedTerms.join(", ")}\n\n`
      : "";
    return `${terms}${raw.context}\n\n— sources: ${[...new Set(raw.sources)].join(", ")}`;
  }

  const config = loadConfig();
  const framed =
    "From the NOTES above, surface ONLY the facts that are directly relevant to " +
    "the user's current prompt. Do NOT answer the prompt, give advice, or add " +
    "anything not literally in the notes. Terse bullets. If nothing in the notes " +
    `is relevant, reply with exactly: NONE\n\nUser's current prompt: ${prompt}`;

  const out = (await synthesize(framed, raw.context, config)).trim();
  if (!out || /^none\b/i.test(out)) return ""; // nothing grounded → inject nothing
  return `${out}\n\n— sources: ${[...new Set(raw.sources)].join(", ")}`;
}
