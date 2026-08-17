/**
 * synthesize — the librarian's OWN Claude turns context into a grounded answer.
 *
 * Independent of whatever host agent invoked the tool: the librarian is the
 * neutral gatekeeper. Two auth modes (config.auth):
 *   - "oauth" (default): a warm PERSISTENT `claude` session (reuses the user's
 *     existing CLI login, no API key) — spawned once, reused per query.
 *   - "key": @anthropic-ai/sdk with explicit prompt caching on the context block.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { PersistentClaude } from "./persistentClaude.js";

const SYSTEM_PROMPT =
  "You are the user's personal librarian. Use ONLY the provided context from " +
  "their private notes. Be concise and concrete. NEVER invent facts, examples, " +
  "scenarios, or advice that is not literally present in the context — if the " +
  "context doesn't cover it, say so in one short line (or reply exactly NONE). " +
  "Do not answer from your own general knowledge; only from their notes.";

let persistent: PersistentClaude | null = null;

/**
 * True when the warm OAuth session has a turn in flight (or queued). A new
 * query would serialize behind it (persistentClaude.ts) and cannot answer
 * promptly — deadline-bound callers (the inject hook) should skip synthesis
 * rather than enqueue. Key-auth calls are independent HTTP requests: never busy.
 */
export function synthesizerBusy(config: Config): boolean {
  return config.auth === "oauth" && (persistent?.busy ?? false);
}

/** Tear down the warm OAuth session (called on daemon shutdown). */
export function disposeSynthesizer(): void {
  persistent?.dispose();
  persistent = null;
}

/**
 * Spawn + warm the OAuth persistent `claude` session at daemon startup, so the
 * FIRST real query doesn't pay the ~10s cold-spawn cost on top of synthesis
 * (which would blow the per-query timeout). Best-effort: if it fails, the first
 * query is just slower. No-op on the key path (no persistent process).
 */
export async function warmSynthesizer(config: Config): Promise<void> {
  if (config.auth !== "oauth") return;
  try {
    await synthesize("Reply with: ready", "(warmup — no real context)", config);
  } catch {
    /* best-effort */
  }
}

export async function synthesize(
  query: string,
  context: string,
  config: Config,
): Promise<string> {
  return config.auth === "key"
    ? synthesizeWithKey(query, context, config)
    : synthesizeWithOAuth(query, context, config);
}

async function synthesizeWithKey(
  query: string,
  context: string,
  config: Config,
): Promise<string> {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      {
        type: "text",
        text: `CONTEXT:\n${context}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: query }],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
}

function synthesizeWithOAuth(
  query: string,
  context: string,
  config: Config,
): Promise<string> {
  // Reuse one warm `claude` session: the system prompt is set once at spawn,
  // each query carries its own retrieved context. No per-call CLI startup.
  if (!persistent) persistent = new PersistentClaude(config.model, SYSTEM_PROMPT);
  return persistent.query(`CONTEXT:\n${context}\n\nQUESTION: ${query}`);
}
