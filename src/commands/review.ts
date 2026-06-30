/**
 * review — show the auto-write review queue (corpus/pending/*.md).
 *
 * The Stop hook captures durable facts about the user into corpus/pending/, but
 * those are NEVER retrieved (ingest skips pending/) until the user promotes them
 * into a real corpus note. This command prints what's queued, with file paths,
 * so the user can eyeball the pile and manually promote the ones they approve.
 *
 * Read-only: never writes, never touches the live corpus. Degrades gracefully
 * when nothing is pending.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";

function log(msg = ""): void {
  console.log(msg);
}

export async function runReview(): Promise<void> {
  const config = loadConfig();
  const pendingDir = join(config.corpusPath, "pending");

  let files: string[];
  try {
    files = readdirSync(pendingDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    files = []; // pending/ doesn't exist yet
  }

  if (files.length === 0) {
    log("Review queue is empty — no pending facts captured yet.");
    log(`(queue: ${pendingDir})`);
    return;
  }

  log("librarian review queue (auto-captured, NOT yet retrievable)");
  log("===========================================================");
  log(`queue dir: ${pendingDir}`);
  log("");

  let total = 0;
  for (const f of files) {
    const full = join(pendingDir, f);
    let lines: string[] = [];
    try {
      lines = readFileSync(full, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "));
    } catch {
      continue;
    }
    log(`${full}  (${lines.length} fact${lines.length === 1 ? "" : "s"})`);
    for (const l of lines) {
      log(`  ${l}`);
      total++;
    }
    log("");
  }

  log(`${total} pending fact${total === 1 ? "" : "s"} across ${files.length} file(s).`);
  log("Promote the ones you approve into a corpus note (e.g. via propose_memory),");
  log("then delete them from the pending file.");
}
