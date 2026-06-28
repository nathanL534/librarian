/**
 * embed — STUB.
 *
 * Intended behavior: produce embedding vectors locally via transformers.js
 * (@xenova/transformers) using the model named in config (default
 * "Xenova/bge-small-en-v1.5"). Runs entirely on-device — no API calls, $0,
 * and no private text ever leaves the machine.
 *
 * The model weights are downloaded to ./models (gitignored) on first run and
 * cached thereafter.
 *
 * @param texts One or more strings to embed.
 * @returns One vector per input string. (Currently a stub.)
 */
export async function embed(texts: string[]): Promise<number[][]> {
  void texts;
  return [];
}
