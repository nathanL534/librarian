/**
 * stats — "is the librarian actually earning its keep?", from the terminal.
 *
 * Reads the append-only usage log (~/.librarian/usage.jsonl) and prints a
 * readable summary: call volume (all-time / 24h / 7d), the inject HIT-RATE
 * (how often the relevance gate surfaced context vs stayed silent — the number
 * that matters most), latency (avg + median, overall and for inject), the most
 * recent distinct queries, and when it was last used. Also shows the live
 * in-memory daemon counters when the daemon is up.
 *
 * Read-only: never writes, never touches the corpus. Degrades gracefully when
 * the log is missing/empty.
 */
import { loadConfig } from "../config.js";
import { daemonHealth } from "../client.js";
import { readUsage, type UsageEntry } from "../usage.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function log(msg = ""): void {
  console.log(msg);
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** "123ms" or "1.4s" — keeps the latency column easy to scan. */
function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export async function runStats(): Promise<void> {
  const config = loadConfig();
  const entries = readUsage(config.usagePath);

  if (entries.length === 0) {
    log("No usage recorded yet.");
    log(`(log: ${config.usagePath})`);
    await printLiveCounters();
    return;
  }

  const now = Date.now();
  const at = (e: UsageEntry): number => Date.parse(e.ts); // NaN-safe below
  const last24h = entries.filter((e) => now - at(e) <= DAY_MS).length;
  const last7d = entries.filter((e) => now - at(e) <= 7 * DAY_MS).length;

  const injects = entries.filter((e) => e.type === "inject");
  const fired = injects.filter((e) => e.injected).length;
  const silent = injects.length - fired;
  const hitRate = injects.length > 0 ? (fired / injects.length) * 100 : 0;

  const allLatencies = entries.map((e) => e.latency_ms);
  const injectLatencies = injects.map((e) => e.latency_ms);

  const byType = {
    inject: injects.length,
    get_context: entries.filter((e) => e.type === "get_context").length,
    propose_memory: entries.filter((e) => e.type === "propose_memory").length,
  };

  const lastTs = entries[entries.length - 1]!.ts;

  log("librarian usage");
  log("===============");
  log(`log:         ${config.usagePath}`);
  log(`total calls: ${entries.length}  (last 24h: ${last24h}, last 7d: ${last7d})`);
  log(
    `by type:     inject ${byType.inject}, ` +
      `get_context ${byType.get_context}, ` +
      `propose_memory ${byType.propose_memory}`,
  );
  log(`last used:   ${lastTs}`);
  log("");

  log("inject hit-rate (the gate surfacing context)");
  if (injects.length === 0) {
    log("  no inject calls yet");
  } else {
    log(
      `  ${hitRate.toFixed(0)}%  —  ${fired} fired / ${silent} silent ` +
        `(of ${injects.length} inject calls)`,
    );
  }
  log("");

  log("latency");
  log(`  overall: avg ${ms(avg(allLatencies))}, median ${ms(median(allLatencies))}`);
  if (injectLatencies.length > 0) {
    log(
      `  inject:  avg ${ms(avg(injectLatencies))}, ` +
        `median ${ms(median(injectLatencies))}`,
    );
  }
  log("");

  log("most recent distinct queries");
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let i = entries.length - 1; i >= 0 && recent.length < 10; i--) {
    const q = entries[i]!.query.trim();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    recent.push(q);
  }
  if (recent.length === 0) {
    log("  (none)");
  } else {
    for (const q of recent) log(`  • ${q}`);
  }

  await printLiveCounters();
}

/** Show the daemon's in-memory counters when it's up (best-effort). */
async function printLiveCounters(): Promise<void> {
  const health = await daemonHealth();
  log("");
  if (!health) {
    log("daemon: not running (showing log-only stats above).");
    return;
  }
  log("daemon: UP (live counters since start)");
  const u = health.usage as
    | {
        total?: number;
        inject?: { fired?: number; silent?: number };
        get_context?: number;
        propose_memory?: number;
      }
    | undefined;
  if (!u) {
    log("  (this daemon predates usage counters — restart it to enable)");
    return;
  }
  log(
    `  total ${u.total ?? 0}  |  inject ${u.inject?.fired ?? 0} fired / ` +
      `${u.inject?.silent ?? 0} silent  |  get_context ${u.get_context ?? 0}  |  ` +
      `propose_memory ${u.propose_memory ?? 0}`,
  );
}
