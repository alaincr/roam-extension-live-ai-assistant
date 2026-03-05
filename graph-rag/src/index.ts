import { loadConfig, type GraphRAGConfig } from "./config/index.js";
import { RoamMCPClient } from "./roam-client/roam-mcp-client.js";
import { IndexStore } from "./index/store.js";
import { EmbeddingService } from "./index/embeddings.js";
import { GraphExtractor } from "./graph/extractor.js";
import { Indexer } from "./indexer.js";
import { LocalSearch } from "./retrieval/local.js";
import { GlobalSearch } from "./retrieval/global.js";
import { DriftSearch } from "./retrieval/drift.js";
import { TemporalSearch } from "./retrieval/temporal.js";
import { NeighborhoodExplorer } from "./retrieval/neighborhood.js";
import { AttributeFilter } from "./retrieval/attribute-filter.js";
import { ContextBuilder } from "./retrieval/context-builder.js";
import { createGraphRAGServer, startServer } from "./mcp-server/server.js";

async function main() {
  const config = loadConfig();

  console.log("[graph-rag] Initializing...");
  console.log(`[graph-rag] Roam MCP: ${config.roamMcpUrl}`);
  console.log(`[graph-rag] DB: ${config.dbPath}`);
  console.log(`[graph-rag] Embedding: ${config.embeddingProvider}/${config.embeddingModel}`);
  console.log(`[graph-rag] LLM: ${config.llmProvider}/${config.llmModel}`);

  // Initialize core services
  const roamClient = new RoamMCPClient(config);
  const store = new IndexStore(config);
  const embeddings = new EmbeddingService(config);
  const extractor = new GraphExtractor(roamClient);
  const contextBuilder = new ContextBuilder(roamClient, store);

  // Initialize indexer
  const indexer = new Indexer(config, roamClient, store, embeddings);

  // Initialize retrieval engines
  const localSearch = new LocalSearch(store, embeddings, extractor, contextBuilder, config);
  const globalSearch = new GlobalSearch(store, embeddings, config);
  const driftSearch = new DriftSearch(globalSearch, localSearch, contextBuilder, config);
  const temporalSearch = new TemporalSearch(store, embeddings);
  const neighborhoodExplorer = new NeighborhoodExplorer(store, extractor);
  const attributeFilter = new AttributeFilter(store, roamClient);

  // Create and start MCP server
  const server = createGraphRAGServer({
    config,
    store,
    localSearch,
    globalSearch,
    driftSearch,
    temporalSearch,
    neighborhoodExplorer,
    attributeFilter,
    indexer,
  });

  // Check if we need initial indexing
  const stats = store.getStats();
  if (stats.pageCount === 0) {
    console.log("[graph-rag] No index found. Run the 'reindex' tool with mode 'full' to build the index.");
  } else {
    console.log(
      `[graph-rag] Existing index: ${stats.pageCount} pages, ${stats.blockCount} blocks, ${stats.communityCount} communities`
    );
  }

  await startServer(server, config.mcpServerPort);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[graph-rag] Shutting down...");
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[graph-rag] Fatal error:", err);
  process.exit(1);
});

// Re-export modules for library usage
export { loadConfig } from "./config/index.js";
export { RoamMCPClient } from "./roam-client/roam-mcp-client.js";
export { IndexStore } from "./index/store.js";
export { EmbeddingService } from "./index/embeddings.js";
export { GraphExtractor } from "./graph/extractor.js";
export { CommunityDetector } from "./community/detection.js";
export { CommunitySummarizer } from "./community/summarizer.js";
export { Indexer } from "./indexer.js";
export { LocalSearch } from "./retrieval/local.js";
export { GlobalSearch } from "./retrieval/global.js";
export { DriftSearch } from "./retrieval/drift.js";
export { TemporalSearch } from "./retrieval/temporal.js";
export { NeighborhoodExplorer } from "./retrieval/neighborhood.js";
export { AttributeFilter } from "./retrieval/attribute-filter.js";
export { ContextBuilder } from "./retrieval/context-builder.js";
export { createGraphRAGServer, startServer } from "./mcp-server/server.js";
export type { GraphRAGConfig } from "./config/index.js";
