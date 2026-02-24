# Graph-RAG Design for Roam Research

## Executive Summary

This document designs a Graph-RAG system purpose-built for Roam Research graphs. Unlike standard Graph-RAG implementations (e.g., Microsoft GraphRAG) that must construct a knowledge graph from scratch via LLM-based entity extraction, a Roam graph **already is** a richly structured knowledge graph. The design exploits three structural advantages unique to Roam: its native relationship types, its emergent community structure from organic linking, and its tree-shaped block hierarchy.

---

## Part 1: Leveraging Roam's Native Relationship Types

### 1.1 The Roam Graph as a Pre-Existing Knowledge Graph

Standard Graph-RAG pipelines spend the bulk of their indexing budget (often 75%+ of total LLM token cost) on entity extraction and relationship construction. Roam eliminates this entirely. A Roam graph is already a multigraph with multiple distinct edge types:

| Roam Feature | Graph Analog | Relationship Semantics |
|---|---|---|
| `[[Page Links]]` | Directed edges between page-nodes | Explicit topical association |
| `((Block References))` | Directed edges between block-nodes | Precise content reuse/citation |
| `#tags` | Node-to-tag-node edges | Categorical classification |
| `Attributes::` | Typed property edges | Structured key-value metadata |
| Parent-child nesting | Tree edges (directed, ordered) | Compositional/hierarchical containment |
| Page-block membership | Bipartite edges | Content ownership |
| `[[Page]]` in Daily Note | Temporal edges | Timestamped mention |

Each of these carries distinct semantics that standard entity extraction would struggle to recover. A `[[Page Link]]` inside a block is an **intentional** conceptual association made by the user. A `((block ref))` is a **precise citation** of a specific idea. An `Attribute::` is a **typed property**. These are far richer than the generic `(entity, relationship_description, entity)` triples produced by LLM extraction.

### 1.2 Multi-Layer Graph Construction

Rather than building a single flat entity-relationship graph, model the Roam graph as a **multi-layer graph** where each layer captures a different relationship type:

**Layer 1 -- Page Co-Reference Graph (undirected, weighted)**
- Nodes: Pages (including tag pages)
- Edges: Two pages are connected when they are both referenced in the same block (or within the same branch of a block tree)
- Weight: Number of co-reference occurrences
- *Purpose*: This is the primary graph for community detection. Co-referenced pages are topically related by the user's own linking behavior.

**Layer 2 -- Direct Link Graph (directed)**
- Nodes: Pages
- Edges: Page A links to Page B when any block on Page A contains `[[Page B]]`
- *Purpose*: Captures directional conceptual flow. Useful for local search -- traversing neighbors to find contextually relevant pages.

**Layer 3 -- Block Reference Graph (directed)**
- Nodes: Blocks
- Edges: Block A references Block B via `((uid-of-B))`
- *Purpose*: Captures idea-level citation networks. When a user block-references another block, they are asserting that the referenced content is directly relevant.

**Layer 4 -- Attribute Graph (bipartite, typed)**
- Nodes: Pages/Blocks on one side, Attribute values on the other
- Edges: `Attribute:: value` pairs, typed by attribute name
- *Purpose*: Structured metadata for filtering and faceted retrieval (e.g., "Status:: Done", "Author:: [[Person]]", "Priority:: High")

**Layer 5 -- Temporal Graph**
- Nodes: Pages and Daily Note Pages (DNPs)
- Edges: A page is linked from a specific DNP, providing a timestamped mention
- *Purpose*: Temporal reasoning. "When was X discussed?" "What was discussed alongside Y in January?"

### 1.3 Exploiting Roam-Specific Relationship Semantics for Retrieval

During retrieval, different relationship types should be weighted differently based on query intent:

- **"What do I know about X?"** → Prioritize Layer 2 (direct links from/to X) and Layer 3 (block references involving X's blocks)
- **"What themes connect X and Y?"** → Prioritize Layer 1 (shared co-references) and community membership
- **"What happened with X in Q1?"** → Prioritize Layer 5 (temporal edges) filtered by date range
- **"What are my notes tagged Z?"** → Prioritize Layer 1 tag edges and Layer 4 attributes
- **"What are the main themes in my graph?"** → Prioritize community summaries derived from Layer 1

### 1.4 Datomic Queries as Native Graph Traversal

Roam's Datomic/Datalog backend is itself a graph query engine. Rather than exporting the graph and running external algorithms, many graph traversals can be expressed as efficient Datalog queries:

```clojure
;; Find all pages co-referenced with [[Target]] in the same block
[:find ?co-ref-title (count ?b)
 :where
 [?target :node/title "Target"]
 [?b :block/refs ?target]
 [?b :block/refs ?co-ref]
 [(!= ?co-ref ?target)]
 [?co-ref :node/title ?co-ref-title]]
```

This is dramatically more efficient than extracting the full graph, building an adjacency matrix, and querying it externally.

---

## Part 2: Leveraging Community Structure from Preexisting Links

### 2.1 Why Roam Graphs Have Natural Communities

Microsoft GraphRAG uses the Leiden algorithm to detect communities in LLM-extracted entity graphs. The key insight is that **Roam graphs already exhibit strong community structure** because users naturally cluster related ideas through linking.

A researcher working on "Machine Learning" will create pages for specific algorithms, datasets, papers, and people -- all heavily interlinked. These will form a natural community distinct from their "Cooking Recipes" cluster. The community structure reflects the user's own mental model of topic boundaries.

### 2.2 Community Detection on the Page Co-Reference Graph

Apply the Leiden algorithm to Layer 1 (the page co-reference graph):

**Algorithm Configuration:**
- **Resolution parameter**: Start with gamma = 1.0 (standard modularity). For large graphs (1000+ pages), experiment with gamma values from 0.5 to 2.0 to find the level that produces thematically coherent communities of 10-50 pages.
- **Hierarchical levels**: Run Leiden recursively to produce 3-5 levels of community hierarchy:
  - **Level 0 (Root)**: 3-8 top-level communities representing the user's major knowledge domains
  - **Level 1**: 15-40 sub-communities representing specific topics within domains
  - **Level 2**: 50-200 leaf communities representing tightly coupled concept clusters
  - **Level 3+**: Only for very large graphs (5000+ pages)

**Weight handling**: Edge weights from co-reference counts directly inform modularity optimization -- pages that are frequently co-referenced will be strongly pulled into the same community.

### 2.3 Community Summarization Strategy

For each community at each level, generate an LLM summary. But unlike standard GraphRAG, which summarizes entity descriptions, Roam community summaries should incorporate:

1. **Page titles** in the community (these are human-authored concept names, far more meaningful than LLM-extracted entity names)
2. **Top block content** from highly-referenced blocks within community pages
3. **Attribute patterns** common to community members (e.g., "most pages in this community have Status:: Active")
4. **Temporal patterns** (e.g., "this cluster was most active in March-April 2024")
5. **Inter-community links** (how this community connects to others)

**Summarization prompt template:**
```
You are summarizing a cluster of related pages from a personal knowledge graph.

Pages in this cluster: {page_titles}

Key content excerpts:
{top_blocks_by_reference_count}

Common attributes:
{shared_attributes}

Activity period: {earliest_mention} to {latest_mention}

Connected clusters: {neighboring_community_summaries}

Write a 2-3 paragraph summary describing:
1. The main topic/theme of this cluster
2. The key ideas and how they relate to each other
3. Any notable patterns or insights
```

### 2.4 Incremental Community Updates

Unlike batch-processed document corpora, Roam graphs change continuously. Design for incremental updates:

1. **Edge-level updates**: When a user adds/removes a `[[link]]`, update the co-reference edge weights in Layer 1.
2. **Local re-clustering**: Only re-run Leiden on the affected community and its immediate neighbors, not the entire graph.
3. **Summary invalidation**: Mark affected community summaries as stale. Re-generate lazily (on next query that touches that community) or eagerly (in a background process after N minutes of inactivity).
4. **Change tracking**: Use Roam's `:edit/time` attribute to identify blocks modified since the last index update.

### 2.5 Community-Aware Query Routing

When a query arrives:

1. **Entity resolution**: Identify which Roam pages the query references or is about (using title matching, semantic similarity, or the existing `findPagesByTitle` tool).
2. **Community lookup**: Determine which communities those pages belong to.
3. **Scope decision**:
   - If all referenced pages are in the same community → **Local search** within that community
   - If referenced pages span 2-3 communities → **Cross-community search** using inter-community edges
   - If no specific pages are referenced (global question) → **Global search** using community summaries at the appropriate hierarchy level

---

## Part 3: Leveraging the Tree-Like Structure

### 3.1 The Block Tree as a Semantic Hierarchy

Roam's most distinctive structural feature is that content is not flat text but a tree of blocks. This tree structure carries semantic meaning:

```
- Machine Learning                          ← Topic/category (L0)
  - Supervised Learning                     ← Sub-topic (L1)
    - The model learns from labeled data    ← Definition (L2)
    - Common algorithms                     ← Sub-sub-topic (L2)
      - Linear Regression                   ← Specific concept (L3)
        - Assumes linear relationship       ← Detail (L4)
        - Loss function: MSE               ← Technical detail (L4)
      - Decision Trees                      ← Sibling concept (L3)
        - Non-parametric                    ← Detail (L4)
```

Indentation level encodes **specificity**: deeper blocks are more specific elaborations of their ancestors. Sibling blocks at the same level are **parallel** concepts under a shared parent.

### 3.2 Tree-Aware Chunking Strategy

Standard RAG chunks text by token count. For Roam, chunk by **subtree**:

**Subtree Chunking Algorithm:**
1. For each page, identify the top-level blocks (L0 children of the page).
2. Each top-level block and its entire subtree constitute a **primary chunk**.
3. If a subtree exceeds the token budget (e.g., 500 tokens), split at the highest level that produces sub-chunks under budget.
4. Always include the **ancestor path** (from page title down to the chunk root) as a prefix to preserve hierarchical context.

**Example chunk with ancestor context:**
```
[Page: Machine Learning > Supervised Learning > Common algorithms]

- Linear Regression
  - Assumes linear relationship between features and target
  - Loss function: Mean Squared Error (MSE)
  - Variants: Ridge, Lasso, ElasticNet
```

The ancestor path `Machine Learning > Supervised Learning > Common algorithms` provides crucial context that would be lost in flat chunking.

### 3.3 Hierarchical Embedding Strategy

Generate embeddings at multiple tree levels to enable multi-granularity retrieval:

| Level | What Gets Embedded | Use Case |
|---|---|---|
| Page-level | Page title + concatenation of L0 block content | Broad topic matching |
| Branch-level | L0 block + full subtree (up to token limit) | Topic-section matching |
| Block-level | Individual block + ancestor path context | Precise content retrieval |

**Retrieval cascade:**
1. First, retrieve at page-level to identify candidate pages (fast, coarse)
2. Then, retrieve at branch-level within candidate pages (medium granularity)
3. Finally, retrieve at block-level within candidate branches (precise)

This cascade is both more accurate (hierarchical context prevents false matches) and more efficient (progressive narrowing reduces the search space at each step).

### 3.4 Tree Structure for Context Window Optimization

The tree structure enables intelligent context construction for the LLM:

**Telescoping context**: When a query matches a specific block, include:
- The matched block and its immediate children (full detail)
- Its parent and siblings (moderate detail -- first line only)
- Its grandparent and its siblings (minimal detail -- titles only)
- The page title

This creates a "telescoping" view that gives the LLM both the specific matched content and its structural context, using far fewer tokens than including the entire page.

**Sibling-aware context**: When a query matches one child block, its siblings are likely relevant (they share the same parent topic). Include siblings as additional context, ranked by:
1. Blocks that share references with the matched block
2. Blocks that are adjacent (immediately before/after)
3. Remaining siblings by recency

### 3.5 Tree Hierarchy as Natural Summarization Levels

The block tree provides a built-in summarization hierarchy that complements community-level summaries:

- **L0 blocks** on a page are effectively a user-authored outline/summary of the page's content
- **L1 blocks** elaborate on each L0 point
- **L2+ blocks** provide progressively more detail

This means that for many pages, you can retrieve a useful summary **without any LLM summarization** simply by reading the L0 blocks. This is dramatically cheaper than generating summaries.

**Adaptive depth retrieval:**
- For global queries → return L0 blocks from community member pages
- For topic queries → return L0-L1 blocks from matched pages
- For specific queries → return the full subtree of the matched branch

### 3.6 Tree-Aware Graph Edges

Incorporate tree structure into the graph layers:

**Containment edges**: A block at depth N "contains" all its descendants. When computing co-references in Layer 1, propagate references upward: if a deeply nested block mentions `[[Page X]]`, credit the entire ancestor chain. This ensures that a top-level block about "Machine Learning" that contains many nested references to specific ML concepts gets appropriately weighted in the co-reference graph.

**Scope-aware reference weighting**: A reference in a shallow block (L0-L1) carries more weight than one deeply nested (L4+), because shallow blocks represent the user's primary organizational intent while deep blocks may be incidental details.

---

## Part 4: Unified Architecture

### 4.1 Indexing Pipeline

```
┌─────────────────────────────────────────────────────────┐
│                    ROAM GRAPH                           │
│  Pages, Blocks, Links, Refs, Attributes, DNPs          │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│              GRAPH EXTRACTION                           │
│  Via Datomic queries (no LLM needed)                    │
│                                                         │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ L1: Co-Ref  │ │ L2: Direct   │ │ L3: Block Ref    │  │
│  │    Graph    │ │    Links     │ │    Graph         │  │
│  └─────────────┘ └──────────────┘ └──────────────────┘  │
│  ┌─────────────┐ ┌──────────────┐                       │
│  │ L4: Attrib  │ │ L5: Temporal │                       │
│  │    Graph    │ │    Graph     │                       │
│  └─────────────┘ └──────────────┘                       │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│           COMMUNITY DETECTION (Leiden)                  │
│  Applied to L1 (co-reference graph)                     │
│                                                         │
│  Level 0: 3-8 root communities (major domains)          │
│  Level 1: 15-40 sub-communities (topics)                │
│  Level 2: 50-200 leaf communities (concept clusters)    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│           SUMMARIZATION (LLM-powered)                   │
│                                                         │
│  Per community: thematic summary from page titles,      │
│  top blocks, attributes, temporal patterns              │
│                                                         │
│  Per page: L0-block-based summary (often no LLM needed) │
│                                                         │
│  Bottom-up: leaf → intermediate → root summaries        │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│           EMBEDDING INDEX                               │
│                                                         │
│  Page-level embeddings (title + L0 blocks)              │
│  Branch-level embeddings (subtrees)                     │
│  Block-level embeddings (block + ancestor path)         │
│  Community summary embeddings                           │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Query Pipeline

```
┌──────────────┐
│  User Query  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  QUERY ANALYSIS                                  │
│                                                  │
│  1. Classify: global / topic / specific          │
│  2. Extract referenced pages/concepts            │
│  3. Identify temporal constraints                │
│  4. Determine required graph layers              │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  RETRIEVAL (multi-strategy)                      │
│                                                  │
│  Global queries:                                 │
│    → Map-reduce over community summaries         │
│    → Use root/intermediate level summaries       │
│                                                  │
│  Topic queries:                                  │
│    → Identify relevant communities               │
│    → Retrieve L0-L1 blocks from member pages     │
│    → Fan out via co-reference edges              │
│                                                  │
│  Specific queries:                               │
│    → Block-level semantic search                 │
│    → Graph neighbor expansion (block refs, links)│
│    → Telescoping context construction            │
│                                                  │
│  Temporal queries:                               │
│    → Filter via L5 temporal graph                │
│    → Scope to date-range DNPs                    │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  CONTEXT ASSEMBLY                                │
│                                                  │
│  1. Deduplicate retrieved blocks                 │
│  2. Apply telescoping context for each match     │
│  3. Include community summaries for orientation  │
│  4. Rank by: graph distance, recency, ref count  │
│  5. Truncate to token budget                     │
│  6. Format with tree structure preserved         │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  LLM GENERATION                                  │
│                                                  │
│  System prompt includes:                         │
│    - Community context (what domain we're in)    │
│    - Retrieved blocks with hierarchy             │
│    - Relationship metadata (link types, weights) │
│                                                  │
│  Response includes:                              │
│    - Answer grounded in retrieved content        │
│    - Block UIDs as citations                     │
│    - Confidence based on graph coverage          │
└──────────────────────────────────────────────────┘
```

### 4.3 Integration with Existing Extension Architecture

The existing Live AI Assistant extension already has many building blocks:

| Existing Capability | Graph-RAG Role |
|---|---|
| `DatomicQueryBuilder` | Graph extraction (all 5 layers) |
| `findBlocksWithHierarchy` + hierarchy operators | Tree-aware retrieval |
| `extractHierarchyContent` | Subtree chunking |
| `extractPageReferences` | Co-reference graph construction |
| `combineResults` (set operations) | Cross-community result merging |
| `SemanticExpansion` | Query expansion before graph traversal |
| `ResultSummary` with metadata | Community summary caching |
| `ask-your-graph-agent` (LangGraph) | Agent orchestration |
| `getPathOfBlock` / `getParentBlock` | Ancestor path construction |
| `findDailyNotesByPeriod` | Temporal graph queries |

**New components needed:**
1. **Community detection module**: Client-side Leiden implementation (or use a WASM-compiled library). The page co-reference graph is typically small enough (hundreds to low thousands of nodes) to run in-browser.
2. **Community summary store**: Persistent cache (IndexedDB or Roam page-based) for community summaries with staleness tracking.
3. **Multi-level embedding index**: Vector store for page/branch/block embeddings. Could use an in-browser vector DB or an external service.
4. **Query router**: Classifies incoming queries and selects the appropriate retrieval strategy.
5. **Telescoping context builder**: Constructs hierarchically-aware context windows from retrieved blocks.

---

## Part 5: Key Design Decisions and Trade-offs

### 5.1 Client-Side vs. Server-Side Community Detection

**Client-side (recommended for graphs < 5000 pages):**
- Leiden can run on a co-reference graph of ~2000 nodes in < 1 second in JavaScript
- No data leaves the user's machine (privacy)
- Immediate updates when the graph changes
- Use a library like `graphology` + community detection plugins

**Server-side (for very large graphs):**
- Ship the adjacency list to a backend with `igraph` or `leidenalg` (Python)
- Required for graphs > 10,000 pages
- Privacy implications must be addressed

### 5.2 When to Summarize vs. When to Use Raw Content

The tree structure provides a natural heuristic:
- **Pages with structured L0 blocks**: Skip LLM summarization; use L0 blocks directly as the summary
- **Pages with dense, unstructured content**: Generate LLM summaries
- **Communities with < 10 pages**: Summary = concatenation of page titles + L0 blocks (no LLM needed)
- **Communities with 10+ pages**: Generate LLM summaries

This dramatically reduces the LLM cost compared to standard GraphRAG, which summarizes everything.

### 5.3 Handling Roam-Specific Patterns

**Daily Note Pages (DNPs):** DNPs are a special case. They are temporal containers, not topical pages. Exclude DNPs from the page co-reference graph nodes, but use the links *within* DNPs to create edges between the topical pages they reference. DNP content should be indexed in the temporal graph (Layer 5) and associated with the pages they link to.

**Tags vs. Page Links:** In Roam, `#tag` and `[[tag]]` are semantically identical (both create page references). Treat them uniformly in graph construction.

**Namespaced Pages:** Pages like `Book/Deep Work` or `Project/Alpha` use `/` as a namespace separator. These encode hierarchical relationships that should be captured as additional tree edges in the graph: `Project` is a parent of `Project/Alpha`.

**Templates and Queries:** Roam `{{query}}` blocks and template content should be excluded from indexing as they are meta-content, not substantive notes.

### 5.4 Comparison with Standard GraphRAG

| Aspect | Standard GraphRAG | Roam Graph-RAG |
|---|---|---|
| Entity extraction | LLM-based, expensive, noisy | Free -- pages/blocks are entities |
| Relationship extraction | LLM-based, incomplete | Free -- links/refs are relationships |
| Relationship types | Generic descriptions | Typed (link, ref, attribute, temporal) |
| Graph quality | Depends on LLM accuracy | High -- human-curated structure |
| Community detection | Same (Leiden) | Same (Leiden) |
| Summarization | All LLM-generated | Partially from tree structure |
| Hierarchy | Only from community levels | Both community levels AND block tree |
| Incremental updates | Re-index documents | Update affected edges only |
| Token cost | Very high (extraction + summarization) | Low (summarization only, partially free) |

---

## References

- Edge, D., et al. "From Local to Global: A Graph RAG Approach to Query-Focused Summarization." arXiv:2404.16130 (2024).
- Traag, V.A., Waltman, L., & van Eck, N.J. "From Louvain to Leiden: guaranteeing well-connected communities." Scientific Reports 9, 5233 (2019).
- Microsoft GraphRAG Documentation: https://microsoft.github.io/graphrag/
- Microsoft Research: "Introducing DRIFT Search" (2024).
- Microsoft Research: "GraphRAG: Improving global search via dynamic community selection" (2024).
- Sharma, et al. "OG-RAG: Ontology-Grounded Retrieval-Augmented Generation." EMNLP 2025. arXiv:2412.15235.
- Sarthi, et al. "RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval." ICLR 2024.
- KGGen: https://github.com/stair-lab/kg-gen (arXiv:2502.09956).
- Peng, et al. "Graph Retrieval-Augmented Generation: A Survey." arXiv:2408.08921 (2024).
- LightRAG: https://github.com/HKUDS/LightRAG
- FastGraphRAG: https://github.com/circlemind-ai/fast-graphrag
- Awesome-GraphRAG: https://github.com/DEEP-PolyU/Awesome-GraphRAG
