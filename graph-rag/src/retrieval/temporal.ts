import { IndexStore } from "../index/store.js";
import { EmbeddingService } from "../index/embeddings.js";
import type { TemporalEntry } from "../graph/types.js";

export class TemporalSearch {
  constructor(
    private store: IndexStore,
    private embeddings: EmbeddingService
  ) {}

  async search(options: {
    query?: string;
    pageTitles?: string[];
    dateRange: { start: string; end: string };
    granularity?: "day" | "week" | "month";
  }): Promise<{
    timeline: TemporalEntry[];
    activitySummary: string;
  }> {
    const granularity = options.granularity ?? "day";

    // Get temporal mentions from index
    const mentions = this.store.getTemporalMentions(
      options.dateRange.start,
      options.dateRange.end,
      options.pageTitles
    );

    if (mentions.length === 0) {
      return {
        timeline: [],
        activitySummary: `No activity found between ${options.dateRange.start} and ${options.dateRange.end}`,
      };
    }

    // Group by date according to granularity
    const grouped = new Map<string, Map<string, number>>();

    for (const mention of mentions) {
      const dateKey = bucketDate(mention.dnp_date, granularity);
      if (!grouped.has(dateKey)) grouped.set(dateKey, new Map());
      const pageMap = grouped.get(dateKey)!;
      pageMap.set(
        mention.page_title,
        (pageMap.get(mention.page_title) ?? 0) + mention.mention_count
      );
    }

    // Filter by query relevance if query is provided
    let relevantPages: Set<string> | null = null;
    if (options.query) {
      const queryEmbedding = await this.embeddings.embed(options.query);
      const pages = this.store.getPagesWithEmbeddings();
      const topPages = EmbeddingService.findTopK(
        queryEmbedding,
        pages.map((p) => ({ id: p.title, embedding: p.embedding })),
        20
      );
      relevantPages = new Set(topPages.map((p) => p.id));
    }

    // Build timeline
    const timeline: TemporalEntry[] = [];

    const sortedDates = [...grouped.keys()].sort();
    for (const date of sortedDates) {
      const pageMap = grouped.get(date)!;
      let filteredPages = [...pageMap.entries()];

      if (relevantPages) {
        filteredPages = filteredPages.filter(([page]) => relevantPages!.has(page));
      }

      if (filteredPages.length === 0) continue;

      // Sort by mention count
      filteredPages.sort((a, b) => b[1] - a[1]);

      timeline.push({
        date,
        pagesMentioned: filteredPages.map(([page]) => page),
        keyBlocks: [], // Could be enriched with actual block content if needed
      });
    }

    // Generate activity summary
    const totalMentions = mentions.reduce((s, m) => s + m.mention_count, 0);
    const uniquePages = new Set(mentions.map((m) => m.page_title)).size;
    const peakDate = sortedDates.reduce(
      (best, date) => {
        const count = [...(grouped.get(date)?.values() ?? [])].reduce((s, c) => s + c, 0);
        return count > best.count ? { date, count } : best;
      },
      { date: "", count: 0 }
    );

    const activitySummary = [
      `Period: ${options.dateRange.start} to ${options.dateRange.end}`,
      `Total mentions: ${totalMentions} across ${uniquePages} unique pages`,
      `Active ${granularity}s: ${timeline.length}`,
      peakDate.date ? `Peak activity: ${peakDate.date} (${peakDate.count} mentions)` : "",
      `Top pages: ${getTopPages(mentions, 5).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { timeline, activitySummary };
  }
}

function bucketDate(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;

  const d = new Date(date);
  if (granularity === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  // Week: get Monday of the week
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

function getTopPages(
  mentions: Array<{ page_title: string; mention_count: number }>,
  k: number
): string[] {
  const pageCounts = new Map<string, number>();
  for (const m of mentions) {
    pageCounts.set(m.page_title, (pageCounts.get(m.page_title) ?? 0) + m.mention_count);
  }

  return [...pageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([page]) => page);
}
