import { z } from "zod";
import type { LocalSearch } from "../../retrieval/local.js";

export const localSearchSchema = z.object({
  query: z.string().describe("The search query"),
  seed_pages: z
    .array(z.string())
    .optional()
    .describe("Page titles to start the search from"),
  max_hops: z
    .number()
    .optional()
    .describe("Graph traversal depth for expansion (default: 2)"),
  include_community_context: z
    .boolean()
    .optional()
    .describe("Whether to include community summary for context"),
  max_results: z.number().optional().describe("Maximum number of results"),
});

export type LocalSearchInput = z.infer<typeof localSearchSchema>;

export async function handleLocalSearch(
  input: LocalSearchInput,
  localSearch: LocalSearch
) {
  const result = await localSearch.search(input.query, {
    seedPages: input.seed_pages,
    maxHops: input.max_hops,
    includeCommunityContext: input.include_community_context,
    maxResults: input.max_results,
  });

  return {
    results: result.results.map((r) => ({
      block_uid: r.blockUid,
      content: r.content,
      page_title: r.pageTitle,
      ancestor_path: r.ancestorPath,
      relevance_score: r.relevanceScore,
      siblings: r.siblings,
      graph_distance: r.graphDistance,
    })),
    community_context: result.communityContext,
    pages_traversed: result.pagesTraversed,
  };
}
