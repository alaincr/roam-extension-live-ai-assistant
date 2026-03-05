import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { GraphRAGConfig } from "../config/index.js";
import type { DriftRound } from "../graph/types.js";
import { GlobalSearch } from "./global.js";
import { LocalSearch } from "./local.js";
import { ContextBuilder } from "./context-builder.js";

export class DriftSearch {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(
    private globalSearch: GlobalSearch,
    private localSearch: LocalSearch,
    private contextBuilder: ContextBuilder,
    private config: GraphRAGConfig
  ) {
    if (config.llmProvider === "anthropic") {
      this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    } else {
      this.openai = new OpenAI({ apiKey: config.openaiLlmApiKey });
    }
  }

  async search(
    query: string,
    maxRounds: number = this.config.driftMaxRounds
  ): Promise<{
    rounds: DriftRound[];
    finalContext: string;
    pagesCovered: string[];
    blocksRetrieved: number;
  }> {
    const rounds: DriftRound[] = [];
    const allPagesCovered = new Set<string>();
    const allBlockUids = new Set<string>();
    const contextParts: string[] = [];

    // ── Round 1: Global search to identify relevant communities ───

    const globalResult = await this.globalSearch.search(query, {
      maxResults: 5,
    });

    const relevantCommunities = globalResult.communitySummaries
      .filter((c) => c.relevanceScore > 0.3)
      .slice(0, 3);

    const round1: DriftRound = {
      round: 1,
      strategy: "Global community search to identify relevant knowledge domains",
      communitiesExplored: relevantCommunities.map((c) => c.communityId),
      keyFindings: relevantCommunities.map(
        (c) => `[${c.communityId}] (${c.pageCount} pages, score: ${c.relevanceScore.toFixed(2)}): ${c.summary.slice(0, 200)}...`
      ),
      followUpQueries: [],
    };

    // Generate follow-up queries based on community summaries
    if (relevantCommunities.length > 0) {
      const communitySummaryText = relevantCommunities
        .map((c) => c.summary.slice(0, 500))
        .join("\n\n");

      round1.followUpQueries = await this.generateFollowUpQueries(
        query,
        communitySummaryText,
        1
      );
    }

    rounds.push(round1);
    contextParts.push(
      `## Community Context\n${relevantCommunities.map((c) => c.summary).join("\n\n")}`
    );

    if (maxRounds < 2) {
      return {
        rounds,
        finalContext: contextParts.join("\n\n---\n\n"),
        pagesCovered: [...allPagesCovered],
        blocksRetrieved: allBlockUids.size,
      };
    }

    // ── Round 2: Local search within identified communities ───────

    const queriesToRun =
      round1.followUpQueries.length > 0
        ? round1.followUpQueries.slice(0, 3)
        : [query];

    const round2Findings: string[] = [];
    const round2Communities: string[] = [];
    const round2BlockUids: string[] = [];

    for (const subQuery of queriesToRun) {
      // Find seed pages from relevant communities
      const seedPages: string[] = [];
      for (const community of relevantCommunities) {
        const detail = await this.globalSearch.getCommunitySummary(community.communityId);
        if (detail) {
          seedPages.push(...detail.pages.slice(0, 5));
        }
      }

      const localResult = await this.localSearch.search(subQuery, {
        seedPages: seedPages.length > 0 ? seedPages : undefined,
        maxHops: 1,
        maxResults: 10,
      });

      for (const result of localResult.results) {
        allBlockUids.add(result.blockUid);
        round2BlockUids.push(result.blockUid);
        allPagesCovered.add(result.pageTitle);
      }

      localResult.pagesTraversed.forEach((p) => allPagesCovered.add(p));

      if (localResult.results.length > 0) {
        round2Findings.push(
          `Query "${subQuery}": Found ${localResult.results.length} blocks across ${localResult.pagesTraversed.length} pages`
        );
      }
    }

    const round2: DriftRound = {
      round: 2,
      strategy: "Local search within identified communities with focused sub-queries",
      communitiesExplored: round2Communities,
      keyFindings: round2Findings,
      followUpQueries: [],
    };

    // Generate round 3 follow-up queries
    if (maxRounds >= 3 && round2Findings.length > 0) {
      round2.followUpQueries = await this.generateFollowUpQueries(
        query,
        round2Findings.join("\n"),
        2
      );
    }

    rounds.push(round2);

    if (maxRounds < 3 || round2BlockUids.length === 0) {
      // Assemble context from round 2 results
      if (round2BlockUids.length > 0) {
        const blockContext = await this.contextBuilder.assembleContext(
          round2BlockUids.slice(0, 10),
          this.config.telescopingTokenBudget
        );
        contextParts.push(blockContext);
      }

      return {
        rounds,
        finalContext: contextParts.join("\n\n---\n\n"),
        pagesCovered: [...allPagesCovered],
        blocksRetrieved: allBlockUids.size,
      };
    }

    // ── Round 3: Deep block-level retrieval with graph expansion ──

    const deepQueries =
      round2.followUpQueries.length > 0
        ? round2.followUpQueries.slice(0, 2)
        : [query];

    const round3Findings: string[] = [];

    for (const subQuery of deepQueries) {
      const localResult = await this.localSearch.search(subQuery, {
        maxHops: 2,
        maxResults: 15,
      });

      for (const result of localResult.results) {
        allBlockUids.add(result.blockUid);
        allPagesCovered.add(result.pageTitle);
      }

      if (localResult.results.length > 0) {
        round3Findings.push(
          `Deep query "${subQuery}": Found ${localResult.results.length} additional blocks`
        );
      }
    }

    rounds.push({
      round: 3,
      strategy: "Deep block-level retrieval with graph expansion",
      communitiesExplored: [],
      keyFindings: round3Findings,
      followUpQueries: [],
    });

    // Assemble final context from all unique blocks
    const allUids = [...allBlockUids].slice(0, 20);
    if (allUids.length > 0) {
      const blockContext = await this.contextBuilder.assembleContext(
        allUids,
        this.config.telescopingTokenBudget
      );
      contextParts.push(blockContext);
    }

    return {
      rounds,
      finalContext: contextParts.join("\n\n---\n\n"),
      pagesCovered: [...allPagesCovered],
      blocksRetrieved: allBlockUids.size,
    };
  }

  private async generateFollowUpQueries(
    originalQuery: string,
    findingsSoFar: string,
    round: number
  ): Promise<string[]> {
    const prompt = `Given the original query and findings so far, generate 2-3 specific follow-up search queries that would help find more relevant information.

Original query: "${originalQuery}"

Findings from round ${round}:
${findingsSoFar}

Generate 2-3 follow-up queries as a JSON array of strings. Focus on:
- Specific concepts mentioned in the findings that deserve deeper exploration
- Related topics that weren't directly covered
- Different angles on the original question

Respond with ONLY a JSON array, e.g.: ["query 1", "query 2", "query 3"]`;

    const text = await this.callLLM(prompt);

    try {
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch {
      // Fallback: no follow-ups
    }
    return [];
  }

  private async callLLM(prompt: string): Promise<string> {
    if (this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.config.llmModel,
        max_tokens: 512,
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
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });
      return response.choices[0]?.message?.content ?? "";
    }

    return "[]";
  }
}
