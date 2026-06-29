/**
 * runtime — tiny process-wide flag.
 *
 * When the warm daemon owns ingest (startup scan + fs.watch + periodic
 * backstop), the per-request ingest in get_context / propose_memory is
 * redundant and slow, so they skip it. In-process (no daemon) it stays on.
 */
export const runtime = {
  /** Set true by the daemon; tools then skip their own leading ingest. */
  managedIngest: false,
};
