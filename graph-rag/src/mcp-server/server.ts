import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";

import type { GraphRAGConfig } from "../config/index.js";
import type { IndexStore } from "../index/store.js";
import type { LocalSearch } from "../retrieval/local.js";
import type { GlobalSearch } from "../retrieval/global.js";
import type { DriftSearch } from "../retrieval/drift.js";
import type { TemporalSearch } from "../retrieval/temporal.js";
import type { NeighborhoodExplorer } from "../retrieval/neighborhood.js";
import type { AttributeFilter } from "../retrieval/attribute-filter.js";
import type { Indexer } from "../indexer.js";

import { globalSearchSchema, handleGlobalSearch } from "./tools/global-search.js";
import { localSearchSchema, handleLocalSearch } from "./tools/local-search.js";
import { driftSearchSchema, handleDriftSearch } from "./tools/drift-search.js";
import { temporalSearchSchema, handleTemporalSearch } from "./tools/temporal-search.js";
import {
  exploreNeighborhoodSchema,
  handleExploreNeighborhood,
} from "./tools/explore-neighborhood.js";
import { attributeFilterSchema, handleAttributeFilter } from "./tools/attribute-filter.js";

export interface ServerDependencies {
  config: GraphRAGConfig;
  store: IndexStore;
  localSearch: LocalSearch;
  globalSearch: GlobalSearch;
  driftSearch: DriftSearch;
  temporalSearch: TemporalSearch;
  neighborhoodExplorer: NeighborhoodExplorer;
  attributeFilter: AttributeFilter;
  indexer: Indexer;
}

export function createGraphRAGServer(deps: ServerDependencies): McpServer {
  const server = new McpServer({
    name: "roam-graph-rag",
    version: "0.1.0",
  });

  // ─── Tools ──────────────────────────────────────────────────────

  server.tool(
    "global_search",
    "Search across the entire knowledge graph using community summaries. Best for broad, thematic, or overview questions like 'What are the main themes in my notes?' or 'Summarize my research areas'.",
    globalSearchSchema.shape,
    async (input) => {
      const result = await handleGlobalSearch(input as z.infer<typeof globalSearchSchema>, deps.globalSearch);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "local_search",
    "Search for specific content within the knowledge graph. Uses embedding similarity + graph expansion to find relevant blocks. Best for focused queries about particular topics or concepts.",
    localSearchSchema.shape,
    async (input) => {
      const result = await handleLocalSearch(input as z.infer<typeof localSearchSchema>, deps.localSearch);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drift_search",
    "DRIFT (Dynamic Reasoning and Inference with Flexible Traversal) search. Starts broad with community summaries, then progressively narrows down through multiple rounds. Best for complex, multi-faceted queries.",
    driftSearchSchema.shape,
    async (input) => {
      const result = await handleDriftSearch(input as z.infer<typeof driftSearchSchema>, deps.driftSearch);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "temporal_search",
    "Search by time period. Finds what pages were mentioned or active within a date range. Best for questions like 'What was I working on last month?' or 'When did I last reference Project X?'.",
    temporalSearchSchema.shape,
    async (input) => {
      const result = await handleTemporalSearch(input as z.infer<typeof temporalSearchSchema>, deps.temporalSearch);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "explore_neighborhood",
    "Explore the graph neighborhood of a page or block. Traverses co-references, direct links, and block references to map the local graph structure. Returns nodes and edges.",
    exploreNeighborhoodSchema.shape,
    async (input) => {
      const result = await handleExploreNeighborhood(
        input as z.infer<typeof exploreNeighborhoodSchema>,
        deps.neighborhoodExplorer
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "attribute_filter",
    "Filter pages by structured attributes (Roam `Attribute:: Value` pairs). Best for queries like 'pages with Status:: Done' or 'Author:: [[John]]'.",
    attributeFilterSchema.shape,
    async (input) => {
      const result = await handleAttributeFilter(
        input as z.infer<typeof attributeFilterSchema>,
        deps.attributeFilter
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Index Management Tools ─────────────────────────────────────

  server.tool(
    "reindex",
    "Trigger a full or incremental reindex of the Roam graph. Use 'full' for first-time indexing or to rebuild from scratch. Use 'incremental' to update only what changed since last index.",
    {
      mode: z.enum(["full", "incremental"]).describe("Reindex mode"),
    },
    async (input) => {
      if (input.mode === "full") {
        await deps.indexer.fullIndex();
        const stats = deps.store.getStats();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "completed", stats }, null, 2),
            },
          ],
        };
      } else {
        const result = await deps.indexer.incrementalIndex();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "completed", ...result }, null, 2),
            },
          ],
        };
      }
    }
  );

  // ─── Resources ──────────────────────────────────────────────────

  server.resource(
    "index-stats",
    "graph-rag://stats",
    async () => {
      const stats = deps.store.getStats();
      return {
        contents: [
          {
            uri: "graph-rag://stats",
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "community-overview",
    "graph-rag://communities",
    async () => {
      const communities = deps.store.getAllCommunities();
      const overview = communities.map((c) => ({
        id: c.id,
        level: c.level,
        page_count: c.page_count,
        summary_preview: (c.summary ?? c.tree_derived_summary ?? "").slice(0, 200),
      }));
      return {
        contents: [
          {
            uri: "graph-rag://communities",
            mimeType: "application/json",
            text: JSON.stringify(overview, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

export async function startServer(
  server: McpServer,
  port: number
): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/mcp") {
      const body = await readBody(req);
      const parsed = JSON.parse(body);

      // Get or create session transport
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        await server.connect(transport);
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          transports.set(newSessionId, transport);
        }
      }

      await transport.handleRequest(req, res, parsed);
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`Graph-RAG MCP server listening on port ${port}`);
      resolve();
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
