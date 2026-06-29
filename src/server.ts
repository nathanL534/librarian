#!/usr/bin/env node
/**
 * librarian — a personal-context MCP server.
 *
 * Exposes two tools over stdio to an MCP host (Claude Code / Claude Desktop):
 *
 *   get_context(query)
 *     Answer a question from the user's private markdown corpus. Loads the whole
 *     corpus if it fits the token budget, else vector-retrieves the top-k chunks
 *     (4-factor re-ranked) and synthesizes with the librarian's own Claude.
 *
 *   propose_memory(content, confirm?)
 *     Two-phase write. Without confirm: dedup-check + preview. With confirm:
 *     write a new .md into corpus/ (superseding a near-identical note) + re-ingest.
 *
 * The bin also serves CLI subcommands: `librarian init` / `librarian uninstall`.
 *
 * SAFETY: corpus/, the index DB, .env, and the model cache are all gitignored.
 * Nothing here writes user content outside the configured corpusPath.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getContextSmart,
  proposeMemorySmart,
  retrieveContextSmart,
} from "./client.js";

const server = new Server(
  { name: "librarian", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_context",
      description:
        "Answer a question from the user's private markdown corpus. Loads the " +
        "whole corpus if it fits the token budget, otherwise vector-retrieves " +
        "the top-k relevant chunks (re-ranked by recency/popularity/importance) " +
        "and synthesizes a grounded answer with sources.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The question to answer from personal context.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "propose_memory",
      description:
        "Persist a new note into the corpus. Call once with confirm omitted to " +
        "get a dedup check + preview, then again with confirm:true to actually " +
        "write it. Writes only ever go into the gitignored corpus/.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The note/memory text to persist.",
          },
          confirm: {
            type: "boolean",
            description:
              "false/omitted = preview only; true = write to corpus and re-ingest.",
          },
        },
        required: ["content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "get_context": {
        const result = await getContextSmart(String(args?.query ?? ""));
        return { content: [{ type: "text", text: result }] };
      }
      case "propose_memory": {
        const result = await proposeMemorySmart(
          String(args?.content ?? ""),
          Boolean(args?.confirm),
        );
        return { content: [{ type: "text", text: result }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("librarian MCP server running on stdio");
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const sub = process.argv[2];

  if (sub === "init" || sub === "uninstall") {
    const { runInit, runUninstall } = await import("./commands/init.js");
    await (sub === "init" ? runInit() : runUninstall());
    return;
  }

  if (sub === "daemon") {
    const { runDaemon } = await import("./daemon.js");
    await runDaemon();
    return; // runDaemon keeps the process alive
  }

  if (sub === "daemon-status") {
    const { daemonHealth } = await import("./client.js");
    const health = await daemonHealth();
    if (health) {
      console.log(`librarian daemon UP: ${JSON.stringify(health)}`);
    } else {
      console.log("librarian daemon is not running.");
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "query") {
    // CLI query path — uses the daemon if up, else in-process.
    console.log(await getContextSmart(process.argv.slice(3).join(" ")));
    return;
  }

  if (sub === "inject") {
    // Claude Code UserPromptSubmit hook: read the prompt from stdin JSON, print
    // relevant context to stdout (the harness adds it to the model's context).
    // Uses the warm daemon when up (instant); must NEVER block the prompt.
    const input = await readStdin();
    let prompt = input.trim();
    try {
      prompt = (JSON.parse(input) as { prompt?: string }).prompt ?? prompt;
    } catch {
      /* not JSON — use the raw text */
    }
    if (prompt) {
      try {
        // retrieve-only (no synthesis) → fast; stays silent when nothing matches
        const ctx = await retrieveContextSmart(prompt);
        if (ctx.trim()) {
          console.log(`# Relevant personal context (librarian)\n\n${ctx}`);
        }
      } catch {
        /* swallow — a librarian failure must not break the user's prompt */
      }
    }
    return;
  }

  await startServer();
}

main().catch((err) => {
  console.error("Fatal error in librarian:", err);
  process.exit(1);
});
