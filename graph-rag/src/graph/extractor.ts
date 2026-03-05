import { RoamMCPClient } from "../roam-client/roam-mcp-client.js";
import type {
  CoRefEdge,
  DirectLinkEdge,
  BlockRefEdge,
  AttributeEntry,
  TemporalMention,
  PageMetadata,
} from "./types.js";

// DNP UID pattern: MM-DD-YYYY
const DNP_REGEX_PATTERN = `"(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\\\d{2}"`;

// DNP title pattern: "Month Dth, YYYY"
const DNP_TITLE_REGEX_PATTERN = `"(?:January|February|March|April|May|June|July|August|September|October|November|December) \\\\d{1,2}(?:st|nd|rd|th), \\\\d{4}"`;

export class GraphExtractor {
  constructor(private client: RoamMCPClient) {}

  // ─── Layer 1: Page Co-Reference Graph ───────────────────────────

  async extractCoRefGraph(): Promise<CoRefEdge[]> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?title-a ?title-b (count ?b)
       :where
       [?b :block/refs ?page-a]
       [?b :block/refs ?page-b]
       [?page-a :node/title ?title-a]
       [?page-b :node/title ?title-b]
       [(< ?title-a ?title-b)]
       [(re-pattern ${DNP_TITLE_REGEX_PATTERN}) ?dnp]
       (not [(re-find ?dnp ?title-a)])
       (not [(re-find ?dnp ?title-b)])]
    `);

    return result.results.map(([source, target, weight]) => ({
      source: source as string,
      target: target as string,
      weight: weight as number,
    }));
  }

  async extractCoRefEdgesForPages(pageTitles: string[]): Promise<CoRefEdge[]> {
    if (pageTitles.length === 0) return [];

    // Build a set-based filter for Datomic
    const titleSet = pageTitles.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(" ");

    const result = await this.client.executeDatalogQuery(`
      [:find ?title-a ?title-b (count ?b)
       :in $ ?title-set
       :where
       [?b :block/refs ?page-a]
       [?b :block/refs ?page-b]
       [?page-a :node/title ?title-a]
       [?page-b :node/title ?title-b]
       [(< ?title-a ?title-b)]
       [(contains? ?title-set ?title-a)]]
    `, [new Set(pageTitles)]);

    return result.results.map(([source, target, weight]) => ({
      source: source as string,
      target: target as string,
      weight: weight as number,
    }));
  }

  // ─── Layer 2: Directed Link Graph ──────────────────────────────

  async extractDirectLinks(): Promise<DirectLinkEdge[]> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?source-title ?target-title (count ?b)
       :where
       [?b :block/refs ?target-page]
       [?b :block/page ?source-page]
       [?source-page :node/title ?source-title]
       [?target-page :node/title ?target-title]
       [(not= ?source-page ?target-page)]
       [(re-pattern ${DNP_TITLE_REGEX_PATTERN}) ?dnp]
       (not [(re-find ?dnp ?source-title)])]
    `);

    return result.results.map(([source, target, weight]) => ({
      source: source as string,
      target: target as string,
      weight: weight as number,
    }));
  }

  // ─── Layer 3: Block Reference Graph ────────────────────────────

  async extractBlockRefs(): Promise<BlockRefEdge[]> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?source-uid ?target-uid ?source-page-title ?target-page-title
       :where
       [?source :block/refs ?target]
       [?source :block/uid ?source-uid]
       [?target :block/uid ?target-uid]
       (not [?target :node/title _])
       [?source :block/page ?source-page]
       [?source-page :node/title ?source-page-title]
       [?target :block/page ?target-page]
       [?target-page :node/title ?target-page-title]]
    `);

    return result.results.map(([srcUid, tgtUid, srcPage, tgtPage]) => ({
      sourceUid: srcUid as string,
      targetUid: tgtUid as string,
      sourcePageTitle: srcPage as string,
      targetPageTitle: tgtPage as string,
    }));
  }

  // ─── Layer 4: Attribute Graph ──────────────────────────────────

  async extractAttributes(): Promise<AttributeEntry[]> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?page-title ?block-uid ?attr-name ?attr-value
       :where
       [?b :block/uid ?block-uid]
       [?b :block/string ?content]
       [?b :block/page ?page]
       [?page :node/title ?page-title]
       [(re-pattern "^([^:]+)::\\\\s*(.+)$") ?attr-pattern]
       [(re-find ?attr-pattern ?content) ?match]
       [(nth ?match 1) ?attr-name]
       [(nth ?match 2) ?attr-value]]
    `);

    return result.results.map(([pageTitle, blockUid, attrName, attrValue]) => ({
      pageTitle: pageTitle as string,
      blockUid: blockUid as string,
      attrName: (attrName as string).trim(),
      attrValue: (attrValue as string).trim(),
    }));
  }

  // ─── Layer 5: Temporal Graph ───────────────────────────────────

  async extractTemporalMentions(): Promise<TemporalMention[]> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?page-title ?dnp-title ?edit-time
       :where
       [?b :block/page ?dnp]
       [?dnp :node/title ?dnp-title]
       [(re-pattern ${DNP_TITLE_REGEX_PATTERN}) ?dnp-pattern]
       [(re-find ?dnp-pattern ?dnp-title)]
       [?b :block/refs ?page]
       [?page :node/title ?page-title]
       (not [(re-find ?dnp-pattern ?page-title)])
       [?b :edit/time ?edit-time]]
    `);

    return result.results.map(([pageTitle, dnpTitle, editTime]) => ({
      pageTitle: pageTitle as string,
      dnpTitle: dnpTitle as string,
      editTime: editTime as number,
    }));
  }

  // ─── Page Metadata ─────────────────────────────────────────────

  async extractPageMetadata(): Promise<PageMetadata[]> {
    // Two separate queries to avoid cross-product issues with count
    const childResult = await this.client.executeDatalogQuery(`
      [:find ?uid ?title (count ?child)
       :where
       [?page :node/title ?title]
       [?page :block/uid ?uid]
       [?page :block/children ?child]]
    `);

    const refResult = await this.client.executeDatalogQuery(`
      [:find ?uid (count ?ref)
       :where
       [?page :block/uid ?uid]
       [?page :node/title _]
       [?ref :block/refs ?page]]
    `);

    const refMap = new Map<string, number>();
    for (const [uid, count] of refResult.results) {
      refMap.set(uid as string, count as number);
    }

    return childResult.results.map(([uid, title, childCount]) => ({
      uid: uid as string,
      title: title as string,
      blockCount: childCount as number,
      refCount: refMap.get(uid as string) ?? 0,
    }));
  }

  // ─── Change Detection ──────────────────────────────────────────

  async detectChanges(sinceTimestamp: number): Promise<
    Array<{ blockUid: string; pageUid: string; pageTitle: string; editTime: number }>
  > {
    const result = await this.client.executeDatalogQuery(`
      [:find ?block-uid ?page-uid ?page-title ?edit-time
       :where
       [?b :block/uid ?block-uid]
       [?b :edit/time ?edit-time]
       [(> ?edit-time ${sinceTimestamp})]
       [?b :block/page ?page]
       [?page :block/uid ?page-uid]
       [?page :node/title ?page-title]]
    `);

    return result.results.map(([blockUid, pageUid, pageTitle, editTime]) => ({
      blockUid: blockUid as string,
      pageUid: pageUid as string,
      pageTitle: pageTitle as string,
      editTime: editTime as number,
    }));
  }

  // ─── Neighborhood Exploration ──────────────────────────────────

  async getLinkedPages(pageTitle: string): Promise<Array<{ title: string; weight: number }>> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?linked-title (count ?b)
       :where
       [?page :node/title "${pageTitle.replace(/"/g, '\\"')}"]
       [?b :block/page ?page]
       [?b :block/refs ?linked-page]
       [?linked-page :node/title ?linked-title]
       [(not= ?page ?linked-page)]]
    `);

    return result.results.map(([title, weight]) => ({
      title: title as string,
      weight: weight as number,
    }));
  }

  async getBacklinks(pageTitle: string): Promise<Array<{ title: string; weight: number }>> {
    const result = await this.client.executeDatalogQuery(`
      [:find ?source-title (count ?b)
       :where
       [?target :node/title "${pageTitle.replace(/"/g, '\\"')}"]
       [?b :block/refs ?target]
       [?b :block/page ?source]
       [?source :node/title ?source-title]
       [(not= ?source ?target)]]
    `);

    return result.results.map(([title, weight]) => ({
      title: title as string,
      weight: weight as number,
    }));
  }

  async getBlockRefsFrom(blockUids: string[]): Promise<
    Array<{ sourceUid: string; targetUid: string; targetContent: string; targetPage: string }>
  > {
    if (blockUids.length === 0) return [];

    const uidList = blockUids.map((u) => `"${u}"`).join(" ");
    const result = await this.client.executeDatalogQuery(`
      [:find ?source-uid ?target-uid ?target-content ?target-page-title
       :where
       [?source :block/uid ?source-uid]
       [(contains? #{${uidList}} ?source-uid)]
       [?source :block/refs ?target]
       (not [?target :node/title _])
       [?target :block/uid ?target-uid]
       [?target :block/string ?target-content]
       [?target :block/page ?target-page]
       [?target-page :node/title ?target-page-title]]
    `);

    return result.results.map(([srcUid, tgtUid, content, page]) => ({
      sourceUid: srcUid as string,
      targetUid: tgtUid as string,
      targetContent: content as string,
      targetPage: page as string,
    }));
  }
}
