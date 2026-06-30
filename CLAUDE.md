# librarian

A local, private, **$0** personal-context **MCP server**. It exposes two tools to an
agent so the user never re-feeds the same documents into a chat again:

- **`get_context(query)`** — answer a question from the user's private markdown corpus.
- **`propose_memory(content, confirm?)`** — save a new note (two-phase: preview, then `confirm:true` to write).

**Status: fully built and validated. This is a finished tool, not a scaffold.**
If you find any "stub / pending / not-yet-implemented" wording anywhere, it's stale — the code is real.

## What it is

- **100% free, no API key.** Embeddings run locally (transformers.js + `Xenova/bge-small-en-v1.5`),
  and synthesis rides the user's OWN `claude` CLI login (OAuth) — it uses their Claude
  subscription, nothing leaves the machine. An optional `auth: "key"` mode exists in config for an
  explicit `ANTHROPIC_API_KEY`, but it is **OFF by default** (`auth: "oauth"`).
- **Markdown is canonical.** The user's `corpus/*.md` is the source of truth; the SQLite +
  `sqlite-vec` index is *derived* and rebuildable — lose it, re-ingest from the markdown.
- **A 24/7 daemon (launchd) is the warm core.** It keeps the embedding model and a persistent
  `claude` session hot. The MCP server and the hooks are thin clients of the daemon (instant when it's up).

## How it works

```
corpus/*.md  →  local embeddings + sqlite-vec  →  vector recall
             →  4-factor re-rank (recency / popularity / graph / importance)
             →  the librarian's OWN warm Claude synthesizes a grounded answer with sources
```

Two Claude Code hooks make it automatic (installed by `init --with-hooks`):

- **auto-read** — `UserPromptSubmit` → relevance-gated → injects relevant context into the prompt.
  Stays silent when nothing in the corpus matches; has a hard deadline so it can never stall a prompt.
- **auto-write** — `Stop` → extracts durable facts from the session into `corpus/pending/`, a
  **REVIEW QUEUE**. Pending facts are **NOT retrieved until promoted**, so a bad extraction can
  never pollute retrieval. List the queue with `review`.

Usage telemetry is appended to `~/.librarian/usage.jsonl` and surfaced by `stats`.

## Commands

All run via `node dist/server.js <cmd>`:

| Command | What it does |
|---------|--------------|
| `init [--daemon] [--with-hooks]` | The one-shot installer (see Install). Idempotent + reversible. |
| `uninstall` | Reverse everything — unloads the daemon, removes the hooks. **Never deletes the corpus or config.** |
| `daemon` | Run the daemon in the foreground (normally `launchd` runs it). |
| `daemon-status` | Is the daemon up, plus a health check. |
| `stats` | Usage: fire count, inject hit-rate, latency, recent queries. |
| `review` | List the pending auto-captured facts awaiting approval. |
| `query "<question>"` | Ask the librarian directly from the CLI. |
| `inject` / `capture` | Hook entrypoints (auto-read / auto-write) — invoked by Claude Code, not by hand. |

## Install (the agent-facing path)

To set this up for a user, run the deterministic installer — **do not hand-edit their config**:

```bash
npm install
npm run build
node dist/server.js init --daemon --with-hooks
```

`init` is **idempotent and reversible**. Base run registers the MCP server via `claude mcp add`
and creates the gitignored `corpus/`. `--daemon` installs the launchd warm process. `--with-hooks`
wires the auto-read + auto-write hooks into `~/.claude/settings.json` — **after backing it up first**.
Global hooks load at session start, so they take effect in a *new* Claude session, not the one `init` ran from.

> Install only ever runs from this explicit command. Never auto-install as a side effect of
> scanning the repo, and never run `init` without the user's intent — silently editing a user's
> settings is a supply-chain smell.

## Dev

```bash
npm install
npm run build
```

Requires **Node 22+**, the **`claude` CLI installed and logged in** (for free synthesis), and
**macOS** for the launchd daemon.

## Hard safety rules (for any agent working in this repo)

This repo is **public** and is meant to live right next to the user's private personal-context notes.

- **`corpus/` is the user's private life data — it is gitignored. NEVER commit it.**
- **NEVER `git add -f`** `corpus/`, `.env`, `*.db`, `*.sqlite`, `config.json`, or `models/` — the
  `-f` flag is the one way to defeat the `.gitignore` protections. Don't use it.
- The **only** committed corpus content is the fake `corpus.example/`. Never put real personal
  content anywhere tracked by git.
- Before any commit, sanity-check with `git status` that no private file is staged. If you're about
  to stage anything outside the tool code + examples, **stop**.

## More

- **`README.md`** — setup, usage, prerequisites, troubleshooting.
- **`ARCHITECTURE.md`** — the data model, retrieval flow, daemon/hook design, and reuse-vs-reimplement map.
