/**
 * propose_memory — the careful write path (two-phase, MCP-native).
 *
 * MCP tools are single-shot, so "show diff → confirm" is two calls:
 *   - confirm=false (default): dedup-check against the corpus and return a
 *     preview (and a near-duplicate warning if one exists). Nothing is written.
 *   - confirm=true: write a new .md into corpus/memories/, supersede a
 *     near-identical prior note, and re-ingest so it's immediately retrievable.
 *
 * Writes ONLY ever land inside corpusPath (gitignored). Never hard-delete:
 * superseding stamps the old chunk, keeping it for history.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { getDb, toFloat32 } from "../db.js";
import { runtime } from "../runtime.js";
import { ingest } from "../store/ingest.js";
import { embed } from "../embed.js";

const DUP_THRESHOLD = 0.9;
const SUPERSEDE_THRESHOLD = 0.96;

interface NearRow {
  id: number;
  distance: number;
  file_path: string;
  heading: string | null;
  content: string;
}

export async function proposeMemory(
  content: string,
  confirm = false,
): Promise<string> {
  const text = content.trim();
  if (!text) return "propose_memory: empty content, nothing to save.";

  const config = loadConfig();
  const db = getDb(config);
  // Leading ingest keeps dedup fresh; the daemon already does this via fs.watch.
  if (!runtime.managedIngest) await ingest(db, config);

  const [vec] = await embed(
    [text],
    config.embeddingModel,
    config.modelCachePath,
  );

  let near: NearRow | undefined;
  if (vec) {
    near = db
      .prepare(
        `SELECT v.chunk_id AS id, v.distance AS distance,
                c.file_path, c.heading, c.content
         FROM (
           SELECT chunk_id, distance FROM chunks_vec
           WHERE embedding MATCH ? ORDER BY distance LIMIT 1
         ) v
         JOIN chunks c ON c.id = v.chunk_id
         WHERE c.superseded_at IS NULL`,
      )
      .get(toFloat32(vec)) as NearRow | undefined;
  }
  const sim = near ? 1 - near.distance : 0;

  if (!confirm) {
    if (near && sim >= DUP_THRESHOLD) {
      const where = `${near.file_path}${near.heading ? ` › ${near.heading}` : ""}`;
      return (
        `⚠️ Near-duplicate of [${where}] (similarity ${sim.toFixed(2)}).\n\n` +
        `Existing:\n${truncate(near.content)}\n\n` +
        `Proposed:\n${truncate(text)}\n\n` +
        `Call propose_memory again with confirm: true to save anyway` +
        (sim >= SUPERSEDE_THRESHOLD ? ` (this will supersede the old note).` : `.`)
      );
    }
    return (
      `New memory preview:\n\n${truncate(text)}\n\n` +
      `Call propose_memory again with confirm: true to save it to your corpus.`
    );
  }

  // confirm === true → write
  mkdirSync(join(config.corpusPath, "memories"), { recursive: true });
  const rel = join("memories", `${stamp()}-${slug(text)}.md`);
  writeFileSync(join(config.corpusPath, rel), `${text}\n`, "utf8");

  let superseded = false;
  if (near && sim >= SUPERSEDE_THRESHOLD) {
    db.prepare("UPDATE chunks SET superseded_at = ? WHERE id = ?").run(
      Date.now(),
      near.id,
    );
    superseded = true;
  }

  await ingest(db, config); // index the new file
  return (
    `Saved to ${rel}.` +
    (superseded
      ? ` Superseded the prior near-identical note in ${near?.file_path}.`
      : "")
  );
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function slug(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? "memory";
  return (
    first
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "memory"
  );
}
