import { z } from "zod";
import type { TemporalSearch } from "../../retrieval/temporal.js";

export const temporalSearchSchema = z.object({
  query: z.string().optional().describe("Optional query to filter by relevance"),
  page_titles: z
    .array(z.string())
    .optional()
    .describe("Optional page titles to filter by"),
  date_range: z.object({
    start: z.string().describe("Start date (YYYY-MM-DD)"),
    end: z.string().describe("End date (YYYY-MM-DD)"),
  }),
  granularity: z
    .enum(["day", "week", "month"])
    .optional()
    .describe("Time grouping granularity"),
});

export type TemporalSearchInput = z.infer<typeof temporalSearchSchema>;

export async function handleTemporalSearch(
  input: TemporalSearchInput,
  temporalSearch: TemporalSearch
) {
  const result = await temporalSearch.search({
    query: input.query,
    pageTitles: input.page_titles,
    dateRange: input.date_range,
    granularity: input.granularity,
  });

  return {
    timeline: result.timeline.map((t) => ({
      date: t.date,
      pages_mentioned: t.pagesMentioned,
      key_blocks: t.keyBlocks,
    })),
    activity_summary: result.activitySummary,
  };
}
