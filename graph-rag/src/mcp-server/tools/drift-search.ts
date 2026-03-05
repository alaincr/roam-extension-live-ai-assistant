import { z } from "zod";
import type { DriftSearch } from "../../retrieval/drift.js";

export const driftSearchSchema = z.object({
  query: z.string().describe("The search query"),
  max_rounds: z
    .number()
    .optional()
    .describe("Maximum number of progressive refinement rounds (default: 3)"),
});

export type DriftSearchInput = z.infer<typeof driftSearchSchema>;

export async function handleDriftSearch(
  input: DriftSearchInput,
  driftSearch: DriftSearch
) {
  const result = await driftSearch.search(input.query, input.max_rounds);

  return {
    rounds: result.rounds.map((r) => ({
      round: r.round,
      strategy: r.strategy,
      communities_explored: r.communitiesExplored,
      key_findings: r.keyFindings,
      follow_up_queries: r.followUpQueries,
    })),
    final_context: result.finalContext,
    pages_covered: result.pagesCovered,
    blocks_retrieved: result.blocksRetrieved,
  };
}
