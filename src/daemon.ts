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
import { existsSync, mkdirSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { embed } from "./embed.js";
import { runtime } from "./runtime.js";
import { ingest } from "./store/ingest.js";
import { getContext } from "./tools/getContext.js";
import { proposeMemory } from "./tools/proposeMemory.js";
import { retrieveContext } from "./tools/retrieveContext.js";

const REINGEST_DEBOUNCE_MS = 1500;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000; // backstop re-ingest

function log(msg: string): void {
  console.error(`[librarian-daemon] ${new Date().toISOString()} ${msg}`);
}

export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  mkdirSync(config.runtimeDir, { recursive: true });

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
    const send = (code: number, obj: unknown): void => {
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
      });
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/get_context" ||
        req.url === "/retrieve" ||
        req.url === "/propose_memory")
    ) {
      const url = req.url;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            const args = JSON.parse(body || "{}") as {
              query?: string;
              content?: string;
              confirm?: boolean;
            };
            if (url === "/get_context") {
              send(200, { answer: await getContext(String(args.query ?? "")) });
            } else if (url === "/retrieve") {
              // cheap path (no LLM) — used by the auto-read hook
              send(200, await retrieveContext(String(args.query ?? "")));
            } else {
              send(200, {
                result: await proposeMemory(
                  String(args.content ?? ""),
                  Boolean(args.confirm),
                ),
              });
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
    writeFileSync(config.pidPath, String(process.pid));
    log(`listening on ${config.socketPath} (pid ${process.pid})`);
  });

  const shutdown = (): void => {
    log("shutting down…");
    clearInterval(backstop);
    if (timer) clearTimeout(timer);
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
