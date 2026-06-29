/**
 * ingest — build/refresh the index from the markdown corpus.
 *
 * Incremental: for each file we diff chunk content-hashes. Unchanged chunks are
 * left untouched (preserving their access stats); new/changed chunks are
 * embedded and inserted; removed chunks (and whole deleted files) are dropped.
 * Only new chunks hit the embedder, so re-ingesting an unchanged corpus is cheap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import { toFloat32, type DB } from "../db.js";
import { chunkMarkdown } from "../chunk.js";
import { embed } from "../embed.js";

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // corpus dir doesn't exist yet
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip dotdirs and the cold archive (searchable explicitly, not hot).
      if (e.name.startsWith(".") || e.name === "archive") continue;
      out.push(...listMarkdown(full));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export async function ingest(
  db: DB,
  config: Config,
): Promise<{ files: number; added: number; removed: number }> {
  const files = listMarkdown(config.corpusPath);
  let added = 0;
  let removed = 0;

  const selectExisting = db.prepare(
    "SELECT id, content_hash FROM chunks WHERE file_path = ?",
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks
       (file_path, heading, content, content_hash, created_at, updated_at, last_accessed, access_count, importance)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0.5)`,
  );
  const insertVec = db.prepare(
    "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
  );
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
  const deleteVec = db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?");

  for (const file of files) {
    const rel = relative(config.corpusPath, file);
    const text = readFileSync(file, "utf8");
    const chunks = chunkMarkdown(text);

    const existing = selectExisting.all(rel) as {
      id: number;
      content_hash: string;
    }[];
    const existingHashes = new Set(existing.map((r) => r.content_hash));
    const seenHashes = new Set<string>();

    const newChunks = chunks.filter((c) => {
      seenHashes.add(c.contentHash);
      return !existingHashes.has(c.contentHash);
    });

    if (newChunks.length > 0) {
      const vectors = await embed(
        newChunks.map((c) => c.content),
        config.embeddingModel,
        config.modelCachePath,
      );
      const now = Date.now();
      const tx = db.transaction(() => {
        newChunks.forEach((c, i) => {
          const info = insertChunk.run(
            rel,
            c.heading,
            c.content,
            c.contentHash,
            now,
            now,
          );
          // sqlite-vec's vec0 PK must be bound as a BigInt (integers-only check).
          insertVec.run(BigInt(info.lastInsertRowid), toFloat32(vectors[i]));
          added++;
        });
      });
      tx();
    }

    // Drop chunks whose content no longer appears in the file.
    const stale = existing.filter((r) => !seenHashes.has(r.content_hash));
    if (stale.length > 0) {
      const tx = db.transaction(() => {
        for (const r of stale) {
          deleteChunk.run(r.id);
          deleteVec.run(BigInt(r.id));
          removed++;
        }
      });
      tx();
    }
  }

  // Drop chunks belonging to files that were deleted entirely.
  const livePaths = new Set(files.map((f) => relative(config.corpusPath, f)));
  const indexedPaths = db
    .prepare("SELECT DISTINCT file_path FROM chunks")
    .all() as { file_path: string }[];
  for (const { file_path } of indexedPaths) {
    if (livePaths.has(file_path)) continue;
    const ids = db
      .prepare("SELECT id FROM chunks WHERE file_path = ?")
      .all(file_path) as { id: number }[];
    const tx = db.transaction(() => {
      for (const { id } of ids) {
        deleteChunk.run(id);
        deleteVec.run(BigInt(id));
        removed++;
      }
    });
    tx();
  }

  return { files: files.length, added, removed };
}
