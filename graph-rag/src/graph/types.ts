// ─── Graph Layer Types ───────────────────────────────────────────────

export interface CoRefEdge {
  source: string; // page title
  target: string; // page title
  weight: number; // co-reference count
}

export interface DirectLinkEdge {
  source: string; // source page title
  target: string; // target page title
  weight: number; // number of linking blocks
}

export interface BlockRefEdge {
  sourceUid: string;
  targetUid: string;
  sourcePageTitle: string;
  targetPageTitle: string;
}

export interface AttributeEntry {
  pageTitle: string;
  blockUid: string;
  attrName: string;
  attrValue: string;
}

export interface TemporalMention {
  pageTitle: string;
  dnpTitle: string;
  editTime: number;
}

export interface PageMetadata {
  uid: string;
  title: string;
  blockCount: number;
  refCount: number;
}

// ─── Block Tree Types ────────────────────────────────────────────────

export interface BlockNode {
  uid: string;
  string: string;
  order: number;
  editTime?: number;
  children?: BlockNode[];
  refs?: Array<{ title?: string; uid: string }>;
}

export interface PageTree {
  uid: string;
  title: string;
  children: BlockNode[];
}

export interface AncestorNode {
  uid: string;
  string?: string;
  title?: string;
  parents?: AncestorNode;
}

// ─── Community Types ─────────────────────────────────────────────────

export interface Community {
  id: string;
  level: number;
  resolution: number;
  pages: string[];
  pageUids: string[];
  totalBlocks: number;
  totalIncomingRefs: number;
  internalEdgeWeight: number;
  externalEdges: Map<string, number>;
  commonAttributes: Map<string, string[]>;
  activityRange: { earliest: number; latest: number };
  summary: string | null;
  treeDerivedSummary: string | null;
  embedding: number[] | null;
  lastIndexed: number;
  isDirty: boolean;
}

export interface CommunityHierarchy {
  level: number;
  resolution: number;
  communities: Map<string, string[]>; // communityId -> page titles
  modularity: number;
}

// ─── Search / Retrieval Types ────────────────────────────────────────

export interface SearchResult {
  blockUid: string;
  content: string;
  pageTitle: string;
  ancestorPath: string;
  relevanceScore: number;
  siblings?: string[];
  graphDistance?: number;
}

export interface CommunitySearchResult {
  communityId: string;
  level: number;
  summary: string;
  pageCount: number;
  relevanceScore: number;
}

export interface DriftRound {
  round: number;
  strategy: string;
  communitiesExplored: string[];
  keyFindings: string[];
  followUpQueries: string[];
}

export interface TemporalEntry {
  date: string;
  pagesMentioned: string[];
  keyBlocks: Array<{ uid: string; content: string; page: string }>;
}

export interface NeighborhoodNode {
  title: string;
  uid: string;
  type: "page" | "block";
}

export interface NeighborhoodEdge {
  source: string;
  target: string;
  type: string;
  weight?: number;
}

// ─── Telescoping Context ─────────────────────────────────────────────

export interface TelescopingContext {
  matchedBlock: { uid: string; content: string; depth: number };
  children: Array<{ content: string; depth: number }>;
  siblings: Array<{ content: string; depth: number }>;
  parent: { content: string; depth: number } | null;
  ancestorPath: string;
  communityContext: string | null;
}

// ─── Index Metadata ──────────────────────────────────────────────────

export interface IndexStats {
  pageCount: number;
  blockCount: number;
  branchCount: number;
  communityCount: number;
  corefEdgeCount: number;
  lastFullIndex: number;
  lastIncrementalUpdate: number;
}

// ─── Change Detection ────────────────────────────────────────────────

export interface ChangeSet {
  modifiedBlocks: Array<{
    blockUid: string;
    pageUid: string;
    pageTitle: string;
    editTime: number;
  }>;
  affectedPages: Set<string>;
  affectedCommunities: Set<string>;
}
