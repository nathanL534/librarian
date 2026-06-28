#!/usr/bin/env node
/**
 * librarian — a personal-context MCP server (STUBS ONLY).
 *
 * This is the MCP entry point. It exposes two tools over stdio that an MCP
 * client (e.g. Claude Desktop / Claude Code) can call. The real retrieval and
 * synthesis logic is intentionally NOT implemented here yet — these are stubs.
 * The real implementation will land later from a separate architecture
 * blueprint.
 *
 * Tools registered:
 *
 *   get_context(query)
 *     Answer a question using the user's private markdown corpus.
 *     Intended behavior: if the whole corpus fits the model's token budget,
 *     load all of it; otherwise hybrid-retrieve the top-k most relevant chunks
 *     (vector + keyword, RRF-fused), then synthesize an answer with Haiku.
 *
 *   propose_memory(content)
 *     Propose a new note/memory to persist into the corpus.
 *     Intended behavior: dedup against existing notes -> show a diff ->
 *     on user confirmation, write a new .md file into corpus/ and re-ingest it.
 *
 * SAFETY: the corpus/, the vector DB, .env, and the embedding model are all
 * gitignored. Nothing in this server should ever write user content outside
 * the configured corpusPath.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getContext } from "./tools/getContext.js";
import { proposeMemory } from "./tools/proposeMemory.js";

const NOT_IMPLEMENTED = "not implemented yet";

const server = new Server(
  {
    name: "librarian",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_context",
      description:
        "Answer a question from the user's private markdown corpus. " +
        "Loads the whole corpus if it fits the token budget, otherwise " +
        "hybrid-retrieves the top-k relevant chunks and synthesizes with Haiku.",
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
        "Propose a new note to persist into the corpus. Dedups against " +
        "existing notes, shows a diff, and on confirmation writes a new .md " +
        "file and re-ingests it.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The note/memory text to persist.",
          },
        },
        required: ["content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // STUBS: each tool currently returns a "not implemented yet" message.
  switch (name) {
    case "get_context": {
      const result = await getContext(String(args?.query ?? ""));
      return { content: [{ type: "text", text: result ?? NOT_IMPLEMENTED }] };
    }
    case "propose_memory": {
      const result = await proposeMemory(String(args?.content ?? ""));
      return { content: [{ type: "text", text: result ?? NOT_IMPLEMENTED }] };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("librarian MCP server running on stdio (stub mode)");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting librarian:", err);
  process.exit(1);
});
