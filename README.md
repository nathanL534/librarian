# librarian

A personal-context **MCP server** that does local RAG over your own markdown.

Point it at a folder of your notes, and it answers questions grounded in *your*
context — for small corpora it just loads everything; for larger ones it does
hybrid retrieval (vector + keyword, RRF-fused) and synthesizes an answer with
Claude Haiku. Embeddings run **locally** via transformers.js, so indexing is
$0 and your private text never leaves your machine for the retrieval step.

> Status: **scaffold / stubs only.** The tools currently return
> "not implemented yet". The real implementation lands later from a separate
> architecture blueprint. This repo exists to lock in the structure and — most
> importantly — a safe `.gitignore` before any private data goes near it.

## What it does

Two MCP tools:

- **`get_context(query)`** — answer a question from your corpus. Loads the whole
  corpus if it fits the model's token budget; otherwise hybrid-retrieves the
  top-k relevant chunks, then synthesizes with Haiku.
- **`propose_memory(content)`** — persist a new note. Dedups against existing
  notes, shows a diff, and on your confirmation writes a new `.md` file into the
  corpus and re-ingests it.

## How it works

```
your markdown (corpus/)  ->  ingest: chunk by heading -> embed (local) -> SQLite (sqlite-vec + FTS5)
question                 ->  retrieve: vector + keyword, RRF-fused -> top-k
                         ->  synthesize: Claude Haiku, grounded in retrieved context
```

- **Embeddings:** `@xenova/transformers` (transformers.js), local, no API, $0.
- **Index:** SQLite with `sqlite-vec` (vectors) + FTS5 (keywords).
- **Synthesis:** Claude Haiku via `@anthropic-ai/sdk`.
- **Transport:** Model Context Protocol over stdio (`@modelcontextprotocol/sdk`).

## Clone & run

```bash
git clone <this-repo-url> librarian
cd librarian

# install deps
npm install            # or: pnpm install / bun install

# configure
cp config.example.json config.json   # config.json is yours to edit

# set your Anthropic API key (used only for the Haiku synthesis step)
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env   # .env is gitignored

# build
npm run build

# try it against the committed sample corpus (a fake person, no real data)
cp -r corpus.example corpus           # corpus/ is gitignored
```

Then register `dist/server.js` as an MCP server in your MCP client (e.g. Claude
Desktop / Claude Code) and call the `get_context` / `propose_memory` tools.

**The rule:** put **your own** markdown in `corpus/`. That directory is
gitignored and is **never committed**. The committed `corpus.example/` is just a
fake sample so the tool has something to run against.

## Security

This repo is **public**, and it is meant to live right next to your private
life-context notes on your own machine. The `.gitignore` is written to make it
*structurally impossible* to commit private content. Treat that as the most
important file in the repo.

Never committed (enforced by `.gitignore`):

- `corpus/` — your private notes
- `*.db`, `*.sqlite`, `*.sqlite3`, `.index/` — the vector/keyword index (derived
  from your private content)
- `.env`, `.env.*` — secrets, including your `ANTHROPIC_API_KEY`
- `models/` — downloaded embedding-model weights
- `*.private.md` — anything you explicitly mark private
- `node_modules/`, `dist/`, `.DS_Store`

**Hard rules:**

- **Never** run `git add -f` (force-add) on `corpus/`, `.env`, any `*.db`, or
  anything else matched by `.gitignore`. The `-f` flag is the one way to defeat
  these protections — don't use it.
- Before any commit, sanity-check with `git status` and
  `git diff --cached --name-only` that no private file, no `.env`, and no `*.db`
  is staged.
- Keep real notes only in `corpus/` (or in `*.private.md` files). Do not put
  real personal content in `corpus.example/` or anywhere else tracked by git.
- If you fork or rename this repo, copy the `.gitignore` first, before adding any
  content.

## License

MIT
