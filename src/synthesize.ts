/**
 * synthesize — the librarian's OWN Claude turns context into a grounded answer.
 *
 * Independent of whatever host agent invoked the tool: the librarian is the
 * neutral gatekeeper. Two auth modes (config.auth):
 *   - "oauth" (default): spawn `claude -p` — reuses the user's existing CLI
 *     login, no API key. Prompt caching is opaque but fine for a single user.
 *   - "key": @anthropic-ai/sdk with explicit prompt caching on the context block.
 */
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";

const SYSTEM_PROMPT =
  "You are the user's personal librarian. Answer the question using ONLY the " +
  "provided context from their private notes. Be concise and concrete. If the " +
  "context does not contain the answer, say so plainly — never invent facts.";

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
  const prompt = `${SYSTEM_PROMPT}\n\nCONTEXT:\n${context}\n\nQUESTION: ${query}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--model", config.model, "--output-format", "json"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolve((parsed.result ?? "").trim());
      } catch {
        resolve(stdout.trim()); // tolerate non-JSON output
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
