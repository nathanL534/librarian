# librarian — Architecture

The internal design/architecture reference for the librarian. **BUILT + VALIDATED** — this documents the system as implemented, not a plan to execute. Derived from a code-level teardown of `@iachilles/memento` and `basic-memory`, plus our design decisions.

## Principles

- **Markdown is canonical** (steal from basic-memory): the user's `.md` files in `corpus/` are the source of truth. The SQLite DB is a *derived, rebuildable index* — if it's lost, re-ingest from the markdown.
- **Vector-first recall, light graph as a re-rank *assist* — never graph-primary.** Vector search finds things; a sparse entity-graph only *boosts* related results. Degrades gracefully: no graph → still full vector recall.
- **Load everything while it fits.** The agent gets the *maximal* context that fits the budget; retrieval only kicks in when the corpus overflows.
- **The librarian has its OWN model — independence is the point.** Embeddings run locally (transformers.js). For both *what to return* (selection) and *what to ingest*, the librarian calls its **own** Claude, separate from the host Claude — so memory decisions are a neutral, consistent gatekeeper, never biased by the caller's current task. The host asks; the librarian decides. The librarian supports **both** auth modes — pick at install via `auth: "oauth" | "key"` (default `oauth`):
  - **OAuth (default, easiest) — "Option B", a persistent warm session (`persistentClaude.ts`):** free via the user's existing Claude login, no key to manage. (The Agent SDK's OAuth is *not* permitted for third-party apps, so the OAuth path is specifically the `claude` CLI.) Rather than spawning `claude -p` per call, ONE `claude -p --input-format stream-json --output-format stream-json` process is spawned once and **reused across every query** — no per-call CLI startup cost. Queries are serialized (one turn at a time); the process is **recycled every N turns** (`MAX_TURNS = 8`) to bound conversation-history growth, and respawned lazily if it dies. Prompt caching is automatic/opaque — fine for single-user.
  - **API key (opt-in):** `ANTHROPIC_API_KEY` from `.env` via `@anthropic-ai/sdk` — gives explicit prompt-cache control (`cache_control: ephemeral` on the corpus block) and works even without Claude Code installed.

  Either way the librarian's call is **independent of the host** — that's the requirement; the credential is just convenience.
- **Read freely, write carefully.** Writes go through propose→confirm; the human is the reconciliation engine.

## Data model (SQLite + sqlite-vec)

```
corpus/*.md                         ← canonical, user-owned, gitignored

chunks(id, file_path, heading, content, content_hash, created_at, updated_at,
       last_accessed, access_count, importance, superseded_at)
chunks_vec  USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[384] distance_metric=cosine)
entities(id, name UNIQUE, type)               ← optional, for the graph-assist re-rank
relations(from_id, to_id, type, UNIQUE(...))  ← optional edges
chunk_entities(chunk_id, entity_id, UNIQUE)   ← which chunks mention which entities
```

`content_hash` drives incremental ingest (skip unchanged chunks, keep their access stats).
`superseded_at` is the soft-delete stamp (kept for history, dropped from the hot set).
No FTS table (memento dropped it; revisit only if exact-term recall proves weak).

## `get_context(query)` flow

```
1. corpus fits token budget?  →  load ALL chunks → librarian's OWN Haiku selects+synthesizes → answer + sources
2. too big?                   →  embed query (local) → sqlite-vec cosine top-k*2
                                 → 4-FACTOR RE-RANK → top-k → librarian's OWN Haiku synthesizes → answer + sources

The librarian's own Claude (NOT the host) decides relevance & phrasing — an independent, neutral
gatekeeper, so the caller can't bias what it picks. Synthesis reuses the warm OAuth session (Option B):
the system prompt is set once at spawn and each query carries its own retrieved context; the session is
recycled every N turns so history can't bloat. (On the key path the context block is sent with
`cache_control: ephemeral`, so the prompt prefix is cached instead.)
```

**4-factor re-rank** (the genuinely clever steal — adapt from memento's `scoring-utils.js`):
- recency / temporal decay (~40%, 30-day half-life)
- popularity (~20%, log-scaled `access_count`)
- **graph-context BFS distance (~20%)** — boost chunks whose entities are near recently-accessed entities. *This is the "traverse to related stuff" you wanted.* Optional: no entities populated → factor is inert.
- importance (~20%)

Bump `access_count`/`last_accessed` on every hit.

## `propose_memory(fact)` flow

```
dedup vs existing chunks → show the user a diff → on CONFIRM → write/update a .md in corpus/ → re-ingest that file
```

Append-only is the failure mode (corpus rot). Dedup + the confirm gate prevent it.

## Temporal metadata & memory lifecycle

Every chunk carries `created_at`, `updated_at`, `last_accessed`, `access_count`, and optional `superseded_at`. These power the recency re-rank, staleness detection, and reconciliation (which of two conflicting facts is newer).

**Forgetting is de-prioritize + archive, NEVER hard-delete** — you can't lose something you needed:
- **Decay:** the re-rank down-weights old/unused chunks — they sink but stay searchable on demand.
- **Supersede, don't erase:** a contradicting new fact stamps the old with `superseded_at` (kept, with history) instead of deleting.
- **Archive:** cold chunks move to `corpus/archive/` — out of the hot set, still searchable explicitly. Reversible.

**Two cleanup mechanisms, different jobs:**
- **Dynamic (on write):** `propose_memory` dedups + supersedes immediately — consistency as you go.
- **Periodic (cron):** a scheduled background agent reviews for staleness/duplication/consolidation and **PROPOSES** archive/merge — you approve. Never auto-deletes. (Same fire-and-forget pattern as the capture hook; implement via Claude Code `/schedule` or local cron.)

Corpus is git-versioned, so even an approved cleanup is fully reversible. Lean conservative: aggressive auto-forgetting causes drift and data loss.

## Reimplement vs reuse (~470 lines total)

| Component | Decision |
|---|---|
| MCP protocol | **reuse** `@modelcontextprotocol/sdk` |
| Embeddings | **reuse** `@huggingface/transformers` (the renamed `@xenova/transformers`), model `Xenova/bge-small-en-v1.5` (384-dim, ~460MB on first download) |
| Vector ANN | **reuse** `sqlite-vec` |
| Storage layer | **build** (~120 lines — schema is simple) |
| 4-factor scoring | **build** (~80 lines — adapt memento) |
| Graph-BFS scorer | **build** (~50 lines over `relations`) |
| Synthesis (read) | **build** — the librarian's OWN warm Haiku synthesizes, independent of the host. OAuth path = a persistent `claude` stream-json session (`persistentClaude.ts`), reused per query + recycled every N turns; key path = `@anthropic-ai/sdk` with `cache_control: ephemeral` on the context block |
| Auto-write capture | **build** — a SEPARATE warm extraction `claude` session pulls durable facts from the session transcript → dedup → `corpus/pending/` review queue (`capture.ts`) |

## Enforcement (fire-and-forget — Claude Code hooks)

Hooks are run by the harness deterministically, so the model can't forget them. This is what makes it automatic, not optional. Both hooks are **daemon-only** (no in-process fallback): they fire on every prompt / every session end, so if the daemon is down they stay silent rather than load the ~460MB model in a one-shot process.

- **Auto-read** (`UserPromptSubmit` → `inject`): a cheap deterministic relevance gate (vector similarity, ~10ms) runs FIRST; only when something in the corpus genuinely matches does the librarian's own Haiku curate + synthesize (the same path as `get_context`). Unrelated prompts stay silent — Haiku never wakes. A hard ~24s deadline guarantees the hook can never stall a prompt. Every session already knows the user.
- **Auto-write** (`Stop` → `capture`) — the **review-queue design** (built):
  1. The Stop hook hands the finished session's transcript path to the daemon's `/capture`, which replies **202 immediately** so session shutdown never blocks.
  2. In the background, a SEPARATE warm extraction `claude` session (its own `PersistentClaude`, distinct from the synthesis one) pulls DURABLE facts about the user from the transcript tail (capped ~24k chars to stay within the turn timeout).
  3. Facts are deduped against the LIVE corpus (embedding nearest-match; ≥0.9 cosine = already known → dropped).
  4. Survivors are appended to `corpus/pending/<date>.md` — a **review queue**. `ingest` SKIPS `pending/` (and `archive/`), so captured facts are NEVER retrieved until promoted.
  5. `librarian review` prints the queue; the user promotes approved facts into a real corpus note (e.g. via `propose_memory`), then clears them from the pending file. No auto-commit to the live corpus → no corpus rot.
- **Cost:** the extractor runs on Haiku over the free OAuth session, fire-and-forget — never blocks shutdown, never a full agent per turn.

## Warm daemon (the 24/7 process)

The MCP server and hooks are short-lived — each would reload the ~460MB embed model on every spawn. The daemon fixes that: **one long-lived process holds the model + index + the warm synthesis session hot** and serves requests over a **Unix-domain socket** (`~/.librarian/daemon.sock` — local-only, no TCP port; short home-dir path dodges the macOS 104-char UDS limit; socket chmod `0600` + runtime dir `0700` so no other local account can connect).

- **Startup warm-up:** the daemon warms BOTH the embedding model and the persistent OAuth `claude` synthesis session at boot (`warmSynthesizer`), so the FIRST real query doesn't pay the ~10s cold-spawn on top of synthesis (which would otherwise blow the per-query timeout).
- **Thin clients (smart client):** the MCP tools and the `inject` / `capture` hooks call a smart client (`client.ts`) that hits the daemon when it's up (instant — everything already hot). The deliberate tools (`get_context`, `propose_memory`) **fall back to in-process** when it's down (a stale socket just refuses → fallback). The global per-prompt paths (`inject`, `capture`) are daemon-only — silent rather than spinning up the model in a one-shot process.
- **Stays fresh:** `fs.watch` on the corpus re-ingests on change (debounced 1.5s) + a 10-min backstop. The daemon sets `runtime.managedIngest`, so the tools skip their own per-request ingest → fast.
- **Timeouts / limits:** per-request body cap (1 MB → `413`), client→daemon timeout ~22s, and a synthesis turn timeout (~20s) that recycles a hung `claude` session. A client that aborts mid-write can't crash the daemon.
- **Endpoints:** `GET /health` (ok / pid / uptime / chunk-count / models / auth + live usage counters), `POST /get_context`, `POST /inject`, `POST /propose_memory`, `POST /capture` (replies 202, extracts in background).
- **Autostart:** `init --daemon` installs a macOS **launchd** LaunchAgent (`RunAtLoad` + `KeepAlive`, respawns on crash). Its `PATH` includes the `claude` bin dir so the OAuth synth path works under launchd's minimal env. `uninstall` unloads + removes it.
- **Background maintenance:** the index-fresh loop is live and the auto-write capture queue (above) is built. LLM-based staleness/consolidation *proposals* remain the next increment.

## Usage telemetry ("is the librarian earning its keep?")

Every request is recorded so the user can see, over time, whether the librarian actually fires and pulls its weight. Three layers:

- **Per-request log** (`usage.ts`): one JSONL line per request to `~/.librarian/usage.jsonl` — `ts`, `type` (`inject` / `get_context` / `propose_memory` / `capture`), clipped query (first 200 chars), `injected` (did it surface anything? — for `inject` this is THE signal: `false` = the relevance gate stayed silent; for `capture` = ≥1 fact queued), `latency_ms`, `sources`, and `count` (facts queued, capture only). Written AFTER the response is sent, so telemetry adds zero latency, and best-effort: a logging failure can never break a request.
- **Live counters:** in-memory tallies since the daemon started, exposed on `GET /health` (`total`, `inject.fired` / `inject.silent`, `get_context`, `propose_memory`, `capture`).
- **`librarian stats`:** reads the JSONL log and prints call volume (all-time / 24h / 7d), the inject **hit-rate** (fired vs silent — the number that matters most), latency (avg + median, overall and inject-only), the most recent distinct queries, and the live daemon counters when it's up.

## Install (`npx librarian init`)

Deterministic, idempotent, reversible. Registers the MCP server in the user's Claude config; with `--with-hooks`, appends BOTH hooks — auto-read (`UserPromptSubmit → inject`) and auto-write (`Stop → capture`) — to `settings.json` after **backing it up** (merge, don't overwrite); with `--daemon`, installs the launchd LaunchAgent; downloads the model; creates gitignored `corpus/`. Ships an `uninstall` that reverses it all (MCP + hooks + daemon) without ever deleting your corpus/config. Never runs as a side effect of scanning the repo.

## Module map (all built)

- **`store/ingest`** — incremental index build (content-hash diff; skips `pending/` + `archive/`).
- **`store/retrieve`** — vector KNN + 4-factor re-rank (+ access-stat bump).
- **`synthesize` / `persistentClaude`** — the librarian's own Claude: warm OAuth stream-json session (Option B) or the key path with prompt caching.
- **`tools/*`** — `getContext` (load-all-or-retrieve → synthesize), `retrieveContext` (cheap gate, no LLM), `injectContext` (gate → Haiku curate), `proposeMemory` (two-phase write).
- **`capture`** — auto-write extraction → dedup → `corpus/pending/` review queue.
- **`daemon` + `client`** — the warm 24/7 process + the smart client (daemon-or-in-process).
- **`usage` + `commands/stats`** — per-request telemetry + the `stats` view; **`commands/review`** — the review-queue view.
- **`commands/init`** — installer (MCP register, `--daemon` launchd, `--with-hooks` for the auto-read + auto-write hooks); `uninstall` reverses it.
