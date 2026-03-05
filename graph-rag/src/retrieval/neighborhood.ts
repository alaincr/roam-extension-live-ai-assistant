import { IndexStore } from "../index/store.js";
import { GraphExtractor } from "../graph/extractor.js";
import type { NeighborhoodNode, NeighborhoodEdge } from "../graph/types.js";

type RelationshipType = "co_reference" | "direct_link" | "block_ref" | "attribute" | "temporal";

export class NeighborhoodExplorer {
  constructor(
    private store: IndexStore,
    private extractor: GraphExtractor
  ) {}

  async explore(options: {
    pageTitle?: string;
    blockUid?: string;
    relationshipTypes: RelationshipType[];
    maxHops: number;
    includeContent?: boolean;
  }): Promise<{
    nodes: NeighborhoodNode[];
    edges: NeighborhoodEdge[];
  }> {
    const nodes = new Map<string, NeighborhoodNode>();
    const edges: NeighborhoodEdge[] = [];

    const startTitle = options.pageTitle;
    if (!startTitle) {
      return { nodes: [], edges: [] };
    }

    // Add the starting node
    const startPage = this.store.getPageByTitle(startTitle);
    if (startPage) {
      nodes.set(startTitle, { title: startTitle, uid: startPage.uid, type: "page" });
    }

    // BFS traversal
    let frontier = new Set<string>([startTitle]);

    for (let hop = 0; hop < options.maxHops; hop++) {
      const nextFrontier = new Set<string>();

      for (const currentTitle of frontier) {
        if (options.relationshipTypes.includes("co_reference")) {
          await this.expandCoRef(currentTitle, nodes, edges, nextFrontier);
        }

        if (options.relationshipTypes.includes("direct_link")) {
          await this.expandDirectLinks(currentTitle, nodes, edges, nextFrontier);
        }

        if (options.relationshipTypes.includes("block_ref")) {
          await this.expandBlockRefs(currentTitle, nodes, edges, nextFrontier);
        }
      }

      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }

    return {
      nodes: [...nodes.values()],
      edges,
    };
  }

  private async expandCoRef(
    pageTitle: string,
    nodes: Map<string, NeighborhoodNode>,
    edges: NeighborhoodEdge[],
    nextFrontier: Set<string>
  ): Promise<void> {
    // Get co-reference edges involving this page from the index
    const allEdges = this.store.getAllCoRefEdges();
    const relevant = allEdges.filter(
      (e) => e.source === pageTitle || e.target === pageTitle
    );

    for (const edge of relevant) {
      const neighbor = edge.source === pageTitle ? edge.target : edge.source;

      if (!nodes.has(neighbor)) {
        const page = this.store.getPageByTitle(neighbor);
        if (page) {
          nodes.set(neighbor, { title: neighbor, uid: page.uid, type: "page" });
          nextFrontier.add(neighbor);
        }
      }

      edges.push({
        source: edge.source,
        target: edge.target,
        type: "co_reference",
        weight: edge.weight,
      });
    }
  }

  private async expandDirectLinks(
    pageTitle: string,
    nodes: Map<string, NeighborhoodNode>,
    edges: NeighborhoodEdge[],
    nextFrontier: Set<string>
  ): Promise<void> {
    // Outgoing links
    const linked = await this.extractor.getLinkedPages(pageTitle);
    for (const link of linked) {
      if (!nodes.has(link.title)) {
        const page = this.store.getPageByTitle(link.title);
        if (page) {
          nodes.set(link.title, { title: link.title, uid: page.uid, type: "page" });
          nextFrontier.add(link.title);
        }
      }

      edges.push({
        source: pageTitle,
        target: link.title,
        type: "direct_link",
        weight: link.weight,
      });
    }

    // Incoming links (backlinks)
    const backlinks = await this.extractor.getBacklinks(pageTitle);
    for (const link of backlinks) {
      if (!nodes.has(link.title)) {
        const page = this.store.getPageByTitle(link.title);
        if (page) {
          nodes.set(link.title, { title: link.title, uid: page.uid, type: "page" });
          nextFrontier.add(link.title);
        }
      }

      edges.push({
        source: link.title,
        target: pageTitle,
        type: "direct_link",
        weight: link.weight,
      });
    }
  }

  private async expandBlockRefs(
    pageTitle: string,
    nodes: Map<string, NeighborhoodNode>,
    edges: NeighborhoodEdge[],
    nextFrontier: Set<string>
  ): Promise<void> {
    const page = this.store.getPageByTitle(pageTitle);
    if (!page) return;

    const blocks = this.store.getBlocksForPage(page.uid);
    const blockUids = blocks.map((b) => b.uid);

    if (blockUids.length === 0) return;

    const refs = await this.extractor.getBlockRefsFrom(blockUids);

    for (const ref of refs) {
      if (!nodes.has(ref.targetPage)) {
        const targetPage = this.store.getPageByTitle(ref.targetPage);
        if (targetPage) {
          nodes.set(ref.targetPage, {
            title: ref.targetPage,
            uid: targetPage.uid,
            type: "page",
          });
          nextFrontier.add(ref.targetPage);
        }
      }

      edges.push({
        source: pageTitle,
        target: ref.targetPage,
        type: "block_ref",
      });
    }
  }
}
