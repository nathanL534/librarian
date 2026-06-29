/**
 * init / uninstall — the deterministic, reversible installer.
 *
 *   librarian init [--with-hooks]   register MCP server, create config+corpus,
 *                                   optionally wire the auto-read hook
 *   librarian uninstall             reverse it (never deletes your corpus/config)
 *
 * Principles: idempotent, backs up settings.json before touching it, and never
 * runs as a side effect of anything — only from this explicit command.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// dist/commands/init.js -> package root is two levels up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(PACKAGE_ROOT, "dist", "server.js");
const HOOK_MARKER = "server.js inject"; // identifies the hook we own

function log(msg = ""): void {
  console.log(msg);
}

export async function runInit(): Promise<void> {
  const withHooks = process.argv.includes("--with-hooks");

  // 1. config.json (absolute corpus path so the MCP host can spawn us anywhere)
  const configPath = join(PACKAGE_ROOT, "config.json");
  if (!existsSync(configPath)) {
    const example = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "config.example.json"), "utf8"),
    ) as Record<string, unknown>;
    example.corpusPath = join(PACKAGE_ROOT, "corpus");
    writeFileSync(configPath, `${JSON.stringify(example, null, 2)}\n`);
    log(`created config.json (corpus: ${String(example.corpusPath)})`);
  } else {
    log("config.json already exists — left as-is");
  }

  // 2. corpus dir (gitignored)
  const corpusDir = join(PACKAGE_ROOT, "corpus");
  mkdirSync(corpusDir, { recursive: true });
  log(`corpus ready: ${corpusDir}`);

  // 3. register the MCP server with Claude (user scope, idempotent)
  registerMcp();

  // 4. hooks (opt-in)
  if (withHooks) {
    wireHooks();
  } else {
    log("");
    log("Auto-read hook NOT installed. Re-run with --with-hooks to inject");
    log("relevant context on every prompt (settings.json is backed up first).");
  }

  log("");
  log("Done. Start a new Claude session — the librarian's tools are available.");
}

export async function runUninstall(): Promise<void> {
  try {
    execFileSync("claude", ["mcp", "remove", "librarian", "--scope", "user"], {
      stdio: "inherit",
    });
    log("removed MCP server 'librarian'");
  } catch {
    log("could not remove MCP server automatically (claude CLI not found?)");
  }

  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
      const ups = settings.hooks?.UserPromptSubmit;
      if (Array.isArray(ups)) {
        settings.hooks!.UserPromptSubmit = ups.filter(
          (e) => !JSON.stringify(e).includes(HOOK_MARKER),
        );
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        log("removed auto-read hook");
      }
    } catch {
      /* leave settings untouched on parse failure */
    }
  }
  log("Left your corpus and config.json in place (your data is never deleted).");
}

function registerMcp(): void {
  try {
    try {
      execFileSync("claude", ["mcp", "remove", "librarian", "--scope", "user"], {
        stdio: "ignore",
      });
    } catch {
      /* nothing to remove */
    }
    execFileSync(
      "claude",
      ["mcp", "add", "librarian", "--scope", "user", "--", "node", SERVER_ENTRY],
      { stdio: "inherit" },
    );
    log("registered MCP server 'librarian' (user scope)");
  } catch {
    log("could not run `claude mcp add` automatically. Add this manually:");
    log(`  claude mcp add librarian --scope user -- node ${SERVER_ENTRY}`);
  }
}

interface Settings {
  hooks?: {
    UserPromptSubmit?: unknown[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function wireHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    } catch {
      settings = {};
    }
  }
  settings.hooks ??= {};
  const ups = (settings.hooks.UserPromptSubmit ??= []) as unknown[];

  if (JSON.stringify(ups).includes(HOOK_MARKER)) {
    log("auto-read hook already present — left as-is");
    return;
  }
  ups.push({
    hooks: [{ type: "command", command: `node ${SERVER_ENTRY} inject` }],
  });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`wired auto-read hook into ${settingsPath} (backup saved)`);
}
