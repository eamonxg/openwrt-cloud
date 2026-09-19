CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warning','critical')),
  audience TEXT NOT NULL CHECK (audience IN ('all','creators')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  i18n TEXT NOT NULL DEFAULT '{}',
  min_schema INTEGER,
  max_schema INTEGER,
  starts_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- Ascending on purpose: the feed orders by created_at DESC, rowid DESC, and
-- only a reverse scan of an ascending index yields both without a sort.
CREATE INDEX idx_notices_feed ON notices(created_at) WHERE revoked_at IS NULL;

CREATE TABLE schema_policies (
  theme TEXT NOT NULL,
  schema INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('current','deprecated','unsupported')),
  sunset_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (theme, schema)
);

INSERT INTO schema_policies (theme, schema, state, sunset_at) VALUES ('aurora', 1, 'current', NULL);

-- SQLite cannot alter a CHECK in place, so admin_actions is rebuilt to let
-- target_type also take 'notice' and 'schema'.
CREATE TABLE admin_actions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('config','device','report','notice','schema')),
  target_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO admin_actions_new (id, actor, action, target_type, target_id, note, created_at)
  SELECT id, actor, action, target_type, target_id, note, created_at FROM admin_actions;

DROP TABLE admin_actions;

ALTER TABLE admin_actions_new RENAME TO admin_actions;

CREATE INDEX idx_admin_actions_recent ON admin_actions(created_at DESC, id DESC);
CREATE INDEX idx_admin_actions_target ON admin_actions(target_type, target_id, created_at DESC);
