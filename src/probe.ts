/**
 * probe — deterministic validation of the retrieval pipeline against the fake
 * corpus.example. Proves embed + ingest + retrieve + re-rank work end-to-end
 * with NO LLM call (reproducible once the embed model is cached). Pass --synth
 * to also smoke-test the librarian's own-Claude synthesis.
 *
 *   npm run build && npm run probe            # retrieval only
 *   npm run build && node dist/probe.js --synth
 */
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { closeDb, getDb } from "./db.js";
import { ingest } from "./store/ingest.js";
import { retrieve } from "./store/retrieve.js";
import { synthesize } from "./synthesize.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config: Config = {
  corpusPath: join(PACKAGE_ROOT, "corpus.example"),
  dbPath: join(PACKAGE_ROOT, ".index", "probe.db"),
  modelCachePath: join(PACKAGE_ROOT, ".index", "models"),
  model: "claude-haiku-4-5-20251001",
  embeddingModel: "Xenova/bge-small-en-v1.5",
  auth: "oauth",
  loadAllTokenBudget: 100_000,
  runtimeDir: join(homedir(), ".librarian"),
  socketPath: join(homedir(), ".librarian", "daemon.sock"),
  pidPath: join(homedir(), ".librarian", "daemon.pid"),
  usagePath: join(homedir(), ".librarian", "usage.jsonl"),
};

interface Case {
  query: string;
  expect: RegExp;
}

const CASES: Case[] = [
  { query: "what does Avery like to drink?", expect: /cortado/i },
  { query: "who taught Avery navigation?", expect: /isla voss/i },
  { query: "what is Avery allergic to?", expect: /blue rambutan/i },
  { query: "which path floods at spring tides?", expect: /east cliff/i },
];

async function main(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(config.dbPath + suffix, { force: true });
  }

  console.log(
    "⏳ ingesting corpus.example (first run downloads the embed model ~460MB)…",
  );
  const db = getDb(config);
  const stats = await ingest(db, config);
  console.log(`   indexed ${stats.files} file(s), ${stats.added} chunk(s)\n`);

  let pass = 0;
  for (const c of CASES) {
    const top = await retrieve(db, config, c.query, 3);
    const hit = top.some((r) => c.expect.test(r.content));
    pass += hit ? 1 : 0;
    const t1 = top[0];
    console.log(`${hit ? "✅" : "❌"} "${c.query}"`);
    console.log(
      `   top: [${t1?.heading ?? "?"}] sim=${t1?.similarity.toFixed(3)} score=${t1?.score.toFixed(3)}`,
    );
    if (!hit) {
      console.log(
        `   expected /${c.expect.source}/ in top-3; got headings: ${top
          .map((t) => t.heading)
          .join(", ")}`,
      );
    }
  }
  console.log(`\nRetrieval: ${pass}/${CASES.length} passed`);

  if (process.argv.includes("--synth")) {
    console.log(`\n⏳ synthesis smoke test (auth=${config.auth})…`);
    try {
      const top = await retrieve(
        db,
        config,
        "what does Avery drink and what are they allergic to?",
        4,
      );
      const ctx = top
        .map((t) => `[${t.file_path} › ${t.heading}]\n${t.content}`)
        .join("\n\n---\n\n");
      const ans = await synthesize(
        "What does Avery drink, and what are they allergic to?",
        ctx,
        config,
      );
      console.log(`answer:\n${ans}`);
    } catch (e) {
      console.log(`synthesis failed: ${(e as Error).message}`);
    }
  }

  closeDb();
  if (pass < CASES.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
