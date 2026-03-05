import { IndexStore } from "../index/store.js";
import { RoamMCPClient } from "../roam-client/roam-mcp-client.js";

export class AttributeFilter {
  constructor(
    private store: IndexStore,
    private roamClient: RoamMCPClient
  ) {}

  async filter(options: {
    filters: Array<{
      attribute: string;
      operator: "equals" | "contains" | "regex";
      value: string;
    }>;
    combine: "AND" | "OR";
    includeContent?: boolean;
  }): Promise<{
    pages: Array<{
      title: string;
      uid: string;
      matchedAttributes: Record<string, string>;
      contentPreview?: string;
    }>;
  }> {
    if (options.filters.length === 0) {
      return { pages: [] };
    }

    // Execute each filter
    const filterResults: Map<string, Map<string, Record<string, string>>> = new Map();

    for (const filter of options.filters) {
      const matches = this.store.filterByAttribute(
        filter.attribute,
        filter.operator,
        filter.value
      );

      for (const match of matches) {
        if (!filterResults.has(filter.attribute)) {
          filterResults.set(filter.attribute, new Map());
        }
        const attrMap = filterResults.get(filter.attribute)!;

        if (!attrMap.has(match.page_title)) {
          attrMap.set(match.page_title, { [filter.attribute]: match.attr_value });
        } else {
          attrMap.get(match.page_title)![filter.attribute] = match.attr_value;
        }
      }
    }

    // Combine results based on AND/OR
    let resultPages: Map<string, Record<string, string>>;

    if (options.combine === "AND") {
      // Pages must appear in ALL filter results
      const filterKeys = [...filterResults.keys()];
      if (filterKeys.length === 0) return { pages: [] };

      const firstFilter = filterResults.get(filterKeys[0])!;
      resultPages = new Map();

      for (const [pageTitle, attrs] of firstFilter) {
        let inAll = true;
        const mergedAttrs = { ...attrs };

        for (let i = 1; i < filterKeys.length; i++) {
          const otherFilter = filterResults.get(filterKeys[i])!;
          if (!otherFilter.has(pageTitle)) {
            inAll = false;
            break;
          }
          Object.assign(mergedAttrs, otherFilter.get(pageTitle));
        }

        if (inAll) {
          resultPages.set(pageTitle, mergedAttrs);
        }
      }
    } else {
      // Pages appear in ANY filter result
      resultPages = new Map();
      for (const [_, attrMap] of filterResults) {
        for (const [pageTitle, attrs] of attrMap) {
          if (resultPages.has(pageTitle)) {
            Object.assign(resultPages.get(pageTitle)!, attrs);
          } else {
            resultPages.set(pageTitle, { ...attrs });
          }
        }
      }
    }

    // Build output
    const pages: Array<{
      title: string;
      uid: string;
      matchedAttributes: Record<string, string>;
      contentPreview?: string;
    }> = [];

    for (const [pageTitle, attrs] of resultPages) {
      const page = this.store.getPageByTitle(pageTitle);
      if (!page) continue;

      let contentPreview: string | undefined;
      if (options.includeContent) {
        const children = await this.roamClient.getPageTree(page.uid);
        contentPreview = children
          .slice(0, 5)
          .map((c) => c.string)
          .join("\n");
      }

      pages.push({
        title: pageTitle,
        uid: page.uid,
        matchedAttributes: attrs,
        contentPreview,
      });
    }

    return { pages };
  }
}
