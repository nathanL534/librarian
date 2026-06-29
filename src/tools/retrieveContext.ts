/**
 * retrieveContext — the CHEAP context path (no LLM).
 *
 * Used by the auto-read hook, which fires on every prompt and must be fast. It
 * embeds the query, pulls the top-k re-ranked chunks, and returns them raw for
 * injection — NO `claude -p` synthesis (that's the expensive part, reserved for
 * the deliberate get_context tool). Always top-k (never load-all) so the
 * injected context stays small and doesn't bloat the host's token budget.
 *
 * Relevance gate: since the auto-read hook is GLOBAL (fires on every prompt in
 * every project), we only return context when a chunk genuinely matches —
 * otherwise the hook stays silent during unrelated work instead of injecting
 * noise. Tunable via MIN_RELEVANCE.
 */
import { loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { runtime } from "../runtime.js";
import { ingest } from "../store/ingest.js";
import { retrieve } from "../store/retrieve.js";

export interface RawContext {
  context: string;
  sources: string[];
}

// bge-small cosine: ~0.5+ for an on-topic match, ~0.2-0.3 for unrelated prompts.
const MIN_RELEVANCE = 0.4;

export async function retrieveContext(query: string, k = 5): Promise<RawContext> {
  if (!query.trim()) return { context: "", sources: [] };

  const config = loadConfig();
  const db = getDb(config);
  if (!runtime.managedIngest) await ingest(db, config);

  const hits = (await retrieve(db, config, query, k)).filter(
    (r) => r.similarity >= MIN_RELEVANCE,
  );
  if (hits.length === 0) return { context: "", sources: [] };

  const context = hits
    .map((r) => {
      const h = r.heading ? ` › ${r.heading}` : "";
      return `[${r.file_path}${h}]\n${r.content}`;
    })
    .join("\n\n---\n\n");
  const sources = [...new Set(hits.map((r) => r.file_path))];
  return { context, sources };
}
