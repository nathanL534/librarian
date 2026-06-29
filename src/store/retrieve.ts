/**
 * retrieve — vector recall + 4-factor re-rank.
 *
 *   1. embed the query locally
 *   2. KNN top-(k*2) candidates from sqlite-vec (cosine)
 *   3. re-rank with recency / popularity / graph-context / importance
 *   4. bump access stats on the chunks we actually return
 *
 * No FTS/keyword stage — vector-first by design (revisit only if exact-term
 * recall proves weak).
 */
import type { Config } from "../config.js";
import { toFloat32, type DB } from "../db.js";
import { embed } from "../embed.js";
import { finalScore, type Scorable } from "../rerank.js";

export interface RetrievedChunk {
  id: number;
  file_path: string;
  heading: string | null;
  content: string;
  similarity: number;
  score: number;
}

interface CandidateRow {
  id: number;
  distance: number;
  file_path: string;
  heading: string | null;
  content: string;
  updated_at: number;
  access_count: number;
  importance: number;
}

export async function retrieve(
  db: DB,
  config: Config,
  query: string,
  k = 8,
): Promise<RetrievedChunk[]> {
  const [qvec] = await embed(
    [query],
    config.embeddingModel,
    config.modelCachePath,
  );
  if (!qvec) return [];

  // KNN in a subquery (the robust sqlite-vec form), then join + filter.
  const candidates = db
    .prepare(
      `SELECT v.chunk_id AS id, v.distance AS distance,
              c.file_path, c.heading, c.content,
              c.updated_at, c.access_count, c.importance
       FROM (
         SELECT chunk_id, distance FROM chunks_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?
       ) v
       JOIN chunks c ON c.id = v.chunk_id
       WHERE c.superseded_at IS NULL
       ORDER BY v.distance`,
    )
    .all(toFloat32(qvec), k * 2) as CandidateRow[];

  if (candidates.length === 0) return [];

  const now = Date.now();
  const graphScores = computeGraphScores(
    db,
    candidates.map((c) => c.id),
  );

  const ranked = candidates
    .map((c) => {
      const similarity = 1 - c.distance; // cosine distance -> similarity
      const scorable: Scorable = {
        id: c.id,
        similarity,
        updated_at: c.updated_at,
        access_count: c.access_count,
        importance: c.importance,
        graphScore: graphScores.get(c.id) ?? 0,
      };
      return {
        id: c.id,
        file_path: c.file_path,
        heading: c.heading,
        content: c.content,
        similarity,
        score: finalScore(scorable, now),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const bump = db.prepare(
    "UPDATE chunks SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (const r of ranked) bump.run(now, r.id);
  });
  tx();

  return ranked;
}

/**
 * Graph-context assist: a candidate scores 1 if it shares an entity with a
 * recently-accessed chunk (1 hop), else 0. Returns an empty map (inert) until
 * entities/relations are populated — exactly as designed.
 */
function computeGraphScores(
  db: DB,
  candidateIds: number[],
): Map<number, number> {
  const scores = new Map<number, number>();
  if (candidateIds.length === 0) return scores;

  const hot = db
    .prepare(
      `SELECT DISTINCT ce.entity_id
       FROM chunk_entities ce
       JOIN chunks c ON c.id = ce.chunk_id
       WHERE c.last_accessed IS NOT NULL
       ORDER BY c.last_accessed DESC
       LIMIT 50`,
    )
    .all() as { entity_id: number }[];
  if (hot.length === 0) return scores;

  const hotSet = new Set(hot.map((h) => h.entity_id));
  const placeholders = candidateIds.map(() => "?").join(",");
  const links = db
    .prepare(
      `SELECT chunk_id, entity_id FROM chunk_entities WHERE chunk_id IN (${placeholders})`,
    )
    .all(...candidateIds) as { chunk_id: number; entity_id: number }[];

  for (const { chunk_id, entity_id } of links) {
    if (hotSet.has(entity_id)) scores.set(chunk_id, 1);
  }
  return scores;
}
