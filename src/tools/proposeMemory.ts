/**
 * propose_memory — STUB.
 *
 * Intended behavior:
 *   1. Dedup: check the incoming content against existing notes (embedding +
 *      keyword match) so we don't store near-duplicates.
 *   2. Diff: if it updates/extends an existing note, compute a diff and show
 *      the user exactly what would change; if it's net-new, show the proposed
 *      file.
 *   3. On explicit user confirmation, write the note as a new .md file into the
 *      configured corpus/ directory.
 *   4. Re-ingest the new/updated file (see ./store/ingest.ts) so it's
 *      immediately retrievable.
 *
 * SAFETY: writes only ever go into the configured corpusPath, which is
 * gitignored. Never write user memory anywhere a commit could pick it up.
 *
 * @param content The note/memory text the caller wants to persist.
 * @returns A confirmation prompt / diff, or a write summary. (Currently a stub.)
 */
export async function proposeMemory(content: string): Promise<string> {
  void content;
  return "propose_memory: not implemented yet";
}
