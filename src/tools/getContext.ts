/**
 * get_context — STUB.
 *
 * Intended behavior:
 *   1. Measure the size of the user's corpus.
 *   2. If the entire corpus fits within the model's token budget, load all of
 *      it and pass it straight to synthesis (no retrieval needed — small
 *      personal corpora usually fit).
 *   3. Otherwise, run hybrid retrieval (see ./store/retrieve.ts): vector
 *      similarity + keyword/FTS, fused with Reciprocal Rank Fusion (RRF), and
 *      take the top-k chunks.
 *   4. Synthesize a grounded answer with Haiku (see ../synthesize.ts).
 *
 * @param query The natural-language question to answer from personal context.
 * @returns A synthesized, source-grounded answer. (Currently a stub.)
 */
export async function getContext(query: string): Promise<string> {
  void query;
  return "get_context: not implemented yet";
}
