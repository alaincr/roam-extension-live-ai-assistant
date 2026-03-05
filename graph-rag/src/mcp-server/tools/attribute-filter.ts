import { z } from "zod";
import type { AttributeFilter } from "../../retrieval/attribute-filter.js";

export const attributeFilterSchema = z.object({
  filters: z.array(
    z.object({
      attribute: z.string().describe("Attribute name (e.g., 'Status', 'Author', 'Priority')"),
      operator: z.enum(["equals", "contains", "regex"]).describe("Match operator"),
      value: z.string().describe("Value to match against"),
    })
  ),
  combine: z.enum(["AND", "OR"]).describe("How to combine multiple filters"),
  include_content: z
    .boolean()
    .optional()
    .describe("Whether to include page content preview"),
});

export type AttributeFilterInput = z.infer<typeof attributeFilterSchema>;

export async function handleAttributeFilter(
  input: AttributeFilterInput,
  attributeFilter: AttributeFilter
) {
  const result = await attributeFilter.filter({
    filters: input.filters,
    combine: input.combine,
    includeContent: input.include_content,
  });

  return {
    pages: result.pages.map((p) => ({
      title: p.title,
      uid: p.uid,
      matched_attributes: p.matchedAttributes,
      content_preview: p.contentPreview,
    })),
  };
}
