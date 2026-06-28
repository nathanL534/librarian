/**
 * synthesize — STUB.
 *
 * Intended behavior: call Claude Haiku (via @anthropic-ai/sdk) to produce a
 * grounded answer from the supplied context.
 *
 * Context-loading strategy:
 *   - If the whole corpus fits within the token budget, pass the entire corpus
 *     as context (best fidelity for small personal corpora).
 *   - Otherwise, pass only the top-k retrieved chunks (see ./store/retrieve.ts).
 *
 * The model id comes from config (default "claude-haiku-4-5-20251001"). The API
 * key is read from the environment (.env, gitignored) — never hardcoded, never
 * committed.
 *
 * @param query The user's question.
 * @param context The corpus text or top-k chunks to ground the answer in.
 * @returns A synthesized answer. (Currently a stub.)
 */
export async function synthesize(
  query: string,
  context: string,
): Promise<string> {
  void query;
  void context;
  return "synthesize: not implemented yet";
}
