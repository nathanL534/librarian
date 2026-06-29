/**
 * rerank — blend semantic similarity with a 4-factor behavioral score.
 *
 * Vector recall finds the candidates; these factors re-rank them. Semantic
 * relevance stays dominant (SEMANTIC_WEIGHT) so a stale-but-popular chunk can't
 * outrank a fresh, on-topic one. Adapted from memento's scoring approach.
 *
 *   recency     ~40%  temporal decay, 30-day half-life
 *   popularity  ~20%  log-scaled access_count
 *   graph       ~20%  shares an entity with a recently-accessed chunk (inert
 *                     until entities are populated — degrades gracefully)
 *   importance  ~20%  per-chunk weight
 */
export interface Scorable {
  id: number;
  /** Cosine similarity in [-1, 1] (≈[0,1] for related text). */
  similarity: number;
  /** Epoch ms of last content update. */
  updated_at: number;
  access_count: number;
  /** 0..1 */
  importance: number;
  /** 0..1; 0 when no graph signal. */
  graphScore: number;
}

export interface RerankWeights {
  recency: number;
  popularity: number;
  graph: number;
  importance: number;
}

const SEMANTIC_WEIGHT = 0.6;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const POPULARITY_SCALE = Math.log(1 + 50);

const DEFAULT_WEIGHTS: RerankWeights = {
  recency: 0.4,
  popularity: 0.2,
  graph: 0.2,
  importance: 0.2,
};

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

function popularityScore(accessCount: number): number {
  return Math.min(1, Math.log(1 + accessCount) / POPULARITY_SCALE);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function finalScore(
  s: Scorable,
  now: number,
  weights: RerankWeights = DEFAULT_WEIGHTS,
): number {
  const behavioral =
    weights.recency * recencyScore(s.updated_at, now) +
    weights.popularity * popularityScore(s.access_count) +
    weights.graph * clamp01(s.graphScore) +
    weights.importance * clamp01(s.importance);
  return SEMANTIC_WEIGHT * clamp01(s.similarity) + (1 - SEMANTIC_WEIGHT) * behavioral;
}
