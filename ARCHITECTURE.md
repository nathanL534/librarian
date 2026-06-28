# librarian — Architecture (build blueprint)

The single source of truth for implementation. Derived from a code-level teardown of `@iachilles/memento` and `basic-memory`, plus our design decisions.

## Principles

- **Markdown is canonical** (steal from basic-memory): the user's `.md` files in `corpus/` are the source of truth. The SQLite DB is a *derived, rebuildable index* — if it's lost, re-ingest from the markdown.
- **Vector-first recall, light graph as a re-rank *assist* — never graph-primary.** Vector search finds things; a sparse entity-graph only *boosts* related results. Degrades gracefully: no graph → still full vector recall.
- **Load everything while it fits.** The agent gets the *maximal* context that fits the budget; retrieval only kicks in when the corpus overflows.
- **The librarian has its OWN model — independence is the point.** Embeddings run locally (transformers.js). For both *what to return* (selection) and *what to ingest*, the librarian calls its **own** Claude, separate from the host Claude — so memory decisions are a neutral, consistent gatekeeper, never biased by the caller's current task. The host asks; the librarian decides. Credential is the librarian's own: an **API key** (explicit prompt-cache control, simplest) OR its **own dedicated `claude -p`/Agent SDK OAuth session** (free via subscription). The requirement is *independence*, not the credential type.
- **Read freely, write carefully.** Writes go through propose→confirm; the human is the reconciliation engine.

## Data model (SQLite + sqlite-vec)

```
corpus/*.md                         ← canonical, user-owned, gitignored

chunks(id, file_path, heading, content, created_at, last_accessed, access_count, importance)
chunks_vec  USING vec0(chunk_id INT, embedding FLOAT[384])   ← bge-small-en-v1.5, 384-dim
entities(id, name UNIQUE, type)               ← optional, for the graph-assist re-rank
relations(from_id, to_id, type, UNIQUE(...))  ← optional edges
```

No FTS table (memento dropped it; revisit only if exact-term recall proves weak).

## `get_context(query)` flow

```
1. corpus fits token budget?  →  load ALL chunks → librarian's OWN Haiku selects+synthesizes → answer + sources
2. too big?                   →  embed query (local) → sqlite-vec cosine top-k*2
                                 → 4-FACTOR RE-RANK → top-k → librarian's OWN Haiku synthesizes → answer + sources

The librarian's own Claude (NOT the host) decides relevance & phrasing — an independent, neutral
gatekeeper, so the caller can't bias what it picks. Keep it warm: hold the corpus as a CACHED prefix
and fire a STATELESS query each call (don't reuse one growing conversation — history would bloat).
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

## Reimplement vs reuse (~470 lines total)

| Component | Decision |
|---|---|
| MCP protocol | **reuse** `@modelcontextprotocol/sdk` |
| Embeddings | **reuse** `@xenova/transformers`, model `Xenova/bge-small-en-v1.5` (384-dim, ~120MB) |
| Vector ANN | **reuse** `sqlite-vec` |
| Storage layer | **build** (~120 lines — schema is simple) |
| 4-factor scoring | **build** (~80 lines — adapt memento) |
| Graph-BFS scorer | **build** (~50 lines over `relations`) |
| Synthesis (read) | **build** — the librarian's OWN warm Haiku (own key, or own `claude -p`/Agent SDK OAuth session) selects + synthesizes; independent of the host |

## Enforcement (fire-and-forget — Claude Code hooks)

Hooks are run by the harness deterministically, so the model can't forget them. This is what makes it automatic, not optional.

- **Auto-read:** `SessionStart` / `UserPromptSubmit` hook → `get_context(prompt)` → inject relevant context. Every session already knows the user.
- **Auto-write:** `Stop` hook → spawn a cheap background subagent → extract durable new facts → `propose_memory`.
  - *Single quality-conscious user:* land proposals in a `pending/` queue, batch-approve weekly.
  - *Non-technical fire-and-forget:* auto-commit + automated LLM dedup/reconcile, corpus git-versioned for reversibility.
- **Cost:** keep the extractor on Haiku, debounced/batched — don't fire a full agent every turn.

## Install (`npx librarian init`)

Deterministic, idempotent, reversible. Registers the MCP server in the user's Claude config; appends hooks to `settings.json` after **backing it up** (merge, don't overwrite); downloads the model; creates gitignored `corpus/`. Ships an `uninstall` that reverses it. Never runs as a side effect of scanning the repo.

## Build order

`store/ingest` → `store/retrieve` (vector + re-rank) → `synthesize` → `tools/*` → `init` → hooks.
