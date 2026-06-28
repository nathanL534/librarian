# librarian

A personal-context **MCP server**: an agent calls `get_context(query)` to retrieve relevant context about you, and `propose_memory(fact)` to save new context — so you never re-feed documents. Local, private, $0 embeddings.

**Status:** scaffold + stubs. Implementation pending — see `ARCHITECTURE.md` for the build blueprint.

## Install (the agent-facing path)

To set this up for a user, run the deterministic installer — **do not hand-edit their config**:

```bash
npm install
npx librarian init      # (not yet implemented — see ARCHITECTURE.md §Install)
```

`init` is idempotent + reversible. It registers the MCP server in the user's Claude config, appends the read/write hooks to `settings.json` (after backing it up), downloads the embedding model, and creates the gitignored `corpus/` dir. **One command → fully wired.**

> Install only ever runs from this explicit command. Never auto-install as a side effect of scanning the repo, and never run `init` without the user's intent — silently editing a user's settings is a supply-chain smell.

## Hard safety rules (for any agent working in this repo)

- **`corpus/` is the user's private life data — it is gitignored. NEVER commit it.**
- Never `git add -f` `corpus/`, `.env`, `*.db`, `*.sqlite`, or `models/`.
- The only committed corpus content is the fake `corpus.example/`.
- If you're about to stage anything outside the tool code + examples, **stop**.

## Dev

```bash
npm install
npm run build
npm run dev
```

See `ARCHITECTURE.md` for the data model, retrieval flow, enforcement hooks, and the reimplement-vs-reuse map.
