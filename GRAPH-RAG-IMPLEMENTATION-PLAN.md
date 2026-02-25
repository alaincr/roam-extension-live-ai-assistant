# Graph-RAG for Roam Research: Implementation Plan

## 1. System Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                        LLM Client                                 │
│  (Claude, GPT, any MCP-compatible agent)                         │
│                                                                   │
│  Calls Graph-RAG MCP tools:                                      │
│    - global_search, local_search, drift_search                   │
│    - get_community_summary, explore_neighborhood                 │
│    - temporal_search, attribute_filter                            │
└──────────────────────────────┬────────────────────────────────────┘
                               │ MCP (tools, resources)
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│              GRAPH-RAG SERVER (this project)                      │
│              ─────────────────────────────                        │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │  Query       │  │  Index       │  │  Background Indexer     │ │
│  │  Engine      │  │  Store       │  │  (watches for changes)  │ │
│  │              │  │              │  │                         │ │
│  │  - Router    │  │  - Community │  │  - Change detector      │ │
│  │  - Local     │  │    graph     │  │  - Incremental reindex  │ │
│  │  - Global    │  │  - Summaries │  │  - Summary invalidation │ │
│  │  - DRIFT     │  │  - Embeddings│  │  - Embedding updates    │ │
│  │  - Temporal  │  │  - Metadata  │  │                         │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬────────────┘ │
│         │                 │                        │              │
│         └─────────────────┼────────────────────────┘              │
│                           │                                       │
└───────────────────────────┼───────────────────────────────────────┘
                            │ MCP (tools)
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│           ROAM MCP SERVER (separate project)                      │
│           ──────────────────────────────                          │
│                                                                   │
│  Exposes Roam graph data via MCP tools:                          │
│    - execute_datalog_query(query, params)                        │
│    - pull_entity(pattern, lookup)                                │
│    - get_all_page_titles()                                       │
│    - get_block_tree(uid)                                         │
│    - get_linked_references(page_title)                           │
│    - subscribe_changes(since_timestamp)                          │
│                                                                   │
│  Backed by: window.roamAlphaAPI.q() / .pull() / .data.pull()    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Key architectural principle**: The Graph-RAG server is a **pure computation layer** with no direct Roam dependency. It consumes graph data through the Roam MCP's tools and exposes intelligence through its own MCP interface. This makes it testable, portable, and cleanly separated.

---

## 2. Roam MCP Interface Requirements

The Graph-RAG server needs the following capabilities from the Roam MCP. These define the **contract** between the two systems.

### 2.1 Core Data Access Tools

**`execute_datalog_query`** -- The most important tool. Runs arbitrary Datalog against the Roam database.

```typescript
// Input
{
  query: string,       // Datalog query string
  params?: any[]       // Optional positional params for :in clause
}

// Output
{
  results: any[][],    // Array of result tuples
  count: number
}
```

This single tool, combined with Datomic's expressive query language, replaces what would otherwise be dozens of specialized endpoints. The Graph-RAG server constructs its own Datalog queries and sends them through this tool.

**`pull_entity`** -- Declarative entity retrieval using Datomic's pull syntax.

```typescript
// Input
{
  pattern: string,     // Pull pattern e.g. "[:block/uid :block/string {:block/children ...}]"
  lookup: [string, string]  // [attribute, value] e.g. [":block/uid", "abc123"]
}

// Output: entity map matching the pull pattern
```

**`subscribe_changes`** -- Returns blocks/pages modified since a given timestamp.

```typescript
// Input
{
  since_timestamp: number   // Unix ms timestamp
}

// Output
{
  modified_block_uids: string[],
  modified_page_uids: string[],
  new_page_uids: string[],
  deleted_page_uids: string[]
}
```

This leverages Datomic's `:edit/time` attribute. The Roam MCP implements this as:
```clojure
[:find ?uid
 :where
 [?b :block/uid ?uid]
 [?b :edit/time ?t]
 [(> ?t since_timestamp)]]
```

### 2.2 Why Raw Datalog Access is the Right Abstraction

Rather than asking the Roam MCP to implement graph-RAG-aware endpoints (like "get co-reference graph"), we keep the Roam MCP **thin** and push intelligence to the Graph-RAG server. Reasons:

1. **Flexibility**: The Graph-RAG server can evolve its queries without changing the MCP server.
2. **Datomic leverage**: Datalog is expressive enough to extract any graph structure in a single query. Wrapping it in higher-level tools would lose this power.
3. **Separation of concerns**: The Roam MCP is a data access layer; the Graph-RAG server is an intelligence layer.
4. **Efficiency**: Complex multi-join queries are faster when executed as a single Datalog expression inside Datomic than as multiple round-trips through higher-level tools.

---

## 3. Graph Extraction Pipeline (Datomic-Native)

All graph extraction is done via Datalog queries sent through the Roam MCP's `execute_datalog_query` tool. This is where Datomic's advantages are most directly exploited.

### 3.1 Page Co-Reference Graph Extraction

**Single Datalog query** to extract the entire co-reference graph:

```clojure
[:find ?title-a ?title-b (count ?b)
 :where
 ;; Find blocks that reference at least two pages
 [?b :block/refs ?page-a]
 [?b :block/refs ?page-b]
 ;; Get titles
 [?page-a :node/title ?title-a]
 [?page-b :node/title ?title-b]
 ;; Avoid self-loops and duplicate pairs (lexicographic ordering)
 [(< ?title-a ?title-b)]
 ;; Exclude Daily Note Pages from being nodes
 [(re-pattern "(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\d{2}") ?dnp]
 (not [(re-find ?dnp ?title-a)])
 (not [(re-find ?dnp ?title-b)])]
```

**What this gives us**: The complete weighted undirected page co-reference graph in a single database round-trip. Each result tuple `[page-a, page-b, count]` is an edge. The `count` is the number of blocks where both pages are co-referenced, providing edge weights.

**Why this is a Datomic advantage**: In a document-based system, you'd need to (1) chunk documents, (2) run LLM entity extraction on each chunk, (3) deduplicate entities, (4) build edges from co-occurrence. Here, a single Datalog query replaces all four steps.

### 3.2 Directed Link Graph Extraction

```clojure
[:find ?source-title ?target-title (count ?b)
 :where
 [?b :block/refs ?target-page]
 [?b :block/page ?source-page]
 [?source-page :node/title ?source-title]
 [?target-page :node/title ?target-title]
 [(not= ?source-page ?target-page)]
 ;; Exclude DNPs as sources
 [(re-pattern "(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\d{2}") ?dnp]
 (not [(re-find ?dnp ?source-title)])]
```

This produces directed edges: `source-page --[weight]--> target-page`, where weight is the number of blocks on the source page that reference the target page.

### 3.3 Block Reference Graph Extraction

```clojure
[:find ?source-uid ?target-uid ?source-page-title ?target-page-title
 :where
 [?source :block/string ?content]
 ;; Match ((block-ref)) pattern in content
 [(re-pattern "\\(\\(([a-zA-Z0-9_-]{9})\\)\\)") ?ref-pattern]
 [(re-find ?ref-pattern ?content)]
 [?source :block/uid ?source-uid]
 [?source :block/page ?source-page]
 [?source-page :node/title ?source-page-title]
 ;; Resolve target block
 [?target :block/uid ?target-uid]
 [?target :block/page ?target-page]
 [?target-page :node/title ?target-page-title]]
```

Alternatively, if Roam's `:block/refs` includes block references (not just page references), a simpler approach:

```clojure
[:find ?source-uid ?target-uid
 :where
 [?source :block/refs ?target]
 [?source :block/uid ?source-uid]
 [?target :block/uid ?target-uid]
 ;; Only block-to-block refs (target has no title = it's a block, not a page)
 (not [?target :node/title _])]
```

### 3.4 Attribute Graph Extraction

Roam attributes follow the pattern `AttributeName:: value` at the start of a block.

```clojure
[:find ?page-title ?attr-name ?attr-value ?block-uid
 :where
 [?b :block/uid ?block-uid]
 [?b :block/string ?content]
 [?b :block/page ?page]
 [?page :node/title ?page-title]
 ;; Match "AttributeName:: value" pattern
 [(re-pattern "^([^:]+)::\\s*(.+)$") ?attr-pattern]
 [(re-find ?attr-pattern ?content) ?match]
 ;; Extract attribute name and value
 [(nth ?match 1) ?attr-name]
 [(nth ?match 2) ?attr-value]]
```

**Note**: Datomic's `nth` function allows extracting regex capture groups directly in the query, avoiding post-processing.

### 3.5 Temporal Graph Extraction

```clojure
[:find ?page-title ?dnp-title ?edit-time
 :where
 ;; Find blocks on DNPs that reference non-DNP pages
 [?b :block/page ?dnp]
 [?dnp :node/title ?dnp-title]
 [?dnp :block/uid ?dnp-uid]
 ;; DNP filter
 [(re-pattern "(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\d{2}") ?dnp-pattern]
 [(re-find ?dnp-pattern ?dnp-uid)]
 ;; Get referenced pages
 [?b :block/refs ?page]
 [?page :node/title ?page-title]
 ;; Exclude self-refs to DNPs
 (not [(re-find ?dnp-pattern ?page-title)])
 ;; Get timestamp
 [?b :edit/time ?edit-time]]
```

### 3.6 Page Metadata Extraction

A single pull-based query to get all page metadata needed for community summarization:

```clojure
[:find ?uid ?title
       (count ?child)    ;; number of top-level blocks
       (count ?ref)      ;; number of incoming references
 :where
 [?page :node/title ?title]
 [?page :block/uid ?uid]
 [?page :block/children ?child]
 [?ref :block/refs ?page]
 ;; Exclude DNPs
 [(re-pattern "(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\d{2}") ?dnp]
 (not [(re-find ?dnp ?uid)])]
```

### 3.7 Hierarchy Extraction via Recursive Pull

For any page, get its entire block tree in one call:

```
pull_entity(
  "[:node/title :block/uid {:block/children [:block/uid :block/string :block/order :edit/time {:block/refs [:node/title :block/uid]} {:block/children ...}]}]",
  [":block/uid", pageUid]
)
```

The `{:block/children ...}` recursive pull pattern is Datomic-specific and retrieves the **entire tree** in a single database operation. No graph traversal code needed -- Datomic does it natively.

---

## 4. Community Detection Module

### 4.1 Algorithm Selection: Leiden with Hierarchical Resolution

The Leiden algorithm is chosen for the same reasons as Microsoft GraphRAG, but with Roam-specific tuning:

**Implementation**: Use `graphology` (JavaScript graph library) + `graphology-communities-louvain` (which implements a Louvain variant; for true Leiden, use a WASM-compiled `leidenalg` or `igraph` binding, or implement the refinement phase on top of Louvain).

```typescript
// Pseudocode for the community detection pipeline
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

interface CommunityHierarchy {
  level: number;
  resolution: number;
  communities: Map<string, string[]>;  // communityId -> page titles
  modularity: number;
}

function buildCommunityHierarchy(
  coRefEdges: Array<{source: string, target: string, weight: number}>
): CommunityHierarchy[] {
  const graph = new Graph({type: 'undirected'});

  // Add nodes and edges from co-reference query results
  for (const edge of coRefEdges) {
    if (!graph.hasNode(edge.source)) graph.addNode(edge.source);
    if (!graph.hasNode(edge.target)) graph.addNode(edge.target);
    graph.addEdge(edge.source, edge.target, {weight: edge.weight});
  }

  // Run at multiple resolution levels to get hierarchy
  const resolutions = [0.25, 0.5, 1.0, 2.0, 4.0];
  const hierarchy: CommunityHierarchy[] = [];

  for (const resolution of resolutions) {
    const communities = louvain(graph, {
      resolution,
      getEdgeWeight: 'weight'
    });

    // Group pages by community assignment
    const communityMap = new Map<string, string[]>();
    for (const [page, communityId] of Object.entries(communities)) {
      const id = String(communityId);
      if (!communityMap.has(id)) communityMap.set(id, []);
      communityMap.get(id)!.push(page);
    }

    // Filter out singleton communities (noise)
    const filtered = new Map(
      [...communityMap.entries()].filter(([_, pages]) => pages.length >= 2)
    );

    hierarchy.push({
      level: hierarchy.length,
      resolution,
      communities: filtered,
      modularity: louvain.assign(graph, {resolution, getEdgeWeight: 'weight'})
    });
  }

  return selectMeaningfulLevels(hierarchy);
}
```

### 4.2 Resolution Level Selection

Not all resolution levels produce meaningful communities. Auto-select levels where:
- The number of communities changes significantly (structural transition)
- Communities are neither too large (>30% of graph) nor too small (<3 pages)
- Modularity is above a minimum threshold (>0.3)

Typically this produces 2-4 useful levels from the 5 resolution candidates.

### 4.3 Community Metadata Enrichment

After detection, enrich each community with metadata from additional Datomic queries:

```typescript
interface Community {
  id: string;
  level: number;
  pages: string[];                    // Page titles
  pageUids: string[];                // Page UIDs

  // From Datomic queries
  totalBlocks: number;               // Sum of blocks across member pages
  totalIncomingRefs: number;         // Sum of backlinks to member pages
  internalEdgeWeight: number;        // Co-references within community
  externalEdges: Map<string, number>; // communityId -> cross-community edge weight

  // From attribute extraction
  commonAttributes: Map<string, string[]>;  // attr -> most common values

  // From temporal graph
  activityRange: {earliest: Date, latest: Date};
  activityPeak: Date;

  // Generated
  summary?: string;                  // LLM-generated or tree-derived
  embedding?: number[];              // Community summary embedding

  // Staleness tracking
  lastIndexed: number;               // Timestamp
  isDirty: boolean;                  // Needs re-summarization
}
```

**Enrichment query** (single Datalog call to get block counts and ref counts for all pages in a community):

```clojure
[:find ?title (count ?child) (count ?ref)
 :in $ [?titles ...]
 :where
 [?page :node/title ?titles]
 [?page :node/title ?title]
 [?page :block/children ?child]
 [?ref :block/refs ?page]]
```

The `:in $ [?titles ...]` parameterized input allows passing the entire list of community member page titles in one query.

---

## 5. Community Summarization

### 5.1 Tree-Derived Summaries (No LLM Required)

For each page in a community, extract L0 (top-level) blocks using pull:

```
pull_entity(
  "[{:block/children [:block/string :block/order]}]",
  [":block/uid", pageUid]
)
```

Sort children by `:block/order`, take the `:block/string` of each. These L0 blocks are the user's own outline of the page.

**Community pre-summary** (zero LLM cost):
```
Community: [Machine Learning Fundamentals]
Pages (12): Neural Networks, Backpropagation, Gradient Descent, ...

Neural Networks:
  - A computational model inspired by biological neural networks
  - Key components: layers, weights, activation functions
  - Types: CNN, RNN, Transformer

Backpropagation:
  - Algorithm for computing gradients in neural networks
  - Chain rule applied layer by layer
  ...
```

For small communities (<10 pages), this pre-summary may be sufficient as-is. For larger ones, pass it to an LLM for synthesis.

### 5.2 LLM Summarization (When Needed)

```typescript
interface SummarizationInput {
  communityId: string;
  level: number;
  pageCount: number;
  pageTitles: string[];
  treeDerivedContent: string;      // L0 blocks from all pages
  commonAttributes: Map<string, string[]>;
  activityRange: {earliest: Date, latest: Date};
  neighborCommunities: Array<{id: string, summary: string}>;
  childCommunities?: Array<{id: string, summary: string}>;  // From lower levels
}
```

**Summarization prompt**:

```
You are analyzing a cluster of densely interconnected pages from a personal
knowledge graph. These pages were grouped together because they are frequently
referenced together in the same contexts.

## Pages in this cluster (${input.pageCount})
${input.pageTitles.join(', ')}

## Content overview (user's own outline structure)
${input.treeDerivedContent}

## Common structured attributes
${formatAttributes(input.commonAttributes)}

## Activity period
${input.activityRange.earliest} to ${input.activityRange.latest}

## Neighboring clusters
${input.neighborCommunities.map(n => `- ${n.summary}`).join('\n')}

${input.childCommunities ? `## Sub-clusters within this group\n${input.childCommunities.map(c => `- ${c.summary}`).join('\n')}` : ''}

Write a summary (2-4 paragraphs) covering:
1. The central theme or domain this cluster represents
2. The key concepts and how they relate to each other
3. Any notable patterns, common attributes, or temporal trends
4. How this cluster connects to neighboring clusters
```

### 5.3 Hierarchical Bottom-Up Summarization

Summarize in order: leaf communities first, then intermediate, then root. Higher-level summaries reference their children's summaries, creating a coherent multi-resolution view.

```
Level 2 (leaf):    [Linear Algebra] [Calculus] [Probability]  [CNNs] [RNNs] [Transformers]
                        ↓                ↓                        ↓        ↓
Level 1 (mid):     [Mathematics Foundations]               [Neural Network Architectures]
                              ↓                                    ↓
Level 0 (root):          [Machine Learning Research]
```

---

## 6. Embedding and Index Store

### 6.1 Multi-Granularity Embeddings

Generate embeddings at three levels, each constructed differently:

**Page-level embedding**:
- Input: `page_title + "\n" + L0_blocks_concatenated`
- Purpose: Coarse topic matching for candidate page selection

**Branch-level embedding**:
- Input: `page_title > L0_block_text + "\n" + subtree_content_up_to_512_tokens`
- Purpose: Section-level matching within a page
- One embedding per L0 block (top-level branch)

**Block-level embedding**:
- Input: `ancestor_path + "\n" + block_content`
- Where `ancestor_path` = `page_title > parent_block > grandparent_block`
- Purpose: Precise content retrieval
- Only for blocks with substantive content (>20 chars, not pure structural)

### 6.2 Ancestor Path Construction via Datomic

The ancestor path for a block is retrieved in one pull call:

```
pull_entity(
  "[{:block/parents [:block/uid :block/string {:block/parents ...}]}]",
  [":block/uid", blockUid]
)
```

The recursive `{:block/parents ...}` pull walks up the tree to the page root in a single database operation.

### 6.3 Index Storage

Use a local persistent store. Options:

**Option A: SQLite + sqlite-vss** (recommended for standalone server)
- SQLite for structured data (communities, metadata, summaries)
- sqlite-vss extension for vector similarity search
- Single file, portable, no external dependencies

**Option B: LanceDB** (embedded columnar vector DB)
- Native vector search with IVF-PQ indexing
- Good for larger graphs (>50k blocks)

**Schema** (SQLite):

```sql
-- Pages
CREATE TABLE pages (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  block_count INTEGER,
  ref_count INTEGER,
  last_modified INTEGER,
  last_indexed INTEGER,
  embedding BLOB           -- page-level embedding
);

-- Communities
CREATE TABLE communities (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  resolution REAL,
  page_count INTEGER,
  summary TEXT,
  summary_embedding BLOB,
  tree_derived_summary TEXT,  -- no-LLM summary
  last_indexed INTEGER,
  is_dirty BOOLEAN DEFAULT 0
);

-- Community membership
CREATE TABLE community_pages (
  community_id TEXT REFERENCES communities(id),
  page_uid TEXT REFERENCES pages(uid),
  PRIMARY KEY (community_id, page_uid)
);

-- Community edges (inter-community connections)
CREATE TABLE community_edges (
  source_id TEXT REFERENCES communities(id),
  target_id TEXT REFERENCES communities(id),
  weight REAL,
  PRIMARY KEY (source_id, target_id)
);

-- Branch embeddings (one per L0 block)
CREATE TABLE branches (
  uid TEXT PRIMARY KEY,       -- L0 block UID
  page_uid TEXT REFERENCES pages(uid),
  content_preview TEXT,       -- first 200 chars
  token_count INTEGER,
  embedding BLOB
);

-- Block embeddings
CREATE TABLE blocks (
  uid TEXT PRIMARY KEY,
  page_uid TEXT REFERENCES pages(uid),
  branch_uid TEXT REFERENCES branches(uid),
  ancestor_path TEXT,
  content TEXT,
  depth INTEGER,
  embedding BLOB
);

-- Co-reference graph edges (for re-running community detection)
CREATE TABLE coref_edges (
  source_title TEXT,
  target_title TEXT,
  weight INTEGER,
  PRIMARY KEY (source_title, target_title)
);

-- Attribute index
CREATE TABLE attributes (
  block_uid TEXT,
  page_uid TEXT,
  attr_name TEXT,
  attr_value TEXT
);
CREATE INDEX idx_attr_name ON attributes(attr_name);
CREATE INDEX idx_attr_value ON attributes(attr_value);

-- Temporal index
CREATE TABLE temporal_mentions (
  page_title TEXT,
  dnp_date TEXT,             -- YYYY-MM-DD normalized
  mention_count INTEGER,
  PRIMARY KEY (page_title, dnp_date)
);
```

---

## 7. Query Pipeline

### 7.1 MCP Tools Exposed by the Graph-RAG Server

The Graph-RAG server itself is an MCP server, exposing these tools to LLM clients:

#### **`global_search`**
For broad, thematic, or summarization queries ("What are the main themes in my notes?", "Give me an overview of my research").

```typescript
{
  name: "global_search",
  input: {
    query: string,
    max_community_level?: number,  // 0 = root only, higher = more detail
    max_tokens?: number            // budget for response context
  },
  output: {
    community_summaries: Array<{
      community_id: string,
      level: number,
      summary: string,
      page_count: number,
      relevance_score: number
    }>,
    total_communities_scanned: number
  }
}
```

**Implementation**: Map-reduce over community summaries at the requested level. Embed the query, compute cosine similarity against community summary embeddings, return top-K communities sorted by relevance.

#### **`local_search`**
For specific, focused queries about particular topics or concepts.

```typescript
{
  name: "local_search",
  input: {
    query: string,
    seed_pages?: string[],          // Optional: start from these pages
    max_hops?: number,              // Graph traversal depth (default: 2)
    include_community_context?: boolean,  // Add community summary
    max_results?: number
  },
  output: {
    results: Array<{
      block_uid: string,
      content: string,
      page_title: string,
      ancestor_path: string,
      relevance_score: number,
      siblings?: string[],          // Adjacent blocks for context
      graph_distance?: number       // Hops from seed
    }>,
    community_context?: string,     // Summary of the relevant community
    pages_traversed: string[]
  }
}
```

**Implementation**:
1. If `seed_pages` provided, start there. Otherwise, embed query and find top-K matching pages via page-level embeddings.
2. Retrieve branch-level embeddings for candidate pages, re-rank.
3. Retrieve block-level embeddings for top branches, re-rank.
4. Expand via graph neighbors: follow `:block/refs` links from matched blocks (1-2 hops via Datomic query).
5. Build telescoping context for top results.
6. Optionally prepend community summary for orientation.

#### **`drift_search`**
DRIFT (Dynamic Reasoning and Inference with Flexible Traversal) -- starts broad and progressively focuses. Best for complex, multi-faceted queries.

```typescript
{
  name: "drift_search",
  input: {
    query: string,
    max_rounds?: number    // Default: 3
  },
  output: {
    rounds: Array<{
      round: number,
      strategy: string,           // What this round looked for
      communities_explored: string[],
      key_findings: string[],
      follow_up_queries: string[]
    }>,
    final_context: string,        // Assembled context for LLM
    pages_covered: string[],
    blocks_retrieved: number
  }
}
```

**Implementation**:
1. **Round 1**: Global search to identify relevant communities.
2. **Round 2**: Local search within identified communities, using community summaries to generate focused sub-queries.
3. **Round 3**: Block-level retrieval for the most relevant branches found in round 2, with graph expansion.
4. Each round uses the previous round's findings to refine the search.

#### **`explore_neighborhood`**
Navigate the graph structure from a starting point.

```typescript
{
  name: "explore_neighborhood",
  input: {
    page_title?: string,
    block_uid?: string,
    relationship_types: ("co_reference" | "direct_link" | "block_ref" | "attribute" | "temporal")[],
    max_hops: number,
    include_content?: boolean
  },
  output: {
    nodes: Array<{title: string, uid: string, type: "page" | "block"}>,
    edges: Array<{source: string, target: string, type: string, weight?: number}>,
    subgraph_summary?: string
  }
}
```

**Implementation**: Construct Datomic queries based on the requested relationship types, traverse N hops, return the subgraph.

#### **`temporal_search`**
Time-scoped queries leveraging the temporal graph.

```typescript
{
  name: "temporal_search",
  input: {
    query?: string,
    page_titles?: string[],
    date_range: {start: string, end: string},  // ISO dates
    granularity?: "day" | "week" | "month"
  },
  output: {
    timeline: Array<{
      date: string,
      pages_mentioned: string[],
      key_blocks: Array<{uid: string, content: string, page: string}>
    }>,
    activity_summary: string
  }
}
```

**Implementation**: Query the temporal index, filter by date range, optionally filter by page titles or semantic relevance to query.

#### **`attribute_filter`**
Structured attribute-based retrieval.

```typescript
{
  name: "attribute_filter",
  input: {
    filters: Array<{
      attribute: string,
      operator: "equals" | "contains" | "regex",
      value: string
    }>,
    combine: "AND" | "OR",
    include_content?: boolean
  },
  output: {
    pages: Array<{
      title: string,
      uid: string,
      matched_attributes: Record<string, string>,
      content_preview?: string
    }>
  }
}
```

**Implementation**: Translates to a Datomic query against the attribute index:

```clojure
[:find ?page-title ?block-uid ?attr-value
 :where
 [?b :block/string ?content]
 [(re-pattern "^Status::\\s*(.+)$") ?pat]
 [(re-find ?pat ?content) ?match]
 [(nth ?match 1) ?attr-value]
 [(re-pattern "(?i)done|completed") ?val-pat]
 [(re-find ?val-pat ?attr-value)]
 [?b :block/page ?page]
 [?page :node/title ?page-title]
 [?b :block/uid ?block-uid]]
```

### 7.2 Query Router Logic

```typescript
function classifyQuery(query: string): "global" | "local" | "drift" | "temporal" | "attribute" {
  // Heuristics + optional LLM classification

  // Temporal signals
  if (/when|timeline|history|last (week|month|year)|in (january|february|...)/i.test(query))
    return "temporal";

  // Attribute signals
  if (/status|priority|type|author|tagged|where .+ is/i.test(query))
    return "attribute";

  // Global signals (broad, summarization, overview)
  if (/overview|main themes|summarize|what do I know about everything|across all/i.test(query))
    return "global";

  // Complex multi-faceted queries
  if (query.split(/and|but|also|however|additionally/i).length > 2)
    return "drift";

  // Default: local search
  return "local";
}
```

---

## 8. Telescoping Context Builder

The most Roam-specific component. Constructs LLM context that preserves tree structure.

### 8.1 Algorithm

```typescript
interface TelescopingContext {
  matchedBlock: {uid: string, content: string, depth: number};
  children: Array<{content: string, depth: number}>;          // Full detail
  siblings: Array<{content: string, depth: number}>;           // First line only
  parent: {content: string, depth: number} | null;             // First line
  ancestorPath: string;                                        // Title > L0 > L1 > ...
  communityContext: string | null;                             // Brief community summary
}

async function buildTelescopingContext(
  blockUid: string,
  roamMcp: RoamMCPClient,
  tokenBudget: number
): Promise<TelescopingContext> {

  // 1. Get the matched block with its full subtree + parent chain
  //    Single Datomic pull call gets everything:
  const entity = await roamMcp.pullEntity(
    `[:block/uid :block/string :block/order
      {:block/children [:block/uid :block/string :block/order {:block/children ...}]}
      {:block/parents [:block/uid :block/string :node/title {:block/parents ...}]}]`,
    [":block/uid", blockUid]
  );

  // 2. Build ancestor path from parents chain
  const ancestors = flattenParentChain(entity[":block/parents"]);
  const ancestorPath = ancestors.map(a => a.title || a.string).join(" > ");

  // 3. Get siblings (parent's other children)
  const parentUid = ancestors[0]?.uid;
  if (parentUid) {
    const parentEntity = await roamMcp.pullEntity(
      `[{:block/children [:block/uid :block/string :block/order]}]`,
      [":block/uid", parentUid]
    );
    // siblings = parent's children minus the matched block
  }

  // 4. Allocate token budget:
  //    - 40% to matched block + children
  //    - 25% to siblings
  //    - 15% to ancestor path + parent
  //    - 20% to community context

  // 5. Truncate each section to its budget
  return context;
}
```

### 8.2 Context Formatting

```markdown
## Community Context
This block is part of the [Machine Learning Research] cluster, which covers
neural network architectures, training methods, and applications to NLP.

## Location
Machine Learning > Neural Networks > Training Methods > Backpropagation

## Parent Section
- **Training Methods** (3 sub-topics)

## Matched Content
- **Backpropagation**
  - Algorithm for computing gradients in neural networks
  - Uses the chain rule to propagate error backwards
    - Starting from the loss function at the output layer
    - Computing partial derivatives layer by layer
  - Computational complexity: O(n) per training example
    - Where n is the number of weights

## Sibling Sections
- Gradient Descent (optimization algorithm for updating weights...)
- Learning Rate Scheduling (strategies for adjusting learning rate...)
- Batch Normalization (technique to stabilize training...)
```

---

## 9. Incremental Update Strategy

### 9.1 Change Detection

Run periodically (or on-demand before a query):

```typescript
async function detectChanges(roamMcp: RoamMCPClient, lastIndexTimestamp: number) {
  // Single Datomic query: blocks modified since last index
  const modifiedBlocks = await roamMcp.executeDatalogQuery(`
    [:find ?block-uid ?page-uid ?page-title ?edit-time
     :where
     [?b :block/uid ?block-uid]
     [?b :edit/time ?edit-time]
     [(> ?edit-time ${lastIndexTimestamp})]
     [?b :block/page ?page]
     [?page :block/uid ?page-uid]
     [?page :node/title ?page-title]]
  `);

  // Determine affected pages
  const affectedPages = new Set(modifiedBlocks.map(r => r[2])); // page titles

  // Determine affected communities
  const affectedCommunities = new Set<string>();
  for (const pageTitle of affectedPages) {
    const communities = index.getCommunitiesForPage(pageTitle);
    communities.forEach(c => affectedCommunities.add(c));
  }

  return {modifiedBlocks, affectedPages, affectedCommunities};
}
```

### 9.2 Incremental Reindex Pipeline

```typescript
async function incrementalReindex(changes: ChangeSet) {
  // 1. Re-extract co-reference edges for affected pages only
  //    Datomic query scoped to modified pages:
  const newEdges = await extractCoRefEdgesForPages(changes.affectedPages);

  // 2. Update co-reference graph (add/remove/update edges)
  updateCoRefGraph(newEdges);

  // 3. Re-run community detection ONLY if edge changes are significant
  //    (>10% of edges in any affected community changed)
  if (significantEdgeChanges(changes.affectedCommunities)) {
    rerunCommunityDetection();  // Full re-run; community detection is fast
  }

  // 4. Mark affected community summaries as dirty
  for (const communityId of changes.affectedCommunities) {
    index.markCommunityDirty(communityId);
  }

  // 5. Re-embed modified blocks and their branches
  for (const [blockUid, pageUid] of changes.modifiedBlocks) {
    await reembedBlock(blockUid);
    await reembedBranch(getBranchRoot(blockUid));
  }

  // 6. Re-embed affected pages
  for (const pageTitle of changes.affectedPages) {
    await reembedPage(pageTitle);
  }

  // 7. Regenerate dirty community summaries (lazy: on next query)
  //    OR eager: do it now for communities that are frequently queried
}
```

### 9.3 Leveraging Datomic Immutability

Datomic's append-only nature means `:edit/time` is reliable for change tracking. Combined with the parameterized `[(> ?edit-time timestamp)]` filter, the entire change detection is a single efficient query. No external change-tracking infrastructure (CDC, event streams) is needed.

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)
**Goal**: Core infrastructure, basic retrieval working.

```
roam-graph-rag/
├── src/
│   ├── mcp-server/
│   │   ├── server.ts              # MCP server setup (streamable HTTP)
│   │   ├── tools/                 # Tool definitions & handlers
│   │   │   ├── global-search.ts
│   │   │   ├── local-search.ts
│   │   │   └── explore-neighborhood.ts
│   │   └── resources/             # MCP resources (index stats, etc.)
│   │
│   ├── roam-client/
│   │   └── roam-mcp-client.ts     # Client for calling Roam MCP tools
│   │
│   ├── graph/
│   │   ├── extractor.ts           # Datalog query builders for graph extraction
│   │   ├── types.ts               # Graph data types
│   │   └── coref-graph.ts         # Co-reference graph construction
│   │
│   ├── index/
│   │   ├── store.ts               # SQLite index management
│   │   ├── schema.sql             # Index schema
│   │   └── embeddings.ts          # Embedding generation & storage
│   │
│   └── retrieval/
│       ├── router.ts              # Query classification
│       ├── local.ts               # Local search implementation
│       ├── global.ts              # Global search implementation
│       └── context-builder.ts     # Telescoping context assembly
│
├── package.json
├── tsconfig.json
└── README.md
```

**Tasks**:
- [ ] Project scaffolding (TypeScript, MCP SDK, SQLite)
- [ ] Roam MCP client wrapper (calling tools via MCP protocol)
- [ ] Graph extraction queries (co-reference, direct links)
- [ ] SQLite index schema and basic CRUD
- [ ] Page-level embedding generation
- [ ] Basic local search (embed query → find pages → return L0 blocks)
- [ ] MCP server exposing `local_search` tool

### Phase 2: Community Detection (Weeks 3-4)
**Goal**: Full community hierarchy with summaries.

**Tasks**:
- [ ] Integrate `graphology` for in-memory graph operations
- [ ] Community detection at multiple resolution levels
- [ ] Level selection algorithm
- [ ] Tree-derived summaries (L0 blocks, zero LLM cost)
- [ ] LLM summarization for large communities
- [ ] Hierarchical bottom-up summarization
- [ ] Community summary embeddings
- [ ] MCP server exposing `global_search` and `get_community_summary`

### Phase 3: Tree-Aware Retrieval (Weeks 5-6)
**Goal**: Hierarchy-aware chunking, multi-level embeddings, telescoping context.

**Tasks**:
- [ ] Branch-level embedding generation
- [ ] Block-level embedding with ancestor paths
- [ ] Retrieval cascade (page → branch → block)
- [ ] Telescoping context builder
- [ ] Sibling-aware context expansion
- [ ] Subtree chunking with ancestor path prefixes
- [ ] Graph neighbor expansion (follow refs from matched blocks)

### Phase 4: Advanced Features (Weeks 7-8)
**Goal**: DRIFT search, temporal queries, attribute filtering, incremental updates.

**Tasks**:
- [ ] DRIFT search (multi-round progressive refinement)
- [ ] Temporal graph extraction and index
- [ ] `temporal_search` tool
- [ ] Attribute extraction and index
- [ ] `attribute_filter` tool
- [ ] `explore_neighborhood` tool
- [ ] Incremental change detection
- [ ] Incremental reindex pipeline
- [ ] Community staleness tracking and lazy re-summarization

### Phase 5: Optimization & Polish (Weeks 9-10)
**Goal**: Performance, robustness, developer experience.

**Tasks**:
- [ ] Query performance benchmarking and optimization
- [ ] Embedding caching and batch generation
- [ ] Index compression for large graphs
- [ ] Error handling and graceful degradation
- [ ] MCP resources for index statistics and health
- [ ] Configuration (embedding model, LLM for summaries, resolution params)
- [ ] Integration tests with a sample Roam graph
- [ ] Documentation

---

## 11. Datomic Advantage Summary

| Graph-RAG Operation | Without Datomic | With Datomic |
|---|---|---|
| Entity extraction | LLM-based, ~$5-50 per 1M tokens | **Free**: pages and blocks are entities |
| Relationship extraction | LLM-based, noisy | **Free**: `[:block/refs]` is the relationship |
| Co-reference graph | Parse docs, build co-occurrence matrix | **Single Datalog query** with aggregation |
| Hierarchy traversal | Recursive function calls, multiple DB hits | **Recursive pull** `{:block/children ...}` in one call |
| Ancestor path | Walk up parent pointers iteratively | **Recursive pull** `{:block/parents ...}` in one call |
| Change detection | External CDC, event streams, diffing | **Single query** on `:edit/time` |
| Batch filtering | Multiple queries or in-memory joins | **`contains?` with sets** in Datalog |
| Graph neighbor expansion | Multiple sequential queries | **Rule-based transitive closure** in one query |
| Attribute extraction | NLP/regex over flat text | **Regex in Datalog** with capture group extraction |
| Temporal scoping | External timestamp index | **Native `:edit/time` / `:create/time`** predicates |

The key insight: Datomic treats the Roam graph as a **queryable graph database**, not a document store. Every operation that Graph-RAG normally requires multiple pipeline stages for can be expressed as a single declarative Datalog query. The Graph-RAG server essentially becomes a **query planning and context assembly layer** on top of Datomic's native graph capabilities.
