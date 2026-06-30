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
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// dist/commands/init.js -> package root is two levels up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(PACKAGE_ROOT, "dist", "server.js");
// Markers identifying the hooks we own. They must be substrings of the
// JSON-stringified hook entry: the command is `node "<path>/server.js" <sub>`,
// so after JSON-escaping the path's closing quote sits right before the
// subcommand (`…server.js\" inject`). Matching on the escaped quote + subcommand
// (`" inject` / `" capture`) is therefore both reliable and unique.
const HOOK_MARKER = '" inject'; // UserPromptSubmit auto-read hook
const HOOK_MARKER_STOP = '" capture'; // Stop auto-write hook

function log(msg = ""): void {
  console.log(msg);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function runInit(): Promise<void> {
  const withHooks = process.argv.includes("--with-hooks");
  const withDaemon = process.argv.includes("--daemon");

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

  // 4. daemon (opt-in) — the always-on warm process
  if (withDaemon) {
    installDaemon();
  } else {
    log("");
    log("Daemon NOT installed. Re-run with --daemon for the 24/7 warm process");
    log("(keeps the model hot so hooks are instant + runs background refresh).");
  }

  // 5. hooks (opt-in)
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

  uninstallDaemon();

  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-${Date.now()}`);
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
      let changed = false;
      const ups = settings.hooks?.UserPromptSubmit;
      if (Array.isArray(ups)) {
        settings.hooks!.UserPromptSubmit = ups.filter(
          (e) => !JSON.stringify(e).includes(HOOK_MARKER),
        );
        changed = true;
        log("removed auto-read hook");
      }
      const stop = settings.hooks?.Stop;
      if (Array.isArray(stop)) {
        settings.hooks!.Stop = stop.filter(
          (e) => !JSON.stringify(e).includes(HOOK_MARKER_STOP),
        );
        changed = true;
        log("removed auto-write hook");
      }
      if (changed) {
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      }
    } catch {
      /* leave settings untouched on parse failure */
    }
  }
  log("Left your corpus and config.json in place (your data is never deleted).");
}

const PLIST_LABEL = "com.librarian.daemon";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

function installDaemon(): void {
  const runtimeDir = join(homedir(), ".librarian");
  const logPath = join(runtimeDir, "daemon.log");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });

  // launchd runs with a minimal PATH; the OAuth synth path spawns `claude`, so
  // make sure its directory (and the usual bin dirs) are on PATH.
  let claudeDir = "/usr/local/bin";
  try {
    claudeDir = dirname(
      execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
    );
  } catch {
    /* fall back to defaults */
  }
  const pathEnv = `${claudeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(SERVER_ENTRY)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEscape(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath(), plist);
  try {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  try {
    execFileSync("launchctl", ["load", "-w", plistPath()], { stdio: "inherit" });
    log(`installed + started the 24/7 daemon (logs: ${logPath})`);
  } catch {
    log("wrote launchd plist but `launchctl load` failed. Start it manually:");
    log(`  launchctl load -w ${plistPath()}`);
  }
}

function uninstallDaemon(): void {
  const p = plistPath();
  if (!existsSync(p)) {
    log("no launchd daemon installed");
    return;
  }
  try {
    execFileSync("launchctl", ["unload", "-w", p], { stdio: "ignore" });
  } catch {
    /* already unloaded */
  }
  try {
    rmSync(p);
    log("removed launchd daemon");
  } catch {
    /* ignore */
  }
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
    Stop?: unknown[];
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
  const stop = (settings.hooks.Stop ??= []) as unknown[];

  // Auto-read: inject relevant context on every prompt (UserPromptSubmit).
  if (JSON.stringify(ups).includes(HOOK_MARKER)) {
    log("auto-read hook already present — left as-is");
  } else {
    ups.push({
      // quote the path so an install dir with spaces still tokenizes correctly
      hooks: [{ type: "command", command: `node "${SERVER_ENTRY}" inject` }],
    });
    log("wired auto-read hook (UserPromptSubmit → inject)");
  }

  // Auto-write: extract durable facts when a session ends (Stop) and queue them
  // for review. Fires fast and never blocks shutdown (see server.ts `capture`).
  if (JSON.stringify(stop).includes(HOOK_MARKER_STOP)) {
    log("auto-write hook already present — left as-is");
  } else {
    stop.push({
      hooks: [{ type: "command", command: `node "${SERVER_ENTRY}" capture` }],
    });
    log("wired auto-write hook (Stop → capture)");
  }

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`updated ${settingsPath} (backup saved)`);
}
