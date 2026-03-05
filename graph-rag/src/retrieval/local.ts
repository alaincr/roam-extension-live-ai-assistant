import { IndexStore } from "../index/store.js";
import { EmbeddingService } from "../index/embeddings.js";
import { GraphExtractor } from "../graph/extractor.js";
import { ContextBuilder } from "./context-builder.js";
import type { GraphRAGConfig } from "../config/index.js";
import type { SearchResult } from "../graph/types.js";

export class LocalSearch {
  constructor(
    private store: IndexStore,
    private embeddings: EmbeddingService,
    private extractor: GraphExtractor,
    private contextBuilder: ContextBuilder,
    private config: GraphRAGConfig
  ) {}

  async search(
    query: string,
    options: {
      seedPages?: string[];
      maxHops?: number;
      includeCommunityContext?: boolean;
      maxResults?: number;
    } = {}
  ): Promise<{
    results: SearchResult[];
    communityContext: string | null;
    pagesTraversed: string[];
  }> {
    const maxResults = options.maxResults ?? this.config.defaultLocalResults;
    const maxHops = options.maxHops ?? 2;

    // Step 1: Find candidate pages
    let candidatePageUids: string[];

    if (options.seedPages && options.seedPages.length > 0) {
      candidatePageUids = options.seedPages
        .map((title) => this.store.getPageByTitle(title)?.uid)
        .filter(Boolean) as string[];
    } else {
      candidatePageUids = await this.findPagesBySimilarity(query, 10);
    }

    if (candidatePageUids.length === 0) {
      return { results: [], communityContext: null, pagesTraversed: [] };
    }

    // Step 2: Retrieve branch-level embeddings for candidates and re-rank
    const queryEmbedding = await this.embeddings.embed(query);
    const candidateBranches: Array<{ uid: string; pageUid: string; score: number }> = [];

    for (const pageUid of candidatePageUids) {
      const branches = this.store.getBranchesForPage(pageUid);
      for (const branch of branches) {
        if (!branch.embedding) continue;
        const score = EmbeddingService.cosineSimilarity(
          queryEmbedding,
          EmbeddingService.bufferToEmbedding(branch.embedding)
        );
        candidateBranches.push({ uid: branch.uid, pageUid, score });
      }
    }

    candidateBranches.sort((a, b) => b.score - a.score);
    const topBranches = candidateBranches.slice(0, maxResults);

    // Step 3: Retrieve block-level results from top branches
    const blockResults: Array<{
      uid: string;
      content: string;
      ancestorPath: string;
      pageUid: string;
      score: number;
    }> = [];

    for (const branch of topBranches) {
      const blocks = this.store.getBlocksForBranch(branch.uid);
      for (const block of blocks) {
        if (!block.embedding) continue;
        const score = EmbeddingService.cosineSimilarity(
          queryEmbedding,
          EmbeddingService.bufferToEmbedding(block.embedding)
        );
        blockResults.push({
          uid: block.uid,
          content: block.content,
          ancestorPath: block.ancestor_path,
          pageUid: branch.pageUid,
          score,
        });
      }
    }

    blockResults.sort((a, b) => b.score - a.score);

    // Step 4: Graph expansion (follow block refs from top results)
    const topBlockUids = blockResults.slice(0, 5).map((b) => b.uid);
    if (maxHops > 0 && topBlockUids.length > 0) {
      const refs = await this.extractor.getBlockRefsFrom(topBlockUids);

      for (const ref of refs) {
        // Check if already in results
        if (blockResults.some((b) => b.uid === ref.targetUid)) continue;

        const block = this.store.getBlocksForPage(
          this.store.getPageByTitle(ref.targetPage)?.uid ?? ""
        ).find((b) => b.uid === ref.targetUid);

        if (block) {
          blockResults.push({
            uid: block.uid,
            content: block.content,
            ancestorPath: block.ancestor_path,
            pageUid: this.store.getPageByTitle(ref.targetPage)?.uid ?? "",
            score: 0.5, // graph-expanded results get a base score
          });
        }
      }
    }

    // Step 5: Deduplicate and format
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    const pagesTraversed = new Set<string>();

    for (const block of blockResults) {
      if (seen.has(block.uid)) continue;
      seen.add(block.uid);

      const page = this.store.getPageByUid(block.pageUid);
      pagesTraversed.add(page?.title ?? block.pageUid);

      results.push({
        blockUid: block.uid,
        content: block.content,
        pageTitle: page?.title ?? "",
        ancestorPath: block.ancestorPath,
        relevanceScore: block.score,
      });

      if (results.length >= maxResults) break;
    }

    // Step 6: Community context
    let communityContext: string | null = null;
    if (options.includeCommunityContext !== false && results.length > 0) {
      const primaryPageTitle = results[0].pageTitle;
      const communityIds = this.store.getCommunitiesForPage(primaryPageTitle);
      if (communityIds.length > 0) {
        const community = this.store.getCommunity(communityIds[0]);
        communityContext = community?.summary ?? community?.tree_derived_summary ?? null;
      }
    }

    return {
      results,
      communityContext,
      pagesTraversed: [...pagesTraversed],
    };
  }

  private async findPagesBySimilarity(query: string, k: number): Promise<string[]> {
    const queryEmbedding = await this.embeddings.embed(query);
    const pages = this.store.getPagesWithEmbeddings();

    const scored = EmbeddingService.findTopK(
      queryEmbedding,
      pages.map((p) => ({ id: p.uid, embedding: p.embedding })),
      k
    );

    return scored.map((s) => s.id);
  }
}
