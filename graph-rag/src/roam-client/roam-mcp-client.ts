import type { GraphRAGConfig } from "../config/index.js";
import type { BlockNode, AncestorNode } from "../graph/types.js";

interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

interface DatalogResult {
  results: unknown[][];
  count: number;
}

export class RoamMCPClient {
  private url: string;
  private requestId = 0;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(config: GraphRAGConfig) {
    this.url = config.roamMcpUrl;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const response = await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "roam-graph-rag", version: "0.1.0" },
      },
    });

    if (response.error) {
      throw new Error(`MCP init failed: ${response.error.message}`);
    }

    // Send initialized notification
    await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "notifications/initialized",
      params: {},
    });

    this.initialized = true;
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private async sendRaw(request: MCPRequest): Promise<MCPResponse> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(request),
    });

    const sessionId = res.headers.get("Mcp-Session-Id");
    if (sessionId) this.sessionId = sessionId;

    const text = await res.text();

    // Handle SSE-formatted responses
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          return JSON.parse(line.slice(6));
        }
      }
    }

    return JSON.parse(text);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();

    const response = await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (response.error) {
      throw new Error(`MCP tool ${name} error: ${response.error.message}`);
    }

    const content = response.result?.content;
    if (!content || content.length === 0) {
      return "{}";
    }

    return content.map((c) => c.text).join("");
  }

  // ─── Core Roam MCP Tools ────────────────────────────────────────

  async executeDatalogQuery(query: string, params?: unknown[]): Promise<DatalogResult> {
    const args: Record<string, unknown> = { query };
    if (params) args.params = params;

    const text = await this.callTool("execute_datalog_query", args);
    return JSON.parse(text) as DatalogResult;
  }

  async pullEntity(
    pattern: string,
    lookup: [string, string]
  ): Promise<Record<string, unknown>> {
    const text = await this.callTool("pull_entity", { pattern, lookup });
    return JSON.parse(text);
  }

  async subscribeChanges(sinceTimestamp: number): Promise<{
    modified_block_uids: string[];
    modified_page_uids: string[];
    new_page_uids: string[];
    deleted_page_uids: string[];
  }> {
    const text = await this.callTool("subscribe_changes", {
      since_timestamp: sinceTimestamp,
    });
    return JSON.parse(text);
  }

  // ─── Convenience Methods ────────────────────────────────────────

  async getPageTree(pageUid: string): Promise<BlockNode[]> {
    const entity = await this.pullEntity(
      `[{:block/children [:block/uid :block/string :block/order :edit/time {:block/refs [:node/title :block/uid]} {:block/children ...}]}]`,
      [":block/uid", pageUid]
    );

    const children = entity[":block/children"] as BlockNode[] | undefined;
    if (!children) return [];

    return sortByOrder(children);
  }

  async getBlockWithContext(blockUid: string): Promise<{
    block: BlockNode;
    ancestors: AncestorNode;
    siblings: BlockNode[];
  }> {
    // Get block + its subtree + parent chain in one pull
    const entity = await this.pullEntity(
      `[:block/uid :block/string :block/order
        {:block/children [:block/uid :block/string :block/order {:block/children ...}]}
        {:block/parents [:block/uid :block/string :node/title {:block/parents ...}]}]`,
      [":block/uid", blockUid]
    );

    const block: BlockNode = {
      uid: entity[":block/uid"] as string,
      string: entity[":block/string"] as string,
      order: entity[":block/order"] as number,
      children: entity[":block/children"] as BlockNode[] | undefined,
    };

    const ancestors = entity[":block/parents"] as AncestorNode;

    // Get siblings from immediate parent
    let siblings: BlockNode[] = [];
    const parentUid = ancestors?.uid;
    if (parentUid) {
      const parentEntity = await this.pullEntity(
        `[{:block/children [:block/uid :block/string :block/order]}]`,
        [":block/uid", parentUid]
      );
      const allChildren = parentEntity[":block/children"] as BlockNode[] | undefined;
      if (allChildren) {
        siblings = sortByOrder(allChildren).filter((c) => c.uid !== blockUid);
      }
    }

    return { block, ancestors, siblings };
  }

  async getAllPageTitles(): Promise<Array<{ uid: string; title: string }>> {
    const result = await this.executeDatalogQuery(`
      [:find ?uid ?title
       :where
       [?page :node/title ?title]
       [?page :block/uid ?uid]]
    `);

    return result.results.map(([uid, title]) => ({
      uid: uid as string,
      title: title as string,
    }));
  }
}

function sortByOrder(blocks: BlockNode[]): BlockNode[] {
  return [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
