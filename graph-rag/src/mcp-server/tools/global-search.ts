import { z } from "zod";
import type { GlobalSearch } from "../../retrieval/global.js";

export const globalSearchSchema = z.object({
  query: z.string().describe("The search query"),
  max_community_level: z
    .number()
    .optional()
    .describe("Maximum community hierarchy level (0 = root only, higher = more detail)"),
  max_results: z
    .number()
    .optional()
    .describe("Maximum number of community summaries to return"),
});

export type GlobalSearchInput = z.infer<typeof globalSearchSchema>;

export async function handleGlobalSearch(
  input: GlobalSearchInput,
  globalSearch: GlobalSearch
) {
  const result = await globalSearch.search(input.query, {
    maxCommunityLevel: input.max_community_level,
    maxResults: input.max_results,
  });

  return {
    community_summaries: result.communitySummaries.map((c) => ({
      community_id: c.communityId,
      level: c.level,
      summary: c.summary,
      page_count: c.pageCount,
      relevance_score: c.relevanceScore,
    })),
    total_communities_scanned: result.totalCommunitiesScanned,
  };
}
