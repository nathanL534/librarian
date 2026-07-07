/**
 * digest - promote reviewed facts from corpus/pending/*.md into durable notes.
 *
 * Default is dry-run: parse pending fact lines, dedup against the live corpus
 * with the same nearest-embedding threshold as capture/propose_memory, cluster
 * survivors by existing top-level topic files, and ask the librarian's own
 * Claude path for append-only markdown proposals. Apply mode appends those
 * proposals and archives the exact processed pending lines.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { getDb, toFloat32 } from "../db.js";
import { embed } from "../embed.js";
import { PersistentClaude } from "../persistentClaude.js";
import { ingest } from "../store/ingest.js";

const DUP_THRESHOLD = 0.9;
const DEFAULT_MAX_FACTS = 200;
const MAX_TOPIC_CONTEXT_CHARS = 18_000;

const DIGEST_SYSTEM_PROMPT =
  "You are the user's personal librarian. You merge reviewed raw facts into " +
  "durable markdown notes. Use only the provided topic note and pending facts. " +
  "Return ONLY concise markdown that can be appended to the topic file. Do not " +
  "invent details, do not include commentary, and do not wrap the answer in a " +
  "code fence.";

interface DigestOptions {
  apply: boolean;
  maxFacts: number;
}

interface PendingFact {
  file: string;
  lineNo: number;
  rawLine: string;
  fact: string;
  capturedAt: string;
}

interface NearRow {
  distance: number;
}

interface TopicFile {
  rel: string;
  full: string;
  text: string;
}

interface TopicGroup {
  topic: TopicFile;
  facts: PendingFact[];
  proposal: string;
}

function log(msg = ""): void {
  console.log(msg);
}

export async function runDigest(argv = process.argv.slice(3)): Promise<void> {
  const options = parseArgs(argv);
  const config = loadConfig();

  const pending = readPendingFacts(config).slice(0, options.maxFacts);
  if (pending.length === 0) {
    log("Digest queue is empty - no pending fact lines found.");
    log(`(queue: ${join(config.corpusPath, "pending")})`);
    return;
  }

  const db = getDb(config);
  await ingest(db, config);

  const deduped = await dedupFacts(pending, config);
  const topics = readTopicFiles(config);
  if (topics.length === 0) {
    throw new Error(`No top-level durable topic files found in ${config.corpusPath}`);
  }

  const assigned = await assignTopics(deduped.survivors, topics, config);
  const groups = await synthesizeGroups(assigned, config);

  printSummary({
    options,
    totalPending: pending.length,
    duplicates: deduped.duplicates,
    groups,
  });

  if (!options.apply) return;

  const mergedFacts = applyGroups(groups);
  const archivedFacts = [...deduped.duplicates, ...mergedFacts];
  archivePendingFacts(archivedFacts, config);
  log("");
  log(
    `Applied ${mergedFacts.length} new fact` +
      `${mergedFacts.length === 1 ? "" : "s"} across ` +
      `${groups.length} topic file${groups.length === 1 ? "" : "s"}; ` +
      `archived ${archivedFacts.length} processed pending line` +
      `${archivedFacts.length === 1 ? "" : "s"}.`,
  );
}

function parseArgs(argv: string[]): DigestOptions {
  let apply = false;
  let maxFacts = DEFAULT_MAX_FACTS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    } else if (arg === "--max-facts") {
      const raw = argv[++i];
      maxFacts = parseMaxFacts(raw);
    } else if (arg.startsWith("--max-facts=")) {
      maxFacts = parseMaxFacts(arg.slice("--max-facts=".length));
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown digest option: ${arg}`);
    }
  }

  return { apply, maxFacts };
}

function parseMaxFacts(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--max-facts must be a positive integer");
  }
  return n;
}

function printHelp(): void {
  log("Usage: librarian digest [--dry-run] [--apply] [--max-facts N]");
  log("");
  log("Default is --dry-run. Dry-run prints proposals and writes nothing to corpus.");
  log("--apply appends proposals to topic files and archives processed pending lines.");
}

function readPendingFacts(config: Config): PendingFact[] {
  const pendingDir = join(config.corpusPath, "pending");
  let files: string[];
  try {
    files = readdirSync(pendingDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }

  const facts: PendingFact[] = [];
  for (const file of files) {
    const full = join(pendingDir, file);
    const lines = readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, idx) => {
      const match = line.match(/^\s*-\s+\[([^\]]+)\]\s+(.+?)\s*$/);
      if (!match) return;
      facts.push({
        file: full,
        lineNo: idx,
        rawLine: line.trim(),
        capturedAt: match[1]!,
        fact: match[2]!.trim(),
      });
    });
  }
  return facts;
}

async function dedupFacts(
  facts: PendingFact[],
  config: Config,
): Promise<{ survivors: PendingFact[]; duplicates: PendingFact[] }> {
  const db = getDb(config);
  const nearest = db.prepare(
    `SELECT v.distance AS distance
       FROM (
         SELECT chunk_id, distance FROM chunks_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 1
       ) v
       JOIN chunks c ON c.id = v.chunk_id
       WHERE c.superseded_at IS NULL`,
  );

  const vectors = await embed(
    facts.map((f) => f.fact),
    config.embeddingModel,
    config.modelCachePath,
  );
  const seen = new Set<string>();
  const survivors: PendingFact[] = [];
  const duplicates: PendingFact[] = [];

  facts.forEach((fact, i) => {
    const key = fact.fact.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(fact);
      return;
    }
    seen.add(key);

    const vec = vectors[i];
    const near = vec ? (nearest.get(toFloat32(vec)) as NearRow | undefined) : undefined;
    const sim = near ? 1 - near.distance : 0;
    if (sim >= DUP_THRESHOLD) {
      duplicates.push(fact);
    } else {
      survivors.push(fact);
    }
  });

  return { survivors, duplicates };
}

function readTopicFiles(config: Config): TopicFile[] {
  let entries;
  try {
    entries = readdirSync(config.corpusPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const full = join(config.corpusPath, e.name);
      return { rel: e.name, full, text: readFileSync(full, "utf8") };
    });
}

async function assignTopics(
  facts: PendingFact[],
  topics: TopicFile[],
  config: Config,
): Promise<Map<string, TopicGroup>> {
  const groups = new Map<string, TopicGroup>();
  if (facts.length === 0) return groups;

  const factVecs = await embed(
    facts.map((f) => f.fact),
    config.embeddingModel,
    config.modelCachePath,
  );
  const topicVecs = await embed(
    topics.map((t) => `${basename(t.rel, ".md")}\n${t.text}`),
    config.embeddingModel,
    config.modelCachePath,
  );

  facts.forEach((fact, i) => {
    const factVec = factVecs[i];
    const best = factVec ? bestTopic(factVec, topics, topicVecs) : topics[0]!;
    let group = groups.get(best.rel);
    if (!group) {
      group = { topic: best, facts: [], proposal: "" };
      groups.set(best.rel, group);
    }
    group.facts.push(fact);
  });

  return groups;
}

function bestTopic(
  factVec: number[],
  topics: TopicFile[],
  topicVecs: number[][],
): TopicFile {
  let best = topics[0]!;
  let bestScore = -Infinity;
  topics.forEach((topic, i) => {
    const score = cosine(factVec, topicVecs[i] ?? []);
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  });
  return best;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  return aMag && bMag ? dot / (Math.sqrt(aMag) * Math.sqrt(bMag)) : -Infinity;
}

async function synthesizeGroups(
  assigned: Map<string, TopicGroup>,
  config: Config,
): Promise<TopicGroup[]> {
  const groups = [...assigned.values()].sort((a, b) =>
    a.topic.rel.localeCompare(b.topic.rel),
  );
  if (groups.length === 0) return groups;

  const claude = new PersistentClaude(config.model, DIGEST_SYSTEM_PROMPT);
  try {
    for (const group of groups) {
      group.proposal = cleanProposal(
        await claude.query(buildDigestPrompt(group.topic, group.facts)),
      );
    }
  } finally {
    claude.dispose();
  }
  return groups;
}

function buildDigestPrompt(topic: TopicFile, facts: PendingFact[]): string {
  const existing =
    topic.text.length > MAX_TOPIC_CONTEXT_CHARS
      ? topic.text.slice(-MAX_TOPIC_CONTEXT_CHARS)
      : topic.text;
  const factLines = facts
    .map((f) => `- [${f.capturedAt}] ${f.fact}`)
    .join("\n");
  return (
    `TOPIC FILE: ${topic.rel}\n\n` +
    `EXISTING TOPIC NOTE:\n${existing}\n\n` +
    `PENDING FACTS TO MERGE:\n${factLines}\n\n` +
    "Write a patch-style append proposal as markdown bullets or a short " +
    "subsection for this topic file. Consolidate overlapping facts. Preserve " +
    "specific durable facts, drop transient task chatter, and do not repeat " +
    "facts already present in the topic note. Return only the markdown to append."
  );
}

function cleanProposal(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function printSummary(input: {
  options: DigestOptions;
  totalPending: number;
  duplicates: PendingFact[];
  groups: TopicGroup[];
}): void {
  const survivorCount = input.groups.reduce((n, g) => n + g.facts.length, 0);
  log(
    `librarian digest ${input.options.apply ? "APPLY" : "DRY RUN"} ` +
      `(--max-facts ${input.options.maxFacts})`,
  );
  log("========================================");
  log(
    `parsed ${input.totalPending} pending fact` +
      `${input.totalPending === 1 ? "" : "s"}; ` +
      `${input.duplicates.length} duplicate/already represented; ` +
      `${survivorCount} candidate${survivorCount === 1 ? "" : "s"} to merge.`,
  );
  log("");

  if (input.duplicates.length > 0) {
    log("Already represented; would archive on apply:");
    for (const fact of input.duplicates) {
      log(`  ${relative(process.cwd(), fact.file)}:${fact.lineNo + 1} ${fact.rawLine}`);
    }
    log("");
  }

  if (survivorCount === 0) {
    log("No new facts would be merged.");
    return;
  }

  for (const group of input.groups) {
    log(`Would merge into ${group.topic.full}`);
    for (const fact of group.facts) {
      log(`  ${relative(process.cwd(), fact.file)}:${fact.lineNo + 1} ${fact.rawLine}`);
    }
    log("");
    log(group.proposal || "(Claude returned no appendable proposal.)");
    log("");
  }

  if (!input.options.apply) {
    log(
      "Dry-run only: no corpus files were modified and no pending lines were " +
        "archived. Apply would archive processed duplicate lines plus merged lines.",
    );
  }
}

function applyGroups(groups: TopicGroup[]): PendingFact[] {
  const date = new Date().toISOString().slice(0, 10);
  const merged: PendingFact[] = [];
  for (const group of groups) {
    if (!group.proposal.trim()) continue;
    const block =
      `\n\n## Digested pending facts - ${date}\n\n` +
      `${group.proposal.trim()}\n`;
    appendFileSync(group.topic.full, block, "utf8");
    merged.push(...group.facts);
  }
  return merged;
}

function archivePendingFacts(facts: PendingFact[], config: Config): void {
  if (facts.length === 0) return;

  const archiveDir = join(config.corpusPath, "archive", "pending-digested");
  mkdirSync(archiveDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const archiveFile = join(archiveDir, `${date}.md`);
  const header = existsSync(archiveFile)
    ? ""
    : `# Pending facts digested - ${date}\n\n`;
  const archived =
    facts
      .map((f) => `<!-- from ${relative(config.corpusPath, f.file)}:${f.lineNo + 1} -->\n${f.rawLine}`)
      .join("\n\n") + "\n";
  appendFileSync(archiveFile, header + archived, "utf8");

  const byFile = new Map<string, Set<number>>();
  for (const fact of facts) {
    let lines = byFile.get(fact.file);
    if (!lines) {
      lines = new Set<number>();
      byFile.set(fact.file, lines);
    }
    lines.add(fact.lineNo);
  }

  for (const [file, processed] of byFile) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const kept = lines.filter((_, idx) => !processed.has(idx));
    writeFileSync(file, kept.join("\n").replace(/\n*$/, "\n"), "utf8");
  }
}
