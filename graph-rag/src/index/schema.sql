-- Graph-RAG Index Schema for Roam Research

-- Pages
CREATE TABLE IF NOT EXISTS pages (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  block_count INTEGER DEFAULT 0,
  ref_count INTEGER DEFAULT 0,
  last_modified INTEGER DEFAULT 0,
  last_indexed INTEGER DEFAULT 0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_pages_title ON pages(title);

-- Communities
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  resolution REAL,
  page_count INTEGER DEFAULT 0,
  summary TEXT,
  summary_embedding BLOB,
  tree_derived_summary TEXT,
  last_indexed INTEGER DEFAULT 0,
  is_dirty INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_communities_level ON communities(level);

-- Community membership (page <-> community)
CREATE TABLE IF NOT EXISTS community_pages (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  page_uid TEXT NOT NULL REFERENCES pages(uid) ON DELETE CASCADE,
  PRIMARY KEY (community_id, page_uid)
);
CREATE INDEX IF NOT EXISTS idx_cp_page ON community_pages(page_uid);

-- Community edges (inter-community connections)
CREATE TABLE IF NOT EXISTS community_edges (
  source_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  weight REAL DEFAULT 0,
  PRIMARY KEY (source_id, target_id)
);

-- Branches (L0 blocks = top-level sections of pages)
CREATE TABLE IF NOT EXISTS branches (
  uid TEXT PRIMARY KEY,
  page_uid TEXT NOT NULL REFERENCES pages(uid) ON DELETE CASCADE,
  content_preview TEXT,
  token_count INTEGER DEFAULT 0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_branches_page ON branches(page_uid);

-- Blocks (individual content blocks)
CREATE TABLE IF NOT EXISTS blocks (
  uid TEXT PRIMARY KEY,
  page_uid TEXT NOT NULL REFERENCES pages(uid) ON DELETE CASCADE,
  branch_uid TEXT REFERENCES branches(uid) ON DELETE SET NULL,
  ancestor_path TEXT,
  content TEXT,
  depth INTEGER DEFAULT 0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_uid);
CREATE INDEX IF NOT EXISTS idx_blocks_branch ON blocks(branch_uid);

-- Co-reference graph edges
CREATE TABLE IF NOT EXISTS coref_edges (
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  weight INTEGER DEFAULT 0,
  PRIMARY KEY (source_title, target_title)
);

-- Direct link edges
CREATE TABLE IF NOT EXISTS direct_link_edges (
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  weight INTEGER DEFAULT 0,
  PRIMARY KEY (source_title, target_title)
);

-- Attributes
CREATE TABLE IF NOT EXISTS attributes (
  block_uid TEXT NOT NULL,
  page_uid TEXT NOT NULL,
  page_title TEXT NOT NULL,
  attr_name TEXT NOT NULL,
  attr_value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_name ON attributes(attr_name);
CREATE INDEX IF NOT EXISTS idx_attr_value ON attributes(attr_value);
CREATE INDEX IF NOT EXISTS idx_attr_page ON attributes(page_title);

-- Temporal mentions
CREATE TABLE IF NOT EXISTS temporal_mentions (
  page_title TEXT NOT NULL,
  dnp_date TEXT NOT NULL,
  mention_count INTEGER DEFAULT 1,
  PRIMARY KEY (page_title, dnp_date)
);
CREATE INDEX IF NOT EXISTS idx_temporal_page ON temporal_mentions(page_title);
CREATE INDEX IF NOT EXISTS idx_temporal_date ON temporal_mentions(dnp_date);

-- Index metadata (singleton row)
CREATE TABLE IF NOT EXISTS index_metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
