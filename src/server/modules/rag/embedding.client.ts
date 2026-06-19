import { ragConfig } from './rag.config.js';

export type EmbeddingResult = {
  vector: Float32Array;
  model: string;
  dimensions: number;
};

function endpoint(base: string) {
  return base.replace(/\/+$/, '') + '/embeddings';
}

export function embeddingConfigured(): boolean {
  const cfg = ragConfig();
  return !!cfg.embedding.apiKey && !!cfg.embedding.model && cfg.embedding.dimensions > 0;
}

export async function embedText(text: string): Promise<EmbeddingResult | null> {
  const cfg = ragConfig();
  if (!embeddingConfigured()) {
    console.warn('[rag] embedding client not configured (missing EMBEDDING_API_KEY/MODEL/DIMENSIONS), skipping');
    return null;
  }
  const url = endpoint(cfg.embedding.baseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.embedding.apiKey}`
      },
      body: JSON.stringify({ model: cfg.embedding.model, input: text })
    });
  } catch (error) {
    console.warn('[rag] embedding request failed:', error instanceof Error ? error.message : error);
    return null;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.warn(`[rag] embedding request returned ${response.status}: ${detail.slice(0, 200)}`);
    return null;
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('[rag] embedding response parse failed:', error instanceof Error ? error.message : error);
    return null;
  }
  const first = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  const rawVec = first?.embedding;
  if (!Array.isArray(rawVec)) {
    console.warn('[rag] embedding response missing embedding array');
    return null;
  }
  const vector = new Float32Array(rawVec.length);
  for (let i = 0; i < rawVec.length; i += 1) vector[i] = Number(rawVec[i]);
  if (vector.length !== cfg.embedding.dimensions) {
    console.warn(`[rag] embedding dimension mismatch: got ${vector.length}, expected ${cfg.embedding.dimensions}; trimming/padding`);
    if (vector.length > cfg.embedding.dimensions) {
      const trimmed = vector.slice(0, cfg.embedding.dimensions);
      return { vector: trimmed, model: cfg.embedding.model, dimensions: cfg.embedding.dimensions };
    }
    // pad zeros if shorter
    const padded = new Float32Array(cfg.embedding.dimensions);
    padded.set(vector);
    return { vector: padded, model: cfg.embedding.model, dimensions: cfg.embedding.dimensions };
  }
  return { vector, model: cfg.embedding.model, dimensions: cfg.embedding.dimensions };
}