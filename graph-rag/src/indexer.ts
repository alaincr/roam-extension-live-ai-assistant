import type { GraphRAGConfig } from "./config/index.js";
import { RoamMCPClient } from "./roam-client/roam-mcp-client.js";
import { IndexStore } from "./index/store.js";
import { EmbeddingService } from "./index/embeddings.js";
import { GraphExtractor } from "./graph/extractor.js";
import { CommunityDetector } from "./community/detection.js";
import { CommunitySummarizer } from "./community/summarizer.js";
import type { BlockNode, TemporalMention } from "./graph/types.js";

export class Indexer {
  private extractor: GraphExtractor;
  private detector: CommunityDetector;
  private summarizer: CommunitySummarizer;

  constructor(
    private config: GraphRAGConfig,
    private roamClient: RoamMCPClient,
    private store: IndexStore,
    private embeddings: EmbeddingService
  ) {
    this.extractor = new GraphExtractor(roamClient);
    this.detector = new CommunityDetector(config);
    this.summarizer = new CommunitySummarizer(config, roamClient, store, embeddings);
  }

  // ─── Full Index ────────────────────────────────────────────────

  async fullIndex(): Promise<void> {
    console.log("[indexer] Starting full index...");
    const startTime = Date.now();

    // Step 1: Extract page metadata
    console.log("[indexer] Extracting page metadata...");
    const pageMetadata = await this.extractor.extractPageMetadata();
    this.store.upsertPages(pageMetadata);
    console.log(`[indexer] Indexed ${pageMetadata.length} pages`);

    // Step 2: Extract all graph layers
    console.log("[indexer] Extracting co-reference graph...");
    const coRefEdges = await this.extractor.extractCoRefGraph();
    this.store.replaceCoRefEdges(coRefEdges);
    console.log(`[indexer] ${coRefEdges.length} co-reference edges`);

    console.log("[indexer] Extracting direct links...");
    const directLinks = await this.extractor.extractDirectLinks();
    this.store.replaceDirectLinkEdges(directLinks);
    console.log(`[indexer] ${directLinks.length} direct link edges`);

    console.log("[indexer] Extracting attributes...");
    const attributes = await this.extractor.extractAttributes();
    this.store.replaceAttributes(attributes);
    console.log(`[indexer] ${attributes.length} attributes`);

    console.log("[indexer] Extracting temporal mentions...");
    const temporalMentions = await this.extractor.extractTemporalMentions();
    const aggregatedTemporal = aggregateTemporalMentions(temporalMentions);
    this.store.replaceTemporalMentions(aggregatedTemporal);
    console.log(`[indexer] ${aggregatedTemporal.length} temporal mention entries`);

    // Step 3: Community detection
    console.log("[indexer] Running community detection...");
    const hierarchy = this.detector.detectHierarchy(coRefEdges);
    console.log(`[indexer] Detected ${hierarchy.length} hierarchy levels`);

    const communityData: Array<{
      id: string;
      level: number;
      resolution: number;
      pages: string[];
    }> = [];

    for (const level of hierarchy) {
      for (const [communityId, pages] of level.communities) {
        const id = `L${level.level}_C${communityId}`;
        communityData.push({
          id,
          level: level.level,
          resolution: level.resolution,
          pages,
        });
      }
    }

    this.store.replaceCommunities(communityData);

    // Store inter-community edges
    const interEdges = this.detector.computeInterCommunityEdges(coRefEdges, hierarchy);
    for (const [levelNum, edges] of interEdges) {
      // Remap community IDs
      const level = hierarchy[levelNum];
      if (!level) continue;

      const remapped = edges.map((e) => ({
        sourceId: `L${levelNum}_C${e.sourceId}`,
        targetId: `L${levelNum}_C${e.targetId}`,
        weight: e.weight,
      }));

      this.store.setCommunityEdges(remapped);
    }

    console.log(`[indexer] Stored ${communityData.length} communities`);

    // Step 4: Generate embeddings for pages
    console.log("[indexer] Generating page embeddings...");
    await this.embedPages();

    // Step 5: Generate block/branch embeddings
    console.log("[indexer] Generating block and branch embeddings...");
    await this.embedBlocksAndBranches();

    // Step 6: Generate community summaries
    console.log("[indexer] Generating community summaries...");
    await this.summarizer.summarizeAllCommunities();

    // Step 7: Record completion
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.store.setMeta("last_full_index", String(Date.now()));
    this.store.setMeta("last_incremental_update", String(Date.now()));
    console.log(`[indexer] Full index completed in ${elapsed}s`);

    const stats = this.store.getStats();
    console.log(
      `[indexer] Index stats: ${stats.pageCount} pages, ${stats.blockCount} blocks, ${stats.branchCount} branches, ${stats.communityCount} communities`
    );
  }

  // ─── Incremental Index ─────────────────────────────────────────

  async incrementalIndex(): Promise<{
    pagesAffected: number;
    blocksUpdated: number;
    communitiesRefreshed: number;
  }> {
    const lastTimestamp = this.store.getLastIncrementalTimestamp();
    if (lastTimestamp === 0) {
      // No previous index -- do a full index instead
      await this.fullIndex();
      return { pagesAffected: 0, blocksUpdated: 0, communitiesRefreshed: 0 };
    }

    console.log("[indexer] Starting incremental index...");

    // Step 1: Detect changes
    const changes = await this.extractor.detectChanges(lastTimestamp);
    if (changes.length === 0) {
      console.log("[indexer] No changes detected");
      this.store.setMeta("last_incremental_update", String(Date.now()));
      return { pagesAffected: 0, blocksUpdated: 0, communitiesRefreshed: 0 };
    }

    const affectedPages = new Set(changes.map((c) => c.pageTitle));
    console.log(
      `[indexer] ${changes.length} modified blocks across ${affectedPages.size} pages`
    );

    // Step 2: Re-extract co-reference edges for affected pages
    const newEdges = await this.extractor.extractCoRefEdgesForPages([...affectedPages]);
    // TODO: smarter merge instead of full replace
    const allEdges = await this.extractor.extractCoRefGraph();
    this.store.replaceCoRefEdges(allEdges);

    // Step 3: Re-run community detection (fast on co-ref graph)
    const hierarchy = this.detector.detectHierarchy(allEdges);
    const communityData: Array<{
      id: string;
      level: number;
      resolution: number;
      pages: string[];
    }> = [];

    for (const level of hierarchy) {
      for (const [communityId, pages] of level.communities) {
        communityData.push({
          id: `L${level.level}_C${communityId}`,
          level: level.level,
          resolution: level.resolution,
          pages,
        });
      }
    }
    this.store.replaceCommunities(communityData);

    // Step 4: Mark affected communities as dirty
    const affectedCommunityIds = new Set<string>();
    for (const pageTitle of affectedPages) {
      const cIds = this.store.getCommunitiesForPage(pageTitle);
      cIds.forEach((id) => affectedCommunityIds.add(id));
    }
    for (const cId of affectedCommunityIds) {
      this.store.markCommunityDirty(cId);
    }

    // Step 5: Re-embed affected pages and their blocks
    for (const pageTitle of affectedPages) {
      const page = this.store.getPageByTitle(pageTitle);
      if (!page) continue;

      // Re-embed page
      await this.embedSinglePage(page.uid, page.title);

      // Re-embed blocks for this page
      this.store.deleteBlocksForPage(page.uid);
      await this.embedBlocksForPage(page.uid, page.title);
    }

    // Step 6: Regenerate dirty community summaries
    const communitiesRefreshed = await this.summarizer.regenerateDirtySummaries();

    this.store.setMeta("last_incremental_update", String(Date.now()));

    console.log(
      `[indexer] Incremental index done: ${affectedPages.size} pages, ${changes.length} blocks, ${communitiesRefreshed} communities refreshed`
    );

    return {
      pagesAffected: affectedPages.size,
      blocksUpdated: changes.length,
      communitiesRefreshed,
    };
  }

  // ─── Embedding Pipelines ───────────────────────────────────────

  private async embedPages(): Promise<void> {
    const pages = this.store.getAllPageTitles();
    const batchSize = this.config.embeddingBatchSize;

    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const texts: string[] = [];
      const uids: string[] = [];

      for (const title of batch) {
        const page = this.store.getPageByTitle(title);
        if (!page) continue;

        // Get L0 blocks for page embedding
        const tree = await this.roamClient.getPageTree(page.uid);
        const l0Text = tree
          .slice(0, 10)
          .map((b) => b.string)
          .join("\n");

        texts.push(`${title}\n${l0Text}`);
        uids.push(page.uid);
      }

      if (texts.length === 0) continue;

      const embeddings = await this.embeddings.embedBatch(texts);

      for (let j = 0; j < uids.length; j++) {
        this.store.updatePageEmbedding(
          uids[j],
          EmbeddingService.embeddingToBuffer(embeddings[j])
        );
      }

      console.log(
        `[indexer] Embedded pages ${i + 1}-${Math.min(i + batchSize, pages.length)} of ${pages.length}`
      );
    }
  }

  private async embedSinglePage(uid: string, title: string): Promise<void> {
    const tree = await this.roamClient.getPageTree(uid);
    const l0Text = tree
      .slice(0, 10)
      .map((b) => b.string)
      .join("\n");

    const embedding = await this.embeddings.embed(`${title}\n${l0Text}`);
    this.store.updatePageEmbedding(uid, EmbeddingService.embeddingToBuffer(embedding));
  }

  private async embedBlocksAndBranches(): Promise<void> {
    const pages = this.store.getAllPageTitles();

    for (const title of pages) {
      const page = this.store.getPageByTitle(title);
      if (!page) continue;
      await this.embedBlocksForPage(page.uid, title);
    }
  }

  private async embedBlocksForPage(pageUid: string, pageTitle: string): Promise<void> {
    const tree = await this.roamClient.getPageTree(pageUid);
    if (tree.length === 0) return;

    const branchTexts: Array<{ uid: string; text: string }> = [];
    const blockTexts: Array<{
      uid: string;
      branchUid: string;
      ancestorPath: string;
      content: string;
      depth: number;
      text: string;
    }> = [];

    for (const branch of tree) {
      // Store branch
      const branchContent = flattenSubtree(branch, 0);
      const branchPreview = branch.string.slice(0, 200);
      const branchTokens = Math.ceil(branchContent.length / 4);

      this.store.upsertBranch(branch.uid, pageUid, branchPreview, branchTokens);

      // Branch embedding text
      const branchText = `${pageTitle} > ${branch.string}\n${branchContent}`.slice(
        0,
        this.config.maxBlockEmbeddingChars
      );
      branchTexts.push({ uid: branch.uid, text: branchText });

      // Process blocks in the subtree
      collectBlocks(branch, pageTitle, branch.uid, pageUid, [pageTitle], 0, blockTexts, this.config);
    }

    // Embed branches
    if (branchTexts.length > 0) {
      const embeddings = await this.embeddings.embedBatch(branchTexts.map((b) => b.text));
      for (let i = 0; i < branchTexts.length; i++) {
        this.store.updateBranchEmbedding(
          branchTexts[i].uid,
          EmbeddingService.embeddingToBuffer(embeddings[i])
        );
      }
    }

    // Store and embed blocks
    for (const block of blockTexts) {
      this.store.upsertBlock(
        block.uid,
        pageUid,
        block.branchUid,
        block.ancestorPath,
        block.content,
        block.depth
      );
    }

    if (blockTexts.length > 0) {
      // Batch embed blocks
      const batchSize = this.config.embeddingBatchSize;
      for (let i = 0; i < blockTexts.length; i += batchSize) {
        const batch = blockTexts.slice(i, i + batchSize);
        const embeddings = await this.embeddings.embedBatch(batch.map((b) => b.text));
        for (let j = 0; j < batch.length; j++) {
          this.store.updateBlockEmbedding(
            batch[j].uid,
            EmbeddingService.embeddingToBuffer(embeddings[j])
          );
        }
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

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

function collectBlocks(
  node: BlockNode,
  pageTitle: string,
  branchUid: string,
  pageUid: string,
  pathParts: string[],
  depth: number,
  output: Array<{
    uid: string;
    branchUid: string;
    ancestorPath: string;
    content: string;
    depth: number;
    text: string;
  }>,
  config: GraphRAGConfig
): void {
  if (node.string.length >= config.minBlockContentLength) {
    const ancestorPath = pathParts.join(" > ");
    const embeddingText = `${ancestorPath}\n${node.string}`.slice(
      0,
      config.maxBlockEmbeddingChars
    );

    output.push({
      uid: node.uid,
      branchUid,
      ancestorPath,
      content: node.string,
      depth,
      text: embeddingText,
    });
  }

  if (node.children) {
    for (const child of node.children) {
      const childPath = [...pathParts, node.string.slice(0, 80)];
      collectBlocks(child, pageTitle, branchUid, pageUid, childPath, depth + 1, output, config);
    }
  }
}

function aggregateTemporalMentions(
  mentions: TemporalMention[]
): Array<{ pageTitle: string; dnpDate: string; count: number }> {
  const map = new Map<string, number>();

  for (const m of mentions) {
    const dnpDate = parseDnpTitleToDate(m.dnpTitle);
    if (!dnpDate) continue;

    const key = `${m.pageTitle}|${dnpDate}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return [...map.entries()].map(([key, count]) => {
    const [pageTitle, dnpDate] = key.split("|");
    return { pageTitle, dnpDate, count };
  });
}

function parseDnpTitleToDate(title: string): string | null {
  // Roam DNP format: "January 1st, 2024"
  const match = title.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th),\s+(\d{4})$/
  );
  if (!match) return null;

  const months: Record<string, string> = {
    January: "01", February: "02", March: "03", April: "04",
    May: "05", June: "06", July: "07", August: "08",
    September: "09", October: "10", November: "11", December: "12",
  };

  const month = months[match[1]];
  const day = match[2].padStart(2, "0");
  const year = match[3];

  return `${year}-${month}-${day}`;
}
