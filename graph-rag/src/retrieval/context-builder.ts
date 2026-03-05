import { RoamMCPClient } from "../roam-client/roam-mcp-client.js";
import { IndexStore } from "../index/store.js";
import type { TelescopingContext, BlockNode, AncestorNode } from "../graph/types.js";

export class ContextBuilder {
  constructor(
    private roamClient: RoamMCPClient,
    private store: IndexStore
  ) {}

  async buildTelescopingContext(
    blockUid: string,
    tokenBudget: number
  ): Promise<TelescopingContext> {
    const { block, ancestors, siblings } = await this.roamClient.getBlockWithContext(blockUid);

    // Build ancestor path
    const ancestorChain = flattenParentChain(ancestors);
    const ancestorPath = ancestorChain
      .map((a) => a.title || a.string || "")
      .filter(Boolean)
      .join(" > ");

    // Determine community context
    const pageTitle = ancestorChain[ancestorChain.length - 1]?.title;
    let communityContext: string | null = null;
    if (pageTitle) {
      const communityIds = this.store.getCommunitiesForPage(pageTitle);
      if (communityIds.length > 0) {
        // Pick the most specific (highest level) community
        const communities = communityIds
          .map((id) => this.store.getCommunity(id))
          .filter(Boolean)
          .sort((a, b) => (b?.level ?? 0) - (a?.level ?? 0));

        const best = communities[0];
        if (best?.summary) {
          // Truncate community context to its budget share
          const maxChars = Math.floor(tokenBudget * 0.2 * 4); // ~4 chars per token
          communityContext =
            best.summary.length > maxChars
              ? best.summary.slice(0, maxChars) + "..."
              : best.summary;
        }
      }
    }

    // Build children list
    const children = (block.children ?? []).map((c) => ({
      content: c.string,
      depth: 1,
    }));

    // Build siblings list (first line only)
    const siblingEntries = siblings.map((s) => ({
      content: firstLine(s.string),
      depth: 0,
    }));

    // Build parent
    const parentNode = ancestorChain[0];
    const parent = parentNode?.string
      ? { content: parentNode.string, depth: 0 }
      : null;

    return {
      matchedBlock: {
        uid: block.uid,
        content: block.string,
        depth: 0,
      },
      children,
      siblings: siblingEntries,
      parent,
      ancestorPath,
      communityContext,
    };
  }

  formatTelescopingContext(ctx: TelescopingContext): string {
    const sections: string[] = [];

    if (ctx.communityContext) {
      sections.push(`## Community Context\n${ctx.communityContext}`);
    }

    sections.push(`## Location\n${ctx.ancestorPath}`);

    if (ctx.parent) {
      sections.push(`## Parent Section\n- **${ctx.parent.content}**`);
    }

    // Matched block with children
    const matchedLines = [`- **${ctx.matchedBlock.content}**`];
    for (const child of ctx.children) {
      const indent = "  ".repeat(child.depth);
      matchedLines.push(`${indent}  - ${child.content}`);
    }
    sections.push(`## Matched Content\n${matchedLines.join("\n")}`);

    if (ctx.siblings.length > 0) {
      const siblingLines = ctx.siblings.map((s) => `- ${s.content}`);
      sections.push(`## Sibling Sections\n${siblingLines.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  // ─── Subtree Chunking ──────────────────────────────────────────

  async buildSubtreeChunks(
    pageUid: string,
    maxTokensPerChunk: number
  ): Promise<Array<{ branchUid: string; ancestorPath: string; content: string }>> {
    const page = this.store.getPageByUid(pageUid);
    if (!page) return [];

    const tree = await this.roamClient.getPageTree(pageUid);
    const chunks: Array<{ branchUid: string; ancestorPath: string; content: string }> = [];

    for (const branch of tree) {
      const content = flattenSubtree(branch, 0);
      const ancestorPath = page.title;

      // If branch fits in budget, use as-is
      const tokenEstimate = Math.ceil(content.length / 4);
      if (tokenEstimate <= maxTokensPerChunk) {
        chunks.push({
          branchUid: branch.uid,
          ancestorPath,
          content: `${ancestorPath} > ${firstLine(branch.string)}\n\n${content}`,
        });
      } else {
        // Split at L1 level
        for (const child of branch.children ?? []) {
          const childContent = flattenSubtree(child, 0);
          const childPath = `${ancestorPath} > ${firstLine(branch.string)}`;
          chunks.push({
            branchUid: branch.uid,
            ancestorPath: childPath,
            content: `${childPath} > ${firstLine(child.string)}\n\n${childContent}`,
          });
        }
      }
    }

    return chunks;
  }

  // ─── Multi-Block Context Assembly ──────────────────────────────

  async assembleContext(
    blockUids: string[],
    tokenBudget: number
  ): Promise<string> {
    const budgetPerBlock = Math.floor(tokenBudget / Math.max(blockUids.length, 1));
    const sections: string[] = [];

    for (const uid of blockUids) {
      const ctx = await this.buildTelescopingContext(uid, budgetPerBlock);
      sections.push(this.formatTelescopingContext(ctx));
    }

    return sections.join("\n\n---\n\n");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function flattenParentChain(
  ancestors: AncestorNode | undefined
): Array<{ uid: string; string?: string; title?: string }> {
  const chain: Array<{ uid: string; string?: string; title?: string }> = [];
  let current = ancestors;

  while (current) {
    chain.push({
      uid: current.uid,
      string: current.string,
      title: current.title,
    });
    current = current.parents;
  }

  // Reverse so page title is last (root -> ... -> immediate parent)
  return chain.reverse();
}

function flattenSubtree(node: BlockNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}- ${node.string}`];

  if (node.children) {
    for (const child of node.children) {
      lines.push(flattenSubtree(child, depth + 1));
    }
  }

  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n")[0];
  return line.length > 120 ? line.slice(0, 120) + "..." : line;
}
