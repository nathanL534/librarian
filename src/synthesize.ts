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
  "You are the user's personal librarian. Answer the question using ONLY the " +
  "provided context from their private notes. Be concise and concrete. If the " +
  "context does not contain the answer, say so plainly — never invent facts.";

let persistent: PersistentClaude | null = null;

/** Tear down the warm OAuth session (called on daemon shutdown). */
export function disposeSynthesizer(): void {
  persistent?.dispose();
  persistent = null;
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
