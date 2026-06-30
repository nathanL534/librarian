/**
 * daemon — the 24/7 warm process.
 *
 * Loads the embedding model + index ONCE and holds them hot, then serves
 * get_context / propose_memory over a Unix-domain socket. The MCP server and
 * the inject hook become thin clients (see client.ts), so they never reload the
 * ~460MB model per call. Keeps the index fresh via fs.watch (debounced) + a
 * periodic backstop, and sets runtime.managedIngest so the tools skip their own
 * per-request ingest.
 *
 * Run by launchd (RunAtLoad + KeepAlive). Foreground: `librarian daemon`.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { loadConfig } from "./config.js";
import { runCapture, disposeCapture } from "./capture.js";
import { getDb } from "./db.js";
import { embed } from "./embed.js";
import { runtime } from "./runtime.js";
import { disposeSynthesizer } from "./synthesize.js";
import { ingest } from "./store/ingest.js";
import { getContext } from "./tools/getContext.js";
import { injectContext } from "./tools/injectContext.js";
import { proposeMemory } from "./tools/proposeMemory.js";
import {
  appendUsage,
  clipQuery,
  parseSources,
  type UsageType,
} from "./usage.js";

const REINGEST_DEBOUNCE_MS = 1500;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000; // backstop re-ingest
const MAX_BODY_BYTES = 1_000_000; // reject oversized requests (local DoS guard)

function log(msg: string): void {
  console.error(`[librarian-daemon] ${new Date().toISOString()} ${msg}`);
}

export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  mkdirSync(config.runtimeDir, { recursive: true });
  // Restrict the runtime dir to this user (socket/pid/log live here).
  try {
    chmodSync(config.runtimeDir, 0o700);
  } catch {
    /* best-effort */
  }

  // Clear a stale socket from a previous crash so listen() can bind.
  if (existsSync(config.socketPath)) {
    try {
      unlinkSync(config.socketPath);
    } catch {
      /* ignore */
    }
  }

  const db = getDb(config);
  runtime.managedIngest = true; // we own ingest now; tools skip their own

  // Live, in-memory usage counters (since this daemon started). Exposed on
  // /health; the persistent picture lives in usage.jsonl (see record() below).
  const usage = {
    total: 0,
    inject: { fired: 0, silent: 0 },
    get_context: 0,
    propose_memory: 0,
    capture: 0,
  };

  /**
   * Bump the live counters and append a usage line. Called AFTER the response is
   * sent, so telemetry never adds latency. Best-effort — appendUsage swallows.
   */
  const record = (
    type: UsageType,
    query: string,
    injected: boolean,
    latencyMs: number,
    sources: string[],
    count?: number,
  ): void => {
    usage.total++;
    if (type === "inject") {
      if (injected) usage.inject.fired++;
      else usage.inject.silent++;
    } else if (type === "get_context") {
      usage.get_context++;
    } else if (type === "capture") {
      usage.capture++;
    } else {
      usage.propose_memory++;
    }
    appendUsage(config.usagePath, {
      ts: new Date().toISOString(),
      type,
      query: clipQuery(query),
      injected,
      latency_ms: latencyMs,
      sources,
      count,
    });
  };

  log("warming embedding model…");
  await embed(["warmup"], config.embeddingModel, config.modelCachePath);
  const stats = await ingest(db, config);
  log(`indexed ${stats.files} file(s), ${stats.added} new chunk(s)`);

  // Keep the index fresh on corpus changes (debounced) + a periodic backstop.
  let timer: NodeJS.Timeout | null = null;
  const scheduleReingest = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      ingest(db, config).catch((e) => log(`reingest error: ${(e as Error).message}`));
    }, REINGEST_DEBOUNCE_MS);
  };
  try {
    watch(config.corpusPath, { recursive: true }, scheduleReingest);
  } catch {
    log("fs.watch unavailable; relying on periodic backstop");
  }
  const backstop = setInterval(() => {
    ingest(db, config).catch(() => undefined);
  }, MAINTENANCE_INTERVAL_MS);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A client that aborts mid-write (e.g. after a 413) must NOT crash the daemon.
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    const send = (code: number, obj: unknown): void => {
      if (res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && req.url === "/health") {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE superseded_at IS NULL")
        .get() as { n: number };
      send(200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        chunks: row.n,
        model: config.model,
        embeddingModel: config.embeddingModel,
        auth: config.auth,
        usage: {
          total: usage.total,
          inject: { ...usage.inject },
          get_context: usage.get_context,
          propose_memory: usage.propose_memory,
          capture: usage.capture,
        },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/capture") {
      // Auto-write hook: reply IMMEDIATELY (202) so the Stop hook returns fast,
      // then extract + dedup + queue in the BACKGROUND. Fire-and-forget; every
      // error is swallowed so a bad transcript can never crash the daemon.
      let body = "";
      let tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        body += c;
        if (body.length > MAX_BODY_BYTES) {
          tooBig = true;
          send(413, { error: "request too large" });
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        let transcriptPath = "";
        try {
          const args = JSON.parse(body || "{}") as {
            transcript_path?: string;
            transcriptPath?: string;
          };
          transcriptPath = args.transcript_path ?? args.transcriptPath ?? "";
        } catch {
          /* unparseable body → nothing to capture */
        }
        send(202, { accepted: true }); // never make the hook wait on extraction
        if (!transcriptPath) return;
        const t0 = Date.now();
        void runCapture(transcriptPath, config)
          .then(({ queued }) => {
            record(
              "capture",
              transcriptPath,
              queued.length > 0,
              Date.now() - t0,
              [],
              queued.length,
            );
            log(`capture: queued ${queued.length} fact(s) from ${transcriptPath}`);
          })
          .catch((e) => log(`capture error: ${(e as Error).message}`));
      });
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/get_context" ||
        req.url === "/inject" ||
        req.url === "/propose_memory")
    ) {
      const url = req.url;
      let body = "";
      let tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        body += c;
        if (body.length > MAX_BODY_BYTES) {
          tooBig = true;
          send(413, { error: "request too large" });
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        void (async () => {
          try {
            const args = JSON.parse(body || "{}") as {
              query?: string;
              content?: string;
              confirm?: boolean;
            };
            // Measure around the await; log AFTER send so telemetry adds no latency.
            const t0 = Date.now();
            if (url === "/get_context") {
              const query = String(args.query ?? "");
              const answer = await getContext(query);
              send(200, { answer });
              record(
                "get_context",
                query,
                answer.length > 0,
                Date.now() - t0,
                parseSources(answer),
              );
            } else if (url === "/inject") {
              // auto-read hook: gated, then the librarian's Haiku curates
              const query = String(args.query ?? "");
              const answer = await injectContext(query);
              send(200, { answer });
              // injected = the gate actually surfaced context (non-empty answer).
              record(
                "inject",
                query,
                answer.trim().length > 0,
                Date.now() - t0,
                parseSources(answer),
              );
            } else {
              const content = String(args.content ?? "");
              const result = await proposeMemory(content, Boolean(args.confirm));
              send(200, { result });
              record(
                "propose_memory",
                content,
                result.length > 0,
                Date.now() - t0,
                [],
              );
            }
          } catch (e) {
            send(500, { error: (e as Error).message });
          }
        })();
      });
      return;
    }

    send(404, { error: "not found" });
  });

  server.listen(config.socketPath, () => {
    // Restrict the socket to this user — no other local account can connect.
    try {
      chmodSync(config.socketPath, 0o600);
    } catch {
      /* best-effort */
    }
    writeFileSync(config.pidPath, String(process.pid));
    log(`listening on ${config.socketPath} (pid ${process.pid})`);
  });

  const shutdown = (): void => {
    log("shutting down…");
    clearInterval(backstop);
    if (timer) clearTimeout(timer);
    disposeSynthesizer(); // kill the warm synthesis `claude` session
    disposeCapture(); // kill the warm extraction `claude` session
    server.close();
    for (const p of [config.socketPath, config.pidPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
