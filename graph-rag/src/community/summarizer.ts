import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { GraphRAGConfig } from "../config/index.js";
import type { BlockNode } from "../graph/types.js";
import { RoamMCPClient } from "../roam-client/roam-mcp-client.js";
import { IndexStore } from "../index/store.js";
import { EmbeddingService } from "../index/embeddings.js";

export class CommunitySummarizer {
  private config: GraphRAGConfig;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private embeddingService: EmbeddingService;

  constructor(
    config: GraphRAGConfig,
    private roamClient: RoamMCPClient,
    private store: IndexStore,
    embeddingService: EmbeddingService
  ) {
    this.config = config;
    this.embeddingService = embeddingService;

    if (config.llmProvider === "anthropic") {
      this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    } else {
      this.openai = new OpenAI({ apiKey: config.openaiLlmApiKey });
    }
  }

  // ─── Tree-Derived Summaries (No LLM) ──────────────────────────

  async buildTreeDerivedSummary(
    communityId: string,
    pageTitles: string[]
  ): Promise<string> {
    const sections: string[] = [];
    sections.push(`Community pages (${pageTitles.length}): ${pageTitles.join(", ")}\n`);

    // Extract L0 blocks for each page (up to 10 pages to control size)
    const pagesToProcess = pageTitles.slice(0, 15);

    for (const title of pagesToProcess) {
      const page = this.store.getPageByTitle(title);
      if (!page) continue;

      const children = await this.roamClient.getPageTree(page.uid);
      if (children.length === 0) continue;

      const l0Lines = children
        .slice(0, 8) // Max 8 top-level blocks per page
        .map((child) => `  - ${cleanBlockContent(child.string)}`)
        .filter((line) => line.trim().length > 4);

      if (l0Lines.length > 0) {
        sections.push(`${title}:\n${l0Lines.join("\n")}`);
      }
    }

    if (pageTitles.length > 15) {
      sections.push(`... and ${pageTitles.length - 15} more pages`);
    }

    return sections.join("\n\n");
  }

  // ─── LLM Summarization ─────────────────────────────────────────

  async generateLLMSummary(
    communityId: string,
    pageTitles: string[],
    treeDerivedContent: string,
    neighborSummaries: Array<{ id: string; summary: string }>,
    childSummaries?: Array<{ id: string; summary: string }>
  ): Promise<string> {
    const commonAttributes = this.store.getCommonAttributes(pageTitles);
    const attrText = formatAttributes(commonAttributes);

    const prompt = `You are analyzing a cluster of densely interconnected pages from a personal knowledge graph. These pages were grouped together because they are frequently referenced together in the same contexts.

## Pages in this cluster (${pageTitles.length})
${pageTitles.join(", ")}

## Content overview (user's own outline structure)
${treeDerivedContent}

${attrText ? `## Common structured attributes\n${attrText}\n` : ""}
${neighborSummaries.length > 0 ? `## Neighboring clusters\n${neighborSummaries.map((n) => `- ${n.summary}`).join("\n")}\n` : ""}
${childSummaries && childSummaries.length > 0 ? `## Sub-clusters within this group\n${childSummaries.map((c) => `- ${c.summary}`).join("\n")}\n` : ""}

Write a summary (2-4 paragraphs) covering:
1. The central theme or domain this cluster represents
2. The key concepts and how they relate to each other
3. Any notable patterns, common attributes, or temporal trends
4. How this cluster connects to neighboring clusters (if applicable)`;

    return this.callLLM(prompt);
  }

  private async callLLM(prompt: string): Promise<string> {
    if (this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.config.llmModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      return response.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("");
    }

    if (this.openai) {
      const response = await this.openai.chat.completions.create({
        model: this.config.llmModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      return response.choices[0]?.message?.content ?? "";
    }

    throw new Error("No LLM provider configured");
  }

  // ─── Full Summarization Pipeline ───────────────────────────────

  async summarizeAllCommunities(): Promise<void> {
    const maxLevel = this.store.getMaxCommunityLevel();
    if (maxLevel < 0) return;

    // Bottom-up: summarize leaf communities first, then higher levels
    for (let level = maxLevel; level >= 0; level--) {
      const communities = this.store.getCommunitiesAtLevel(level);

      for (const community of communities) {
        const pageTitles = this.store.getCommunityPages(community.id);

        // Step 1: Tree-derived summary (always)
        const treeDerived = await this.buildTreeDerivedSummary(community.id, pageTitles);
        this.store.setMeta(`tree_summary_${community.id}`, treeDerived);

        let finalSummary: string;

        if (pageTitles.length >= this.config.summarizationThreshold) {
          // Step 2: LLM summary for larger communities
          const neighborSummaries = this.store
            .getCommunityNeighbors(community.id)
            .filter((n) => n.summary)
            .map((n) => ({ id: n.id, summary: n.summary! }));

          // Get child community summaries (from the level below)
          const childSummaries: Array<{ id: string; summary: string }> = [];
          if (level < maxLevel) {
            const childCommunities = this.store.getCommunitiesAtLevel(level + 1);
            for (const child of childCommunities) {
              const childPages = this.store.getCommunityPages(child.id);
              // Check if this child's pages overlap with the current community
              const overlap = childPages.some((p) => pageTitles.includes(p));
              if (overlap && child.summary) {
                childSummaries.push({ id: child.id, summary: child.summary });
              }
            }
          }

          finalSummary = await this.generateLLMSummary(
            community.id,
            pageTitles,
            treeDerived,
            neighborSummaries,
            childSummaries
          );
        } else {
          // Use tree-derived summary for small communities
          finalSummary = treeDerived;
        }

        // Step 3: Embed the summary
        const summaryEmbedding = await this.embeddingService.embed(finalSummary);
        const embeddingBuffer = EmbeddingService.embeddingToBuffer(summaryEmbedding);

        this.store.updateCommunitySummary(community.id, finalSummary, embeddingBuffer);
      }
    }
  }

  async regenerateDirtySummaries(): Promise<number> {
    const dirty = this.store.getDirtyCommunities();
    let count = 0;

    // Process from highest level (leaf) to lowest (root) for bottom-up consistency
    const sortedDirty = dirty.sort((a, b) => b.level - a.level);

    for (const { id, level } of sortedDirty) {
      const pageTitles = this.store.getCommunityPages(id);

      const treeDerived = await this.buildTreeDerivedSummary(id, pageTitles);

      let finalSummary: string;
      if (pageTitles.length >= this.config.summarizationThreshold) {
        const neighborSummaries = this.store
          .getCommunityNeighbors(id)
          .filter((n) => n.summary)
          .map((n) => ({ id: n.id, summary: n.summary! }));

        finalSummary = await this.generateLLMSummary(
          id,
          pageTitles,
          treeDerived,
          neighborSummaries
        );
      } else {
        finalSummary = treeDerived;
      }

      const summaryEmbedding = await this.embeddingService.embed(finalSummary);
      const embeddingBuffer = EmbeddingService.embeddingToBuffer(summaryEmbedding);

      this.store.updateCommunitySummary(id, finalSummary, embeddingBuffer);
      count++;
    }

    return count;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function cleanBlockContent(content: string): string {
  return content
    .replace(/\(\(([a-zA-Z0-9_-]{9})\)\)/g, "[ref]") // block refs
    .replace(/!\[.*?\]\(.*?\)/g, "[image]") // images
    .replace(/\{\{.*?\}\}/g, "") // roam components
    .trim();
}

function formatAttributes(attrs: Map<string, string[]>): string {
  if (attrs.size === 0) return "";

  const lines: string[] = [];
  for (const [name, values] of attrs) {
    const uniqueValues = [...new Set(values)].slice(0, 5);
    lines.push(`- ${name}: ${uniqueValues.join(", ")}`);
  }
  return lines.join("\n");
}
