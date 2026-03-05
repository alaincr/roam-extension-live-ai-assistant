import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { GraphRAGConfig } from "../config/index.js";
import type { CoRefEdge, CommunityHierarchy } from "../graph/types.js";

export class CommunityDetector {
  private resolutions: number[];
  private minCommunitySize: number;
  private minModularity: number;
  private maxCommunityRatio: number;

  constructor(config: GraphRAGConfig) {
    this.resolutions = config.resolutions;
    this.minCommunitySize = config.minCommunitySize;
    this.minModularity = config.minModularity;
    this.maxCommunityRatio = config.maxCommunityRatio;
  }

  buildGraph(edges: CoRefEdge[]): Graph {
    const graph = new Graph({ type: "undirected" });

    for (const edge of edges) {
      if (!graph.hasNode(edge.source)) graph.addNode(edge.source);
      if (!graph.hasNode(edge.target)) graph.addNode(edge.target);

      // graphology doesn't allow duplicate edges in undirected graph
      if (!graph.hasEdge(edge.source, edge.target)) {
        graph.addEdge(edge.source, edge.target, { weight: edge.weight });
      }
    }

    return graph;
  }

  detectHierarchy(edges: CoRefEdge[]): CommunityHierarchy[] {
    const graph = this.buildGraph(edges);
    const nodeCount = graph.order;

    if (nodeCount < 2) return [];

    const allLevels: CommunityHierarchy[] = [];

    for (const resolution of this.resolutions) {
      const assignments = louvain(graph, {
        resolution,
        getEdgeWeight: "weight",
      });

      // Group pages by community ID
      const communityMap = new Map<string, string[]>();
      for (const [page, communityId] of Object.entries(assignments)) {
        const id = String(communityId);
        if (!communityMap.has(id)) communityMap.set(id, []);
        communityMap.get(id)!.push(page);
      }

      // Filter out communities that are too small
      const filtered = new Map<string, string[]>();
      for (const [id, pages] of communityMap) {
        if (pages.length >= this.minCommunitySize) {
          filtered.set(id, pages);
        }
      }

      // Compute modularity using the partition we already have
      const modularity = louvain.detailed(graph, {
        resolution,
        getEdgeWeight: "weight",
      }).modularity;

      allLevels.push({
        level: allLevels.length,
        resolution,
        communities: filtered,
        modularity,
      });
    }

    return this.selectMeaningfulLevels(allLevels, nodeCount);
  }

  private selectMeaningfulLevels(
    levels: CommunityHierarchy[],
    nodeCount: number
  ): CommunityHierarchy[] {
    const selected: CommunityHierarchy[] = [];
    let prevCommunityCount = -1;

    for (const level of levels) {
      const communityCount = level.communities.size;
      if (communityCount === 0) continue;

      // Skip if modularity too low
      if (level.modularity < this.minModularity) continue;

      // Check that no community is too large
      const maxSize = Math.max(...[...level.communities.values()].map((p) => p.length));
      if (maxSize / nodeCount > this.maxCommunityRatio && communityCount > 1) continue;

      // Skip if community count didn't change significantly from previous level
      if (
        prevCommunityCount > 0 &&
        Math.abs(communityCount - prevCommunityCount) / prevCommunityCount < 0.2
      ) {
        continue;
      }

      selected.push({
        ...level,
        level: selected.length,
      });
      prevCommunityCount = communityCount;
    }

    // Ensure at least one level if there were any communities
    if (selected.length === 0 && levels.length > 0) {
      const best = levels.reduce((a, b) =>
        a.modularity > b.modularity && a.communities.size > 0 ? a : b
      );
      if (best.communities.size > 0) {
        selected.push({ ...best, level: 0 });
      }
    }

    return selected;
  }

  computeInterCommunityEdges(
    edges: CoRefEdge[],
    hierarchy: CommunityHierarchy[]
  ): Map<number, Array<{ sourceId: string; targetId: string; weight: number }>> {
    const result = new Map<number, Array<{ sourceId: string; targetId: string; weight: number }>>();

    for (const level of hierarchy) {
      // Build page -> community mapping
      const pageToCommunity = new Map<string, string>();
      for (const [communityId, pages] of level.communities) {
        for (const page of pages) {
          pageToCommunity.set(page, communityId);
        }
      }

      // Compute cross-community edge weights
      const interEdges = new Map<string, number>();

      for (const edge of edges) {
        const sourceCommunity = pageToCommunity.get(edge.source);
        const targetCommunity = pageToCommunity.get(edge.target);

        if (
          sourceCommunity &&
          targetCommunity &&
          sourceCommunity !== targetCommunity
        ) {
          const key =
            sourceCommunity < targetCommunity
              ? `${sourceCommunity}|${targetCommunity}`
              : `${targetCommunity}|${sourceCommunity}`;

          interEdges.set(key, (interEdges.get(key) ?? 0) + edge.weight);
        }
      }

      const levelEdges: Array<{ sourceId: string; targetId: string; weight: number }> = [];
      for (const [key, weight] of interEdges) {
        const [sourceId, targetId] = key.split("|");
        levelEdges.push({ sourceId, targetId, weight });
      }

      result.set(level.level, levelEdges);
    }

    return result;
  }
}
