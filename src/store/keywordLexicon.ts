/**
 * keywordLexicon — exact corpus-term override for auto-injection.
 *
 * Vector relevance is intentionally conservative, but exact mentions of known
 * corpus topics/projects should never be missed. This module derives an
 * in-memory lexicon from markdown filenames, H1/H2 headings, and bolded names.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Config } from "../config.js";
import type { DB } from "../db.js";

interface LexiconEntry {
  term: string;
  filePath: string;
  scope: "file" | "chunk";
}

export interface KeywordOverrideHit {
  context: string;
  sources: string[];
  terms: string[];
}

let cachedCorpusPath = "";
let cachedEntries: LexiconEntry[] = [];

// User-specific seed terms (project names, recurring topics) come from the
// gitignored config.json (`seedTerms`) so no personal terms live in source.
// Lowercased snapshot of the active config's seeds, for termLooksUseful.
let seedTermsLower = new Set<string>();

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (
        e.name.startsWith(".") ||
        e.name === "archive" ||
        e.name === "pending"
      )
        continue;
      out.push(...listMarkdown(full));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/[`*_#]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .trim();
}

function normalizeTerm(term: string): string {
  return stripMarkdown(term)
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function primaryName(term: string): string {
  return normalizeTerm(term.split(/\s+[—–-]\s+|:|\(/)[0] ?? term);
}

function termLooksUseful(term: string): boolean {
  if (term.length < 3 || term.length > 80) return false;
  if (/^\d/.test(term)) return false;
  if (seedTermsLower.has(term.toLowerCase())) return true;
  if (term.includes(" ")) return true;
  return /^[A-Z]/.test(term);
}

function addTerm(
  entries: LexiconEntry[],
  seen: Set<string>,
  term: string,
  filePath: string,
  scope: LexiconEntry["scope"],
): void {
  const normalized = normalizeTerm(term);
  if (!termLooksUseful(normalized)) return;
  const key = `${normalized.toLowerCase()}\0${filePath}\0${scope}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push({ term: normalized, filePath, scope });
}

export function refreshKeywordLexicon(config: Config): void {
  const entries: LexiconEntry[] = [];
  const seen = new Set<string>();
  const files = listMarkdown(config.corpusPath);
  const relFiles = files.map((file) => relative(config.corpusPath, file));
  const textByRel = new Map<string, string>();
  seedTermsLower = new Set(config.seedTerms.map((t) => t.toLowerCase()));

  for (const file of files) {
    const rel = relative(config.corpusPath, file);
    const base = basename(file, ".md");
    addTerm(entries, seen, base, rel, "file");
    addTerm(entries, seen, base.replace(/[-_]+/g, " "), rel, "file");

    const text = readFileSync(file, "utf8");
    textByRel.set(rel, text);
    for (const line of text.split(/\r?\n/)) {
      const heading = /^(#{1,2})\s+(.+)$/.exec(line);
      if (heading) {
        const full = normalizeTerm(heading[2] ?? "");
        addTerm(entries, seen, full, rel, "chunk");
        addTerm(entries, seen, primaryName(full), rel, "chunk");
        for (const part of full.split(/\s+\/\s+/)) {
          addTerm(entries, seen, primaryName(part), rel, "chunk");
        }
      }

      for (const match of line.matchAll(/\*\*([^*]+)\*\*/g)) {
        const full = normalizeTerm(match[1] ?? "");
        addTerm(entries, seen, full, rel, "chunk");
        addTerm(entries, seen, primaryName(full), rel, "chunk");
      }
    }
  }

  // Attach each configured seed term to the corpus file that actually mentions
  // it (falling back to the first file), so a seed hit surfaces the right note.
  for (const seed of config.seedTerms) {
    const filePath =
      relFiles.find((rel) => textHasTerm(textByRel.get(rel) ?? "", seed)) ??
      relFiles[0];
    if (filePath) addTerm(entries, seen, seed, filePath, "chunk");
  }

  // Prefer longer phrases first so a two-word phrase wins before its last word.
  cachedEntries = entries.sort((a, b) => b.term.length - a.term.length);
  cachedCorpusPath = config.corpusPath;
}

export function ensureKeywordLexicon(config: Config): void {
  if (cachedCorpusPath !== config.corpusPath || cachedEntries.length === 0) {
    refreshKeywordLexicon(config);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string): RegExp {
  const escaped = term.split(/\s+/).map(escapeRegExp).join("[\\s_-]+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

function proseOnly(text: string): string {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token)) return token;
      // Paths and URLs are machine context, not intentional prose mentions.
      if (
        /[\\/]/.test(token) ||
        /^(?:[a-z][a-z\d+.-]*:|~[\\/])/i.test(token) ||
        /\.[a-z\d]{1,8}(?:[?#].*)?[,;:)]?$/i.test(token)
      ) {
        return "";
      }
      return token;
    })
    .join("");
}

function textHasTerm(text: string, term: string): boolean {
  return termRegex(term).test(proseOnly(text));
}

export function findKeywordOverride(
  db: DB,
  config: Config,
  query: string,
): KeywordOverrideHit | null {
  ensureKeywordLexicon(config);
  const matched = cachedEntries.filter((entry) => textHasTerm(query, entry.term));
  if (matched.length === 0) return null;

  const terms = [...new Set(matched.map((entry) => entry.term.toLowerCase()))];
  const sources = [...new Set(matched.map((entry) => entry.filePath))];
  const fileScopes = new Set(
    matched
      .filter((entry) => entry.scope === "file")
      .map((entry) => entry.filePath),
  );
  const termsByFile = new Map<string, string[]>();
  for (const entry of matched) {
    const existing = termsByFile.get(entry.filePath) ?? [];
    existing.push(entry.term);
    termsByFile.set(entry.filePath, existing);
  }

  const chunks = db
    .prepare(
      `SELECT file_path, heading, content
       FROM chunks
       WHERE superseded_at IS NULL
       ORDER BY file_path, id`,
    )
    .all() as { file_path: string; heading: string | null; content: string }[];

  const selected = chunks.filter((chunk) => {
    if (!sources.includes(chunk.file_path)) return false;
    if (fileScopes.has(chunk.file_path)) return true;
    const fileTerms = termsByFile.get(chunk.file_path) ?? [];
    const haystack = `${chunk.heading ?? ""}\n${chunk.content}`;
    return fileTerms.some((term) => textHasTerm(haystack, term));
  });

  if (selected.length === 0) return null;

  const context = selected
    .map((chunk) => {
      const heading = chunk.heading ? ` › ${chunk.heading}` : "";
      return `[${chunk.file_path}${heading}]\n${chunk.content}`;
    })
    .join("\n\n---\n\n");

  return {
    context,
    sources: [...new Set(selected.map((chunk) => chunk.file_path))],
    terms,
  };
}
