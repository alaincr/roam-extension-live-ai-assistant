import { z } from "zod";
import type { NeighborhoodExplorer } from "../../retrieval/neighborhood.js";

export const exploreNeighborhoodSchema = z.object({
  page_title: z.string().optional().describe("Starting page title"),
  block_uid: z.string().optional().describe("Starting block UID"),
  relationship_types: z
    .array(
      z.enum(["co_reference", "direct_link", "block_ref", "attribute", "temporal"])
    )
    .describe("Types of relationships to traverse"),
  max_hops: z.number().describe("Maximum traversal depth"),
  include_content: z
    .boolean()
    .optional()
    .describe("Whether to include block content"),
});

export type ExploreNeighborhoodInput = z.infer<typeof exploreNeighborhoodSchema>;

export async function handleExploreNeighborhood(
  input: ExploreNeighborhoodInput,
  explorer: NeighborhoodExplorer
) {
  const result = await explorer.explore({
    pageTitle: input.page_title,
    blockUid: input.block_uid,
    relationshipTypes: input.relationship_types,
    maxHops: input.max_hops,
    includeContent: input.include_content,
  });

  return {
    nodes: result.nodes.map((n) => ({
      title: n.title,
      uid: n.uid,
      type: n.type,
    })),
    edges: result.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
    })),
  };
}
