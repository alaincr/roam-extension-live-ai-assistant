import { IndexStore } from "../index/store.js";
import { EmbeddingService } from "../index/embeddings.js";
import type { GraphRAGConfig } from "../config/index.js";
import type { CommunitySearchResult } from "../graph/types.js";

export class GlobalSearch {
  constructor(
    private store: IndexStore,
    private embeddings: EmbeddingService,
    private config: GraphRAGConfig
  ) {}

  async search(
    query: string,
    options: {
      maxCommunityLevel?: number;
      maxResults?: number;
    } = {}
  ): Promise<{
    communitySummaries: CommunitySearchResult[];
    totalCommunitiesScanned: number;
  }> {
    const maxResults = options.maxResults ?? this.config.defaultGlobalResults;
    const maxLevel = options.maxCommunityLevel ?? this.store.getMaxCommunityLevel();

    // Embed the query
    const queryEmbedding = await this.embeddings.embed(query);

    // Get communities at all levels up to maxLevel
    const allCommunities: Array<{
      id: string;
      level: number;
      page_count: number;
      summary: string | null;
      tree_derived_summary: string | null;
      summary_embedding: Buffer | null;
    }> = [];

    for (let level = 0; level <= maxLevel; level++) {
      allCommunities.push(...this.store.getCommunitiesAtLevel(level));
    }

    // Score communities by similarity to query
    const scored: CommunitySearchResult[] = [];

    for (const community of allCommunities) {
      const summary = community.summary ?? community.tree_derived_summary;
      if (!summary) continue;

      let relevanceScore = 0;

      if (community.summary_embedding) {
        const embedding = EmbeddingService.bufferToEmbedding(community.summary_embedding);
        relevanceScore = EmbeddingService.cosineSimilarity(queryEmbedding, embedding);
      } else {
        // Fallback: keyword matching
        const queryWords = query.toLowerCase().split(/\s+/);
        const summaryLower = summary.toLowerCase();
        const matches = queryWords.filter((w) => summaryLower.includes(w)).length;
        relevanceScore = matches / queryWords.length;
      }

      scored.push({
        communityId: community.id,
        level: community.level,
        summary,
        pageCount: community.page_count,
        relevanceScore,
      });
    }

    // Sort by relevance
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return {
      communitySummaries: scored.slice(0, maxResults),
      totalCommunitiesScanned: allCommunities.length,
    };
  }

  async getCommunitySummary(communityId: string): Promise<{
    summary: string;
    pages: string[];
    neighbors: Array<{ id: string; summary: string | null }>;
    level: number;
  } | null> {
    const community = this.store.getCommunity(communityId);
    if (!community) return null;

    const pages = this.store.getCommunityPages(communityId);
    const neighbors = this.store.getCommunityNeighbors(communityId);

    return {
      summary: community.summary ?? community.tree_derived_summary ?? "",
      pages,
      neighbors: neighbors.map((n) => ({ id: n.id, summary: n.summary })),
      level: community.level,
    };
  }
}
