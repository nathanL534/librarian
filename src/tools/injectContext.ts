/**
 * injectContext — the auto-read hook's path: SURFACE relevant facts, don't answer.
 *
 * Requirement: exact corpus terms surface raw facts directly; otherwise the
 * librarian (its OWN Haiku) curates — but only when it can make the hook's
 * DELIVERY deadline. The hook client abandons the socket after
 * HOOK_INJECT_TIMEOUT_MS (2.5s, client.ts); an answer produced after that is
 * written to a dead socket and silently lost, so a slow curation is
 * indistinguishable from no context at all. When synthesis can't make the
 * budget (OAuth turns run ~3.5-16s), fall back to the gated raw excerpts:
 * literal corpus chunks that passed the relevance gate — nothing synthesized,
 * so nothing to confabulate. Grounds on the gated top-k chunks, never load-all.
 */
import { loadConfig } from "../config.js";
import { synthesize, synthesizerBusy } from "../synthesize.js";
import { retrieveContext } from "./retrieveContext.js";

/**
 * Synthesis budget inside the hook client's 2.5s socket timeout, leaving room
 * for retrieval + IPC. The "key" path (direct API) can often make this; a warm
 * OAuth turn usually can't and degrades to raw excerpts instead of to nothing.
 */
const SYNTHESIS_DEADLINE_MS = 1800;

const DEADLINE: unique symbol = Symbol("deadline");

/** Resolve with DEADLINE if `p` hasn't settled within `ms`; `p` keeps running. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  // The losing promise may still reject after we've moved on — mark it handled.
  void p.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function injectContext(prompt: string): Promise<string> {
  const raw = await retrieveContext(prompt); // gate + relevant chunks
  if (!raw.context) return ""; // nothing passed the relevance gate → stay silent
  const sources = [...new Set(raw.sources)].join(", ");
  if (raw.keywordOverride) {
    const terms = raw.matchedTerms?.length
      ? `Exact corpus term matched: ${raw.matchedTerms.join(", ")}\n\n`
      : "";
    return `${terms}${raw.context}\n\n— sources: ${sources}`;
  }

  const config = loadConfig();
  // Deliverable instantly, strictly grounded: the literal gated excerpts.
  const fallback = `${raw.context}\n\n— sources: ${sources}`;

  // OAuth turns are SERIALIZED (persistentClaude.ts). If a turn is already in
  // flight, this one would queue behind it and cannot make the deadline —
  // surface raw immediately instead of piling work onto the warm session.
  if (synthesizerBusy(config)) return fallback;

  const framed =
    "From the NOTES above, surface ONLY the facts that are directly relevant to " +
    "the user's current prompt. Do NOT answer the prompt, give advice, or add " +
    "anything not literally in the notes. Terse bullets. If nothing in the notes " +
    `is relevant, reply with exactly: NONE\n\nUser's current prompt: ${prompt}`;

  let out: string | typeof DEADLINE;
  try {
    out = await withDeadline(
      synthesize(framed, raw.context, config),
      SYNTHESIS_DEADLINE_MS,
    );
  } catch {
    return fallback; // synthesis broke; the gated excerpts still ground the prompt
  }
  if (out === DEADLINE) return fallback; // curation too slow to deliver → raw
  const text = out.trim();
  if (!text || /^none\b/i.test(text)) return ""; // nothing grounded → inject nothing
  return `${text}\n\n— sources: ${sources}`;
}
