import OpenAI from "openai";
import type { GraphRAGConfig } from "../config/index.js";

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private ollamaUrl: string;
  private model: string;
  private dimensions: number;
  private provider: "openai" | "ollama";

  constructor(config: GraphRAGConfig) {
    this.provider = config.embeddingProvider;
    this.model = config.embeddingModel;
    this.dimensions = config.embeddingDimensions;
    this.ollamaUrl = config.ollamaUrl ?? "http://localhost:11434";

    if (this.provider === "openai") {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Clean and truncate texts
    const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 8000));

    if (this.provider === "openai") {
      return this.embedOpenAI(cleaned);
    } else {
      return this.embedOllama(cleaned);
    }
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    if (!this.openai) throw new Error("OpenAI client not initialized");

    // OpenAI API supports up to 2048 inputs per request
    const batchSize = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const response = await this.openai.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });

      const sorted = response.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));
    }

    return allEmbeddings;
  }

  private async embedOllama(texts: string[]): Promise<number[][]> {
    // Ollama processes one at a time
    const results: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      const data = (await response.json()) as { embedding: number[] };
      results.push(data.embedding);
    }

    return results;
  }

  // ─── Similarity Computation ────────────────────────────────────

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  static embeddingToBuffer(embedding: number[]): Buffer {
    const buffer = Buffer.alloc(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) {
      buffer.writeFloatLE(embedding[i], i * 4);
    }
    return buffer;
  }

  static bufferToEmbedding(buffer: Buffer): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      embedding.push(buffer.readFloatLE(i));
    }
    return embedding;
  }

  static findTopK(
    queryEmbedding: number[],
    candidates: Array<{ id: string; embedding: Buffer }>,
    k: number
  ): Array<{ id: string; score: number }> {
    const scored = candidates.map((c) => ({
      id: c.id,
      score: EmbeddingService.cosineSimilarity(
        queryEmbedding,
        EmbeddingService.bufferToEmbedding(c.embedding)
      ),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
