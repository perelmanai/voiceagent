import { getAI, withRetry, MODELS, EMBEDDING_DIM } from "./genai";

// Query embeddings repeat constantly (same transcript tail re-analyzed, agent
// recalls, UI searches), so a small in-process LRU saves real quota.
const globalCache = globalThis as typeof globalThis & {
  __auralQueryEmbCache?: Map<string, Float32Array>;
};
const queryCache = (globalCache.__auralQueryEmbCache ??= new Map<
  string,
  Float32Array
>());
const QUERY_CACHE_MAX = 200;

function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Embed texts for storage (RETRIEVAL_DOCUMENT). Returns null on failure so
 * callers can store the memory anyway and fall back to keyword recall.
 */
export async function embedDocuments(
  texts: string[]
): Promise<Float32Array[] | null> {
  const ai = getAI();
  if (!ai || texts.length === 0) return null;
  try {
    const res = await withRetry(() =>
      ai.models.embedContent({
        model: MODELS.embedding,
        contents: texts,
        config: {
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBEDDING_DIM,
        },
      })
    );
    const vecs = res.embeddings?.map((e) => normalize(e.values ?? []));
    return vecs && vecs.length === texts.length ? vecs : null;
  } catch {
    return null;
  }
}

/** Embed a search query (RETRIEVAL_QUERY), with LRU caching. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const key = text.trim().toLowerCase();
  const cached = queryCache.get(key);
  if (cached) {
    // refresh LRU position
    queryCache.delete(key);
    queryCache.set(key, cached);
    return cached;
  }

  const ai = getAI();
  if (!ai) return null;
  try {
    const res = await withRetry(() =>
      ai.models.embedContent({
        model: MODELS.embedding,
        contents: text,
        config: {
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: EMBEDDING_DIM,
        },
      })
    );
    const values = res.embeddings?.[0]?.values;
    if (!values) return null;
    const vec = normalize(values);
    queryCache.set(key, vec);
    while (queryCache.size > QUERY_CACHE_MAX) {
      const oldest = queryCache.keys().next().value;
      if (oldest === undefined) break;
      queryCache.delete(oldest);
    }
    return vec;
  } catch {
    return null;
  }
}

/** Cosine similarity of pre-normalized vectors (= dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.length === 0) return null;
  return new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
  );
}
