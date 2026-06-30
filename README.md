# librarian

A local, private, **$0** personal-context **MCP server**.

Agents call two tools:

- **`get_context(query)`** — retrieve relevant context about you.
- **`propose_memory(content)`** — save new context.

So you never re-feed the same documents into a chat again. Your markdown notes
are the source of truth; a SQLite + `sqlite-vec` index is *derived* from them.

Why it's free and private:

- **Embeddings run locally** — transformers.js + `bge-small-en-v1.5`. No API call, nothing leaves your machine.
- **Synthesis uses the librarian's OWN Claude** via your existing `claude` CLI login (OAuth). **No API key. Completely free** — it rides your Claude subscription.
- **A 24/7 warm daemon** keeps the embedding model and a persistent `claude` session hot, so retrieval and synthesis are fast.
- **Two Claude Code hooks make it automatic:** auto-READ injects relevant context on every prompt; auto-WRITE extracts durable new facts when a session ends, into a review queue.

---

## Prerequisites

- **Node 22+**
- The **`claude` CLI installed and logged in** — the librarian shells out to it for free synthesis.
- **macOS** for the auto-start daemon (it uses `launchd`).

> **Linux note:** there's no `launchd` or Keychain. The daemon would need a
> manual or `systemd` start, and your Claude credentials live in
> `~/.claude/.credentials.json` instead of the macOS Keychain.

---

## Setup

```bash
npm install
npm run build
node dist/server.js init --daemon --with-hooks
```

`init` is the one-shot installer. It is **idempotent and reversible**. The flags:

| Flag | What it does |
|------|--------------|
| (base) | Registers the MCP server with Claude via `claude mcp add`. |
| `--daemon` | Installs the `launchd` daemon so the warm process autostarts 24/7. |
| `--with-hooks` | Wires the auto-read + auto-write Claude Code hooks into `~/.claude/settings.json` — **after backing it up first**. |

**Then start a fresh Claude session.** Global hooks are read at session start, so
they take effect in *new* sessions — not the one you ran `init` from.

---

## Add your own notes

Drop markdown files into `corpus/`:

```bash
# corpus/ is gitignored — your private data never leaves your machine
mkdir -p corpus
cp corpus.example/example-note.md corpus/   # see the expected shape
```

See `corpus.example/` for the shape of a note. The daemon **auto-ingests on
change**, so new and edited files are picked up automatically.

---

## How it works

```
your markdown (corpus/)  →  local embeddings + sqlite-vec  →  vector recall
                         →  4-factor re-rank (recency / popularity / graph / importance)
                         →  the librarian's OWN warm Claude synthesizes a grounded answer
```

- **Markdown is canonical.** The SQLite index is derived and rebuildable — lose it, re-ingest from the markdown.
- **The auto-read hook is relevance-gated** — it stays silent when nothing in your corpus matches.
- **The auto-write hook queues facts to `corpus/pending/`.** Those facts are **NOT retrieved until you promote them** (review-queue mode) — so a bad extraction can never pollute retrieval.

---

## Commands

All commands run via `node dist/server.js <cmd>`:

| Command | What it does |
|---------|--------------|
| `init [--daemon] [--with-hooks]` | Install (see [Setup](#setup)). |
| `uninstall` | Reverse everything — unloads the daemon, removes the hooks. **Leaves your corpus and config intact; your data is never deleted.** |
| `daemon` | Run the daemon in the foreground (normally `launchd` runs it for you). |
| `daemon-status` | Is the daemon up, plus a health check. |
| `stats` | Usage: how often it fired, inject hit-rate, latency, recent queries (read from `~/.librarian/usage.jsonl`). |
| `review` | List the pending auto-captured facts awaiting your approval. |
| `query "<question>"` | Ask the librarian directly from the CLI. |

```bash
node dist/server.js query "what coffee do I drink?"
node dist/server.js daemon-status
node dist/server.js review
```

---

## Free + private

- **$0 and no API key.** Local embeddings + your Claude subscription via OAuth.
- **Everything stays local and gitignored** — the corpus, the SQLite index, the embedding-model cache, the usage log, and the daemon socket. Nothing leaves your machine.

> There is an **optional** `auth: "key"` mode in config for an explicit
> `ANTHROPIC_API_KEY` if you want faster synthesis — but it's **off by
> default**. The default is `auth: "oauth"`, which is free.

---

## Troubleshooting

- **Daemon log:** `~/.librarian/daemon.log` — start here when something's off.
- **macOS Keychain prompt:** the first time the `launchd` daemon spawns `claude`,
  it may need a one-time Keychain **"allow access"** (the daemon reads your
  Claude login from the Keychain). If synthesis isn't working, check the daemon
  log and your Keychain.
- **Restart the daemon** via `launchctl` (kickstart, or unload + load the
  `com.librarian.daemon` agent), or just run `uninstall` and re-run `init`.

---

## Safety

This repo is **public** and is meant to live right next to your private
personal-context notes on your own machine. `corpus/` is **your private data and
is gitignored.**

**Hard rules:**

- **NEVER** `git add -f` (force-add) `corpus/`, `.env`, `*.db`, or `config.json` —
  the `-f` flag is the one way to defeat the `.gitignore` protections. Don't use it.
- The **only** committed corpus content is the fake `corpus.example/`. Never put
  real personal content anywhere tracked by git.
- Before any commit, sanity-check with `git status` that no private file is staged.

---

## License

MIT
