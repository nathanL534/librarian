/**
 * config — load + resolve the librarian's runtime configuration.
 *
 * Config lives in `config.json` next to the package root (or wherever
 * LIBRARIAN_CONFIG points). Paths are resolved relative to the config file,
 * NOT the cwd, because an MCP host may spawn this server from anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuthMode = "oauth" | "key";

export interface Config {
  /** Absolute path to the markdown corpus directory (canonical source of truth). */
  corpusPath: string;
  /** Absolute path to the derived SQLite index (rebuildable; gitignored). */
  dbPath: string;
  /** Absolute path to the local embedding-model cache (gitignored). */
  modelCachePath: string;
  /** Synthesis model id (Anthropic). */
  model: string;
  /** Embedding model id (transformers.js / HF hub). */
  embeddingModel: string;
  /** How the librarian calls its OWN Claude — independent of the host. */
  auth: AuthMode;
  /** Below this estimated token count, load the whole corpus instead of retrieving. */
  loadAllTokenBudget: number;
  /** Daemon runtime dir (~/.librarian) — short path, dodges the UDS length limit. */
  runtimeDir: string;
  /** Unix-domain socket the warm daemon listens on. */
  socketPath: string;
  /** File holding the running daemon's pid. */
  pidPath: string;
  /** Append-only usage telemetry log (JSONL; one line per request). */
  usagePath: string;
}

/** dist/config.js -> packageRoot is one level up. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  corpusPath: "./corpus",
  model: "claude-haiku-4-5-20251001",
  embeddingModel: "Xenova/bge-small-en-v1.5",
  auth: "oauth" as AuthMode,
  loadAllTokenBudget: 100_000,
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const configPath =
    process.env.LIBRARIAN_CONFIG ?? join(PACKAGE_ROOT, "config.json");

  let raw: Partial<typeof DEFAULTS> = {};
  if (existsSync(configPath)) {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<typeof DEFAULTS>;
  }

  const configDir = dirname(configPath);
  const merged = { ...DEFAULTS, ...raw };

  const corpusPath = isAbsolute(merged.corpusPath)
    ? merged.corpusPath
    : resolve(configDir, merged.corpusPath);

  // Index + model cache live next to the corpus; both are gitignored.
  const indexDir = resolve(corpusPath, "..", ".index");
  // Daemon runtime files live in a short, stable home-dir path (UDS length limit).
  const runtimeDir = join(homedir(), ".librarian");

  cached = {
    corpusPath,
    dbPath: join(indexDir, "librarian.db"),
    modelCachePath: join(indexDir, "models"),
    model: merged.model,
    embeddingModel: merged.embeddingModel,
    auth: (process.env.LIBRARIAN_AUTH as AuthMode | undefined) ?? merged.auth,
    loadAllTokenBudget: merged.loadAllTokenBudget,
    runtimeDir,
    socketPath: join(runtimeDir, "daemon.sock"),
    pidPath: join(runtimeDir, "daemon.pid"),
    usagePath: join(runtimeDir, "usage.jsonl"),
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
