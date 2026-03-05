export interface GraphRAGConfig {
  roamMcpUrl: string;
  dbPath: string;

  // Embedding
  embeddingProvider: "openai" | "ollama";
  embeddingModel: string;
  embeddingDimensions: number;
  openaiApiKey?: string;
  ollamaUrl?: string;

  // LLM (for summarization and DRIFT)
  llmProvider: "anthropic" | "openai";
  llmModel: string;
  anthropicApiKey?: string;
  openaiLlmApiKey?: string;

  // Community detection
  resolutions: number[];
  minCommunitySize: number;
  minModularity: number;
  maxCommunityRatio: number;

  // Embedding generation
  maxBlockEmbeddingChars: number;
  minBlockContentLength: number;
  maxBranchTokens: number;
  embeddingBatchSize: number;

  // Retrieval
  defaultLocalResults: number;
  defaultGlobalResults: number;
  driftMaxRounds: number;
  telescopingTokenBudget: number;

  // Indexing
  summarizationThreshold: number; // communities with >= this many pages get LLM summaries

  // MCP server
  mcpServerPort: number;
}

const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env[key] : undefined;

export function loadConfig(overrides: Partial<GraphRAGConfig> = {}): GraphRAGConfig {
  return {
    roamMcpUrl: overrides.roamMcpUrl ?? env("ROAM_MCP_URL") ?? "http://localhost:3003/mcp",
    dbPath: overrides.dbPath ?? env("GRAPH_RAG_DB_PATH") ?? "./graph-rag-index.db",

    embeddingProvider: overrides.embeddingProvider ?? "openai",
    embeddingModel: overrides.embeddingModel ?? "text-embedding-3-small",
    embeddingDimensions: overrides.embeddingDimensions ?? 1536,
    openaiApiKey: overrides.openaiApiKey ?? env("OPENAI_API_KEY"),
    ollamaUrl: overrides.ollamaUrl ?? env("OLLAMA_URL") ?? "http://localhost:11434",

    llmProvider: overrides.llmProvider ?? "anthropic",
    llmModel: overrides.llmModel ?? "claude-sonnet-4-20250514",
    anthropicApiKey: overrides.anthropicApiKey ?? env("ANTHROPIC_API_KEY"),
    openaiLlmApiKey: overrides.openaiLlmApiKey ?? env("OPENAI_API_KEY"),

    resolutions: overrides.resolutions ?? [0.25, 0.5, 1.0, 2.0, 4.0],
    minCommunitySize: overrides.minCommunitySize ?? 2,
    minModularity: overrides.minModularity ?? 0.3,
    maxCommunityRatio: overrides.maxCommunityRatio ?? 0.3,

    maxBlockEmbeddingChars: overrides.maxBlockEmbeddingChars ?? 2000,
    minBlockContentLength: overrides.minBlockContentLength ?? 20,
    maxBranchTokens: overrides.maxBranchTokens ?? 512,
    embeddingBatchSize: overrides.embeddingBatchSize ?? 100,

    defaultLocalResults: overrides.defaultLocalResults ?? 20,
    defaultGlobalResults: overrides.defaultGlobalResults ?? 10,
    driftMaxRounds: overrides.driftMaxRounds ?? 3,
    telescopingTokenBudget: overrides.telescopingTokenBudget ?? 2000,

    summarizationThreshold: overrides.summarizationThreshold ?? 10,

    mcpServerPort: overrides.mcpServerPort ?? 3004,
  };
}
