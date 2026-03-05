# Roam Graph-RAG

A Graph-RAG (Retrieval-Augmented Generation) system for Roam Research knowledge graphs. Extracts the multi-layer graph structure from Roam via MCP, builds hierarchical community summaries, and exposes 7 search tools via its own MCP server.

## Architecture

```
Roam Research ──MCP──► Graph Extractor ──► SQLite Index ──► MCP Server
                           │                    │              │
                      5 Graph Layers      Community         7 Tools
                      (Datalog queries)   Detection         (global, local,
                                          (Louvain)          drift, temporal,
                                                             neighborhood,
                                                             attribute, reindex)
```

### Graph Layers (extracted via Datalog)

1. **Co-Reference Graph** — undirected edges between pages co-mentioned in the same block
2. **Direct Link Graph** — directed edges from source page to referenced page
3. **Block Reference Graph** — block-level `((uid))` reference edges
4. **Attribute Graph** — `Key:: Value` pairs extracted from blocks
5. **Temporal Graph** — page mentions on Daily Note Pages

### Community Detection

Uses [Louvain modularity](https://en.wikipedia.org/wiki/Louvain_method) at multiple resolutions to create a hierarchy of page clusters. Each community gets a summary (tree-derived for small clusters, LLM-generated for larger ones).

### Search Strategies

| Tool | Best For |
|------|----------|
| `global_search` | Overview/thematic questions across the full graph |
| `local_search` | Focused queries about specific topics with graph expansion |
| `drift_search` | Complex multi-faceted queries (progressive community→block refinement) |
| `temporal_search` | Time-based queries ("what was I working on last month?") |
| `explore_neighborhood` | Graph structure exploration around a page/block |
| `attribute_filter` | Structured queries on `Key:: Value` attributes |
| `reindex` | Full or incremental re-indexing |

### Telescoping Context

When a matching block is found, context is assembled by:
1. Walking the parent chain to the page root (ancestor path)
2. Including child blocks (subtree)
3. Including sibling blocks (adjacent context)
4. Attaching the community summary for thematic framing

## Setup

```bash
cd graph-rag
npm install
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ROAM_MCP_URL` | URL of the Roam MCP server | `http://localhost:3003/mcp` |
| `GRAPH_RAG_DB_PATH` | Path for the SQLite index | `./graph-rag-index.db` |
| `OPENAI_API_KEY` | OpenAI API key (for embeddings) | — |
| `ANTHROPIC_API_KEY` | Anthropic API key (for LLM summaries) | — |
| `OLLAMA_URL` | Ollama server URL (if using local embeddings) | `http://localhost:11434` |

### Run

```bash
# Start the MCP server
npx tsx src/index.ts

# Then trigger a full index via the reindex tool
```

The server starts on port 3004 by default and exposes an MCP endpoint at `/mcp`.

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roam-graph-rag": {
      "url": "http://localhost:3004/mcp"
    }
  }
}
```

## Development

```bash
# Type-check
npx tsc --noEmit

# Run directly
npx tsx src/index.ts
```
