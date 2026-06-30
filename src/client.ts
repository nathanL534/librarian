/**
 * client — talk to the warm daemon if it's up, else run in-process.
 *
 * The MCP tool handlers and the inject hook call these. When the daemon is
 * listening on the Unix socket, requests are a fast local round-trip (model
 * already hot). When it isn't — or a stale socket refuses — we transparently
 * fall back to the in-process implementation so nothing ever breaks.
 */
import { existsSync } from "node:fs";
import { request } from "node:http";
import { loadConfig } from "./config.js";

// Must exceed a normal synthesis (OAuth ~5-10s); only catches a hung daemon.
const DAEMON_TIMEOUT_MS = 22000;

function daemonPost(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        timeout: DAEMON_TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}") as Record<string, unknown>);
          } catch {
            reject(new Error("bad daemon response"));
          }
        });
      },
    );
    // A hung daemon must not stall the caller (the hook fires on every prompt).
    req.on("timeout", () => req.destroy(new Error("daemon timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function daemonHealth(): Promise<Record<string, unknown> | null> {
  const { socketPath } = loadConfig();
  if (!existsSync(socketPath)) return null;
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/health", method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}") as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

export async function getContextSmart(query: string): Promise<string> {
  const config = loadConfig();
  if (existsSync(config.socketPath)) {
    try {
      const r = await daemonPost(config.socketPath, "/get_context", { query });
      if (typeof r.answer === "string") return r.answer;
    } catch {
      /* stale socket / daemon down → fall through */
    }
  }
  const { getContext } = await import("./tools/getContext.js");
  return getContext(query);
}

/**
 * Auto-read hook path: relevance-gated, then the librarian's Haiku curates.
 *
 * DAEMON-ONLY (no in-process fallback). The hook fires on every prompt, so if
 * the daemon is down we stay SILENT rather than load the ~460MB model in-process
 * (which would add seconds to every prompt). The deliberate get_context tool
 * still falls back in-process — only this global, per-prompt path is daemon-gated.
 */
export async function injectSmart(query: string): Promise<string> {
  const config = loadConfig();
  if (!existsSync(config.socketPath)) return "";
  try {
    const r = await daemonPost(config.socketPath, "/inject", { query });
    if (typeof r.answer === "string") return r.answer;
  } catch {
    /* daemon down/slow → stay silent */
  }
  return "";
}

export async function proposeMemorySmart(
  content: string,
  confirm: boolean,
): Promise<string> {
  const config = loadConfig();
  if (existsSync(config.socketPath)) {
    try {
      const r = await daemonPost(config.socketPath, "/propose_memory", {
        content,
        confirm,
      });
      if (typeof r.result === "string") return r.result;
    } catch {
      /* fall through */
    }
  }
  const { proposeMemory } = await import("./tools/proposeMemory.js");
  return proposeMemory(content, confirm);
}
