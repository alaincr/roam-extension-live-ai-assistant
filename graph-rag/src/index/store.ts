import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { GraphRAGConfig } from "../config/index.js";
import type {
  CoRefEdge,
  DirectLinkEdge,
  AttributeEntry,
  PageMetadata,
  IndexStats,
} from "../graph/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class IndexStore {
  private db: Database.Database;

  constructor(config: GraphRAGConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  // ─── Metadata ──────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM index_metadata WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  getLastIndexTimestamp(): number {
    return parseInt(this.getMeta("last_full_index") ?? "0", 10);
  }

  getLastIncrementalTimestamp(): number {
    return parseInt(this.getMeta("last_incremental_update") ?? "0", 10);
  }

  getStats(): IndexStats {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      return row.c;
    };

    return {
      pageCount: count("pages"),
      blockCount: count("blocks"),
      branchCount: count("branches"),
      communityCount: count("communities"),
      corefEdgeCount: count("coref_edges"),
      lastFullIndex: this.getLastIndexTimestamp(),
      lastIncrementalUpdate: this.getLastIncrementalTimestamp(),
    };
  }

  // ─── Pages ─────────────────────────────────────────────────────

  upsertPages(pages: PageMetadata[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pages (uid, title, block_count, ref_count, last_indexed)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const p of pages) {
        stmt.run(p.uid, p.title, p.blockCount, p.refCount, now);
      }
    });
    tx();
  }

  getPageByTitle(title: string): { uid: string; title: string } | null {
    return (
      (this.db.prepare("SELECT uid, title FROM pages WHERE title = ?").get(title) as {
        uid: string;
        title: string;
      }) ?? null
    );
  }

  getPageByUid(uid: string): { uid: string; title: string } | null {
    return (
      (this.db.prepare("SELECT uid, title FROM pages WHERE uid = ?").get(uid) as {
        uid: string;
        title: string;
      }) ?? null
    );
  }

  getAllPageTitles(): string[] {
    const rows = this.db.prepare("SELECT title FROM pages").all() as { title: string }[];
    return rows.map((r) => r.title);
  }

  updatePageEmbedding(uid: string, embedding: Buffer): void {
    this.db.prepare("UPDATE pages SET embedding = ? WHERE uid = ?").run(embedding, uid);
  }

  getPagesWithEmbeddings(): Array<{ uid: string; title: string; embedding: Buffer }> {
    return this.db
      .prepare("SELECT uid, title, embedding FROM pages WHERE embedding IS NOT NULL")
      .all() as Array<{ uid: string; title: string; embedding: Buffer }>;
  }

  // ─── Co-Reference Edges ────────────────────────────────────────

  replaceCoRefEdges(edges: CoRefEdge[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM coref_edges").run();
      const stmt = this.db.prepare(
        "INSERT INTO coref_edges (source_title, target_title, weight) VALUES (?, ?, ?)"
      );
      for (const e of edges) {
        stmt.run(e.source, e.target, e.weight);
      }
    });
    tx();
  }

  getCoRefEdges(): CoRefEdge[] {
    return this.db.prepare("SELECT source_title, target_title, weight FROM coref_edges").all() as Array<{
      source_title: string;
      target_title: string;
      weight: number;
    }> as unknown as CoRefEdge[];
  }

  getAllCoRefEdges(): Array<{ source: string; target: string; weight: number }> {
    const rows = this.db
      .prepare("SELECT source_title as source, target_title as target, weight FROM coref_edges")
      .all();
    return rows as Array<{ source: string; target: string; weight: number }>;
  }

  // ─── Direct Link Edges ─────────────────────────────────────────

  replaceDirectLinkEdges(edges: DirectLinkEdge[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM direct_link_edges").run();
      const stmt = this.db.prepare(
        "INSERT INTO direct_link_edges (source_title, target_title, weight) VALUES (?, ?, ?)"
      );
      for (const e of edges) {
        stmt.run(e.source, e.target, e.weight);
      }
    });
    tx();
  }

  // ─── Communities ───────────────────────────────────────────────

  replaceCommunities(
    communities: Array<{
      id: string;
      level: number;
      resolution: number;
      pages: string[];
      treeDerivedSummary?: string;
    }>
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM community_pages").run();
      this.db.prepare("DELETE FROM community_edges").run();
      this.db.prepare("DELETE FROM communities").run();

      const communityStmt = this.db.prepare(`
        INSERT INTO communities (id, level, resolution, page_count, tree_derived_summary, last_indexed, is_dirty)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);

      const memberStmt = this.db.prepare(
        "INSERT INTO community_pages (community_id, page_uid) VALUES (?, ?)"
      );

      const now = Date.now();

      for (const c of communities) {
        communityStmt.run(c.id, c.level, c.resolution, c.pages.length, c.treeDerivedSummary ?? null, now);

        for (const pageTitle of c.pages) {
          const page = this.getPageByTitle(pageTitle);
          if (page) {
            memberStmt.run(c.id, page.uid);
          }
        }
      }
    });
    tx();
  }

  setCommunityEdges(edges: Array<{ sourceId: string; targetId: string; weight: number }>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM community_edges").run();
      const stmt = this.db.prepare(
        "INSERT INTO community_edges (source_id, target_id, weight) VALUES (?, ?, ?)"
      );
      for (const e of edges) {
        stmt.run(e.sourceId, e.targetId, e.weight);
      }
    });
    tx();
  }

  getCommunity(id: string): {
    id: string;
    level: number;
    resolution: number;
    page_count: number;
    summary: string | null;
    tree_derived_summary: string | null;
    is_dirty: number;
  } | null {
    return (
      (this.db
        .prepare(
          "SELECT id, level, resolution, page_count, summary, tree_derived_summary, is_dirty FROM communities WHERE id = ?"
        )
        .get(id) as any) ?? null
    );
  }

  getCommunitiesAtLevel(level: number): Array<{
    id: string;
    level: number;
    page_count: number;
    summary: string | null;
    tree_derived_summary: string | null;
    summary_embedding: Buffer | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, level, page_count, summary, tree_derived_summary, summary_embedding FROM communities WHERE level = ?"
      )
      .all(level) as any[];
  }

  getAllCommunities(): Array<{
    id: string;
    level: number;
    page_count: number;
    summary: string | null;
    tree_derived_summary: string | null;
    summary_embedding: Buffer | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, level, page_count, summary, tree_derived_summary, summary_embedding FROM communities ORDER BY level, page_count DESC"
      )
      .all() as any[];
  }

  getCommunityPages(communityId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT p.title FROM community_pages cp JOIN pages p ON cp.page_uid = p.uid WHERE cp.community_id = ?"
      )
      .all(communityId) as { title: string }[];
    return rows.map((r) => r.title);
  }

  getCommunitiesForPage(pageTitle: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT cp.community_id FROM community_pages cp
         JOIN pages p ON cp.page_uid = p.uid
         WHERE p.title = ?`
      )
      .all(pageTitle) as { community_id: string }[];
    return rows.map((r) => r.community_id);
  }

  updateCommunitySummary(communityId: string, summary: string, embedding: Buffer | null): void {
    this.db
      .prepare(
        "UPDATE communities SET summary = ?, summary_embedding = ?, is_dirty = 0, last_indexed = ? WHERE id = ?"
      )
      .run(summary, embedding, Date.now(), communityId);
  }

  markCommunityDirty(communityId: string): void {
    this.db.prepare("UPDATE communities SET is_dirty = 1 WHERE id = ?").run(communityId);
  }

  getDirtyCommunities(): Array<{ id: string; level: number }> {
    return this.db
      .prepare("SELECT id, level FROM communities WHERE is_dirty = 1 ORDER BY level DESC")
      .all() as any[];
  }

  getCommunityNeighbors(communityId: string): Array<{ id: string; summary: string | null; weight: number }> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.summary, ce.weight
         FROM community_edges ce
         JOIN communities c ON c.id = ce.target_id
         WHERE ce.source_id = ?
         UNION
         SELECT c.id, c.summary, ce.weight
         FROM community_edges ce
         JOIN communities c ON c.id = ce.source_id
         WHERE ce.target_id = ?`
      )
      .all(communityId, communityId) as any[];
    return rows;
  }

  getMaxCommunityLevel(): number {
    const row = this.db
      .prepare("SELECT MAX(level) as max_level FROM communities")
      .get() as { max_level: number | null };
    return row.max_level ?? -1;
  }

  // ─── Branches ──────────────────────────────────────────────────

  upsertBranch(uid: string, pageUid: string, contentPreview: string, tokenCount: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO branches (uid, page_uid, content_preview, token_count)
         VALUES (?, ?, ?, ?)`
      )
      .run(uid, pageUid, contentPreview, tokenCount);
  }

  updateBranchEmbedding(uid: string, embedding: Buffer): void {
    this.db.prepare("UPDATE branches SET embedding = ? WHERE uid = ?").run(embedding, uid);
  }

  getBranchesForPage(pageUid: string): Array<{
    uid: string;
    content_preview: string;
    embedding: Buffer | null;
  }> {
    return this.db
      .prepare("SELECT uid, content_preview, embedding FROM branches WHERE page_uid = ?")
      .all(pageUid) as any[];
  }

  getAllBranchesWithEmbeddings(): Array<{
    uid: string;
    page_uid: string;
    content_preview: string;
    embedding: Buffer;
  }> {
    return this.db
      .prepare(
        "SELECT uid, page_uid, content_preview, embedding FROM branches WHERE embedding IS NOT NULL"
      )
      .all() as any[];
  }

  // ─── Blocks ────────────────────────────────────────────────────

  upsertBlock(
    uid: string,
    pageUid: string,
    branchUid: string | null,
    ancestorPath: string,
    content: string,
    depth: number
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blocks (uid, page_uid, branch_uid, ancestor_path, content, depth)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(uid, pageUid, branchUid, ancestorPath, content, depth);
  }

  updateBlockEmbedding(uid: string, embedding: Buffer): void {
    this.db.prepare("UPDATE blocks SET embedding = ? WHERE uid = ?").run(embedding, uid);
  }

  getBlocksForBranch(branchUid: string): Array<{
    uid: string;
    content: string;
    ancestor_path: string;
    depth: number;
    embedding: Buffer | null;
  }> {
    return this.db
      .prepare(
        "SELECT uid, content, ancestor_path, depth, embedding FROM blocks WHERE branch_uid = ?"
      )
      .all(branchUid) as any[];
  }

  getBlocksForPage(pageUid: string): Array<{
    uid: string;
    content: string;
    ancestor_path: string;
    depth: number;
    embedding: Buffer | null;
  }> {
    return this.db
      .prepare(
        "SELECT uid, content, ancestor_path, depth, embedding FROM blocks WHERE page_uid = ?"
      )
      .all(pageUid) as any[];
  }

  getAllBlocksWithEmbeddings(): Array<{
    uid: string;
    page_uid: string;
    branch_uid: string | null;
    content: string;
    ancestor_path: string;
    depth: number;
    embedding: Buffer;
  }> {
    return this.db
      .prepare(
        `SELECT uid, page_uid, branch_uid, content, ancestor_path, depth, embedding
         FROM blocks WHERE embedding IS NOT NULL`
      )
      .all() as any[];
  }

  deleteBlocksForPage(pageUid: string): void {
    this.db.prepare("DELETE FROM blocks WHERE page_uid = ?").run(pageUid);
    this.db.prepare("DELETE FROM branches WHERE page_uid = ?").run(pageUid);
  }

  // ─── Attributes ────────────────────────────────────────────────

  replaceAttributes(attrs: AttributeEntry[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM attributes").run();
      const stmt = this.db.prepare(
        "INSERT INTO attributes (block_uid, page_uid, page_title, attr_name, attr_value) VALUES (?, ?, ?, ?, ?)"
      );
      for (const a of attrs) {
        const page = this.getPageByTitle(a.pageTitle);
        stmt.run(a.blockUid, page?.uid ?? "", a.pageTitle, a.attrName, a.attrValue);
      }
    });
    tx();
  }

  getAttributeValues(attrName: string): Array<{ page_title: string; attr_value: string }> {
    return this.db
      .prepare("SELECT page_title, attr_value FROM attributes WHERE attr_name = ?")
      .all(attrName) as any[];
  }

  filterByAttribute(
    attrName: string,
    operator: "equals" | "contains" | "regex",
    value: string
  ): Array<{ page_title: string; page_uid: string; attr_value: string }> {
    let whereClause: string;
    let param: string;

    switch (operator) {
      case "equals":
        whereClause = "a.attr_value = ?";
        param = value;
        break;
      case "contains":
        whereClause = "a.attr_value LIKE ?";
        param = `%${value}%`;
        break;
      case "regex":
        // SQLite doesn't have native regex, use LIKE as fallback
        whereClause = "a.attr_value LIKE ?";
        param = `%${value}%`;
        break;
    }

    return this.db
      .prepare(
        `SELECT a.page_title, p.uid as page_uid, a.attr_value
         FROM attributes a
         LEFT JOIN pages p ON p.title = a.page_title
         WHERE a.attr_name = ? AND ${whereClause}`
      )
      .all(attrName, param) as any[];
  }

  getCommonAttributes(pageTitles: string[]): Map<string, string[]> {
    if (pageTitles.length === 0) return new Map();

    const placeholders = pageTitles.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT attr_name, attr_value, COUNT(*) as cnt
         FROM attributes
         WHERE page_title IN (${placeholders})
         GROUP BY attr_name, attr_value
         ORDER BY cnt DESC
         LIMIT 50`
      )
      .all(...pageTitles) as Array<{ attr_name: string; attr_value: string; cnt: number }>;

    const result = new Map<string, string[]>();
    for (const row of rows) {
      const existing = result.get(row.attr_name) ?? [];
      existing.push(row.attr_value);
      result.set(row.attr_name, existing);
    }
    return result;
  }

  // ─── Temporal ──────────────────────────────────────────────────

  replaceTemporalMentions(
    mentions: Array<{ pageTitle: string; dnpDate: string; count: number }>
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM temporal_mentions").run();
      const stmt = this.db.prepare(
        "INSERT INTO temporal_mentions (page_title, dnp_date, mention_count) VALUES (?, ?, ?)"
      );
      for (const m of mentions) {
        stmt.run(m.pageTitle, m.dnpDate, m.count);
      }
    });
    tx();
  }

  getTemporalMentions(
    startDate: string,
    endDate: string,
    pageTitles?: string[]
  ): Array<{ page_title: string; dnp_date: string; mention_count: number }> {
    let query = "SELECT page_title, dnp_date, mention_count FROM temporal_mentions WHERE dnp_date >= ? AND dnp_date <= ?";
    const params: string[] = [startDate, endDate];

    if (pageTitles && pageTitles.length > 0) {
      const placeholders = pageTitles.map(() => "?").join(",");
      query += ` AND page_title IN (${placeholders})`;
      params.push(...pageTitles);
    }

    query += " ORDER BY dnp_date";
    return this.db.prepare(query).all(...params) as any[];
  }

  // ─── Bulk Operations ───────────────────────────────────────────

  clearAll(): void {
    const tables = [
      "blocks",
      "branches",
      "community_edges",
      "community_pages",
      "communities",
      "coref_edges",
      "direct_link_edges",
      "attributes",
      "temporal_mentions",
      "pages",
      "index_metadata",
    ];
    const tx = this.db.transaction(() => {
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    tx();
  }
}
