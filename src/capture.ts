/**
 * capture — the AUTO-WRITE hook's brain (fire-and-forget half of the librarian).
 *
 * When a Claude Code session ends, a Stop hook hands us the session transcript.
 * We ask the librarian's OWN Claude — a SEPARATE extraction instance, not the
 * synthesis librarian — to pull DURABLE new facts about the user worth keeping
 * long-term, dedup them against the live corpus, and append survivors to
 * corpus/pending/<date>.md.
 *
 * REVIEW-QUEUE MODE: extracted facts land in corpus/pending/ and are NEVER
 * retrieved (ingest skips pending/) until the user promotes them. No auto-commit
 * to the live corpus → no corpus rot.
 *
 * FREE + SAFE: the OAuth `claude` path only (PersistentClaude — no API key, no
 * Anthropic SDK), and writes ONLY ever land inside corpusPath/pending.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { getDb, toFloat32 } from "./db.js";
import { embed } from "./embed.js";
import { PersistentClaude } from "./persistentClaude.js";

// Same dedup threshold as proposeMemory.ts: above this cosine similarity to an
// existing live note, the "new" fact is already known → drop it.
const DUP_THRESHOLD = 0.9;
// Cap the conversation handed to `claude` so extraction stays within the
// PersistentClaude turn timeout. The decision-bearing tail is kept (sliced).
const MAX_CONVO_CHARS = 24_000;
// Defensive cap so a runaway model paragraph can't become one giant "fact".
const MAX_FACT_CHARS = 300;

const EXTRACTION_SYSTEM_PROMPT =
  "You extract durable facts about the user (Nathan) from a conversation " +
  "transcript between Nathan and an AI assistant. Output ONLY the facts — one " +
  "per line, terse, no preamble, no numbering, no commentary. A durable fact is " +
  "a stable preference, decision, project, or fact about Nathan's life/work " +
  "worth remembering long-term. Never output transient task details, code " +
  "specifics, secrets/credentials, or anything trivial. If there is nothing " +
  "durable, output nothing at all.";

const EXTRACTION_INSTRUCTION =
  "From this conversation, extract DURABLE new facts about the user (Nathan) " +
  "worth remembering long-term — preferences, decisions, projects, facts about " +
  "their life/work. One fact per line, terse. Skip transient task details, code " +
  "specifics, secrets, and anything trivial. If nothing durable, output nothing.";

// One warm extraction session, reused across captures (mirrors synthesize.ts).
let extractor: PersistentClaude | null = null;

/** Tear down the warm extraction session (called on daemon shutdown). */
export function disposeCapture(): void {
  extractor?.dispose();
  extractor = null;
}

interface TranscriptLine {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
}

/** Pull readable text out of a message's `content` (string OR block array). */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          return String((b as { text?: unknown }).text ?? "");
        }
        return ""; // skip tool_use / tool_result / images
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Parse a Claude Code transcript JSONL into a flat "User:/Assistant:" script.
 * Tolerant: unparseable lines and non-user/assistant events are skipped. Only
 * the most recent MAX_CONVO_CHARS are kept (the tail holds the decisions).
 */
function transcriptToConversation(transcriptPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const turns: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: TranscriptLine;
    try {
      evt = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue; // partial / non-JSON line — skip
    }
    const role = evt.message?.role ?? evt.role ?? evt.type;
    if (role !== "user" && role !== "assistant") continue;
    const text = blockText(evt.message?.content ?? evt.content).trim();
    if (!text) continue;
    turns.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const convo = turns.join("\n\n");
  return convo.length > MAX_CONVO_CHARS ? convo.slice(-MAX_CONVO_CHARS) : convo;
}

/** Split the model's reply into clean fact strings (drops bullets / "none"). */
function parseFacts(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const fact = line
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "") // strip bullet / numbering
      .trim()
      .slice(0, MAX_FACT_CHARS);
    if (!fact) continue;
    if (/^(none|n\/a|no (durable|new)|nothing\b)/i.test(fact)) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue; // intra-batch exact dedup
    seen.add(key);
    out.push(fact);
  }
  return out;
}

/**
 * §1 — extract durable facts from a transcript via the librarian's OWN Claude
 * (free OAuth path). Returns [] when the transcript is empty/unreadable or the
 * model finds nothing durable. Never throws on a model error → returns [].
 */
export async function captureFromTranscript(
  transcriptPath: string,
  config: Config,
): Promise<string[]> {
  const convo = transcriptToConversation(transcriptPath);
  if (!convo) return [];
  if (!extractor) {
    extractor = new PersistentClaude(config.model, EXTRACTION_SYSTEM_PROMPT);
  }
  try {
    const reply = await extractor.query(
      `${EXTRACTION_INSTRUCTION}\n\nCONVERSATION:\n${convo}`,
    );
    return parseFacts(reply);
  } catch {
    return []; // a model/CLI failure must never crash the capture path
  }
}

interface NearRow {
  distance: number;
}

/**
 * §2 — dedup against the LIVE corpus (embedding nearest-match, same approach as
 * proposeMemory.ts) and append survivors to corpus/pending/<ISO-date>.md.
 * Writes ONLY ever land inside corpusPath. Returns the facts actually queued.
 */
export async function queuePendingFacts(
  facts: string[],
  config: Config,
): Promise<{ queued: string[]; file: string | null }> {
  if (facts.length === 0) return { queued: [], file: null };

  const db = getDb(config); // cached — same handle the daemon already holds
  const nearest = db.prepare(
    `SELECT v.distance AS distance
       FROM (
         SELECT chunk_id, distance FROM chunks_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 1
       ) v
       JOIN chunks c ON c.id = v.chunk_id
       WHERE c.superseded_at IS NULL`,
  );

  const vectors = await embed(facts, config.embeddingModel, config.modelCachePath);
  const survivors: string[] = [];
  facts.forEach((fact, i) => {
    const vec = vectors[i];
    if (vec) {
      const near = nearest.get(toFloat32(vec)) as NearRow | undefined;
      const sim = near ? 1 - near.distance : 0;
      if (sim >= DUP_THRESHOLD) return; // already known → drop
    }
    survivors.push(fact);
  });

  if (survivors.length === 0) return { queued: [], file: null };

  const pendingDir = join(config.corpusPath, "pending");
  mkdirSync(pendingDir, { recursive: true });
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const file = join(pendingDir, `${date}.md`);
  const header = existsSync(file)
    ? ""
    : `# Pending facts — ${date}\n\n` +
      `<!-- Auto-captured by the librarian. NOT retrieved until promoted into a corpus note. -->\n\n`;
  const body =
    survivors.map((f) => `- [${now.toISOString()}] ${f}`).join("\n") + "\n";
  appendFileSync(file, header + body, "utf8");

  return { queued: survivors, file };
}

/**
 * §4 orchestrator — extract → dedup → queue, used by the daemon's /capture
 * handler. Returns how many facts were extracted vs actually queued (for the
 * usage log). Self-contained: callers pass only the transcript path + config.
 */
export async function runCapture(
  transcriptPath: string,
  config: Config,
): Promise<{ extracted: number; queued: string[]; file: string | null }> {
  const facts = await captureFromTranscript(transcriptPath, config);
  const { queued, file } = await queuePendingFacts(facts, config);
  return { extracted: facts.length, queued, file };
}
