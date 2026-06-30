/**
 * usage — append-only telemetry: "is the librarian actually used?".
 *
 * One JSONL line per request to <runtimeDir>/usage.jsonl (~/.librarian/, outside
 * the repo + gitignored-by-location). Lets the user see, over time, how often the
 * librarian fires, what comes in (queries), what comes out (injected vs silent),
 * frequency, and latency.
 *
 * Best-effort by contract: every function here swallows its own errors so a
 * logging failure can NEVER break a request. Timestamps use `new Date()` at call
 * time — the daemon is long-lived, so a build-time-frozen clock would be wrong.
 */
import { appendFileSync, readFileSync } from "node:fs";

export type UsageType =
  | "inject"
  | "get_context"
  | "propose_memory"
  | "capture";

export interface UsageEntry {
  /** ISO timestamp, stamped when the request finished. */
  ts: string;
  type: UsageType;
  /** The incoming query/content, truncated to the first 200 chars. */
  query: string;
  /**
   * Did the librarian surface anything? For /inject this is THE signal: false
   * means the relevance gate stayed silent. For other types: answer non-empty.
   * For "capture": true when ≥1 fact was queued to the review pile.
   */
  injected: boolean;
  latency_ms: number;
  /** Corpus files the answer drew on (empty when silent). */
  sources: string[];
  /** Auto-write only: how many durable facts were queued to corpus/pending/. */
  count?: number;
}

/** First-200-chars truncation used for the logged query (avoids fat lines). */
export function clipQuery(query: string): string {
  return query.slice(0, 200);
}

/**
 * Pull the "— sources: a.md, b.md" footer that getContext appends, if present.
 * Returns [] when there's no footer (e.g. a silent inject or a propose_memory).
 */
export function parseSources(answer: string): string[] {
  const marker = "— sources:";
  const idx = answer.lastIndexOf(marker);
  if (idx === -1) return [];
  return answer
    .slice(idx + marker.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Append one usage line. Best-effort — never throws. */
export function appendUsage(usagePath: string, entry: UsageEntry): void {
  try {
    appendFileSync(usagePath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* telemetry is best-effort: a logging failure must not break a request */
  }
}

/**
 * Read + parse the usage log. Tolerant of partial/corrupt lines (a half-written
 * tail line is skipped, not thrown). Returns [] when the log is missing/empty.
 */
export function readUsage(usagePath: string): UsageEntry[] {
  let raw: string;
  try {
    raw = readFileSync(usagePath, "utf8");
  } catch {
    return []; // no log yet
  }
  const entries: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as UsageEntry);
    } catch {
      /* skip a corrupt/partial line */
    }
  }
  return entries;
}
