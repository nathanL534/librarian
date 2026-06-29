/**
 * embed — local embeddings via transformers.js (no API, $0, fully on-device).
 *
 * Default model bge-small-en-v1.5: 384-dim, mean-pooled + L2-normalized (so a
 * dot product equals cosine similarity). Weights download to `cacheDir` on the
 * first call (~460MB) and are reused thereafter. No private text leaves the box.
 */
import { env, pipeline } from "@huggingface/transformers";

// transformers.js types are loose for pipeline outputs; keep the handle untyped.
let extractor: Promise<unknown> | null = null;

async function getExtractor(model: string, cacheDir: string): Promise<any> {
  if (!extractor) {
    // env property names are stable but loosely typed across versions.
    (env as Record<string, unknown>).cacheDir = cacheDir;
    (env as Record<string, unknown>).allowRemoteModels = true;
    extractor = pipeline("feature-extraction", model);
  }
  return extractor;
}

export async function embed(
  texts: string[],
  model = "Xenova/bge-small-en-v1.5",
  cacheDir = "./.index/models",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getExtractor(model, cacheDir);
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}
