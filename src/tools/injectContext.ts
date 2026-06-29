/**
 * injectContext — the auto-read hook's path: the librarian's Haiku CURATES.
 *
 * Requirement: the librarian (its OWN Haiku), not the host Claude, decides what
 * context to surface — the host receives the librarian's synthesized answer,
 * never raw chunks it picks from itself. So the hook runs the SAME librarian
 * logic as the deliberate get_context tool (load-all-if-fits → Haiku synthesis).
 * Two Claudes talking.
 *
 * To avoid paying for Haiku on every unrelated prompt (the hook is global), a
 * cheap deterministic relevance gate runs FIRST (vector similarity, ~10ms): if
 * nothing in the corpus is relevant, we stay silent WITHOUT waking Haiku. Haiku
 * fires only when there's genuinely something for the librarian to say.
 */
import { getContext } from "./getContext.js";
import { retrieveContext } from "./retrieveContext.js";

export async function injectContext(prompt: string): Promise<string> {
  const { context } = await retrieveContext(prompt); // gate only — cheap
  if (!context) return ""; // nothing relevant → don't wake Haiku, stay silent
  return getContext(prompt); // librarian's Haiku curates (same path as the tool)
}
