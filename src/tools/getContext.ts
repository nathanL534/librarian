/**
 * get_context — answer a question from the user's private corpus.
 *
 *   1. refresh the index (cheap; only new/changed chunks embed)
 *   2. if the whole corpus fits the token budget, load all of it (best fidelity
 *      for small personal corpora); otherwise retrieve the top-k chunks
 *   3. the librarian's OWN Claude synthesizes a grounded answer + sources
 */
import { loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { ingest } from "../store/ingest.js";
import { retrieve } from "../store/retrieve.js";
import { synthesize } from "../synthesize.js";

const APPROX_CHARS_PER_TOKEN = 4;

interface ChunkRow {
  file_path: string;
  heading: string | null;
  content: string;
}

export async function getContext(query: string): Promise<string> {
  if (!query.trim()) return "get_context: empty query.";

  const config = loadConfig();
  const db = getDb(config);
  await ingest(db, config);

  const rows = db
    .prepare(
      "SELECT file_path, heading, content FROM chunks WHERE superseded_at IS NULL",
    )
    .all() as ChunkRow[];

  if (rows.length === 0) {
    return "No personal context yet. Add markdown notes to your corpus, or use propose_memory to save something.";
  }

  const totalChars = rows.reduce((n, r) => n + r.content.length, 0);
  const fitsBudget =
    totalChars / APPROX_CHARS_PER_TOKEN < config.loadAllTokenBudget;

  let used: ChunkRow[];
  if (fitsBudget) {
    used = rows;
  } else {
    used = await retrieve(db, config, query, 8);
  }

  const context = used
    .map((r) => formatChunk(r.file_path, r.heading, r.content))
    .join("\n\n---\n\n");
  const sources = [...new Set(used.map((r) => r.file_path))];

  const answer = await synthesize(query, context, config);
  return `${answer}\n\n— sources: ${sources.join(", ")}`;
}

function formatChunk(
  file: string,
  heading: string | null,
  content: string,
): string {
  const h = heading ? ` › ${heading}` : "";
  return `[${file}${h}]\n${content}`;
}
