/**
 * ingest — STUB.
 *
 * Intended behavior (build the searchable index from markdown):
 *   1. Read each .md file under the configured corpusPath.
 *   2. Chunk by markdown heading (so each chunk is a coherent section).
 *   3. Embed each chunk locally via transformers.js (see ../embed.ts) — no API
 *      calls, $0.
 *   4. Upsert each chunk into SQLite:
 *        - the vector into a sqlite-vec virtual table (for similarity search)
 *        - the text into an FTS5 table (for keyword search)
 *      keyed by file path + chunk id so re-ingesting a changed file replaces
 *      its old chunks rather than duplicating them.
 *
 * SAFETY: the SQLite DB (*.db / *.sqlite) and the .index/ directory are
 * gitignored — the index is local-only and derived from private content.
 */
export async function ingest(): Promise<void> {
  // not implemented yet
}
