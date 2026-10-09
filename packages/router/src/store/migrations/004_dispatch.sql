-- Rules-mode dispatch: one task per `run`, one lane per planned model, one attempt per
-- prompt submission. Prompts are not stored; only their SHA-256.
CREATE TABLE IF NOT EXISTS dispatch_tasks (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single', 'panel')),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  worktree_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  rules_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('dispatching', 'dispatched', 'partial', 'failed', 'complete', 'released')
  ),
  closing_evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatch_lanes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES dispatch_tasks (id),
  lane_index INTEGER NOT NULL,
  descriptor TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  argv_json TEXT NOT NULL,
  agent_name TEXT,
  pane_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'pane-created', 'agent-started', 'prompted', 'failed')
  ),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, lane_index)
);

CREATE TABLE IF NOT EXISTS dispatch_attempts (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL REFERENCES dispatch_lanes (id),
  seq INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('initial', 'revision')),
  prompt_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('sending', 'sent', 'working', 'blocked', 'unknown', 'not-delivered')
  ),
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (lane_id, seq)
);

-- At most one writer task per worktree. Separate from capacity_reservations: ownership is
-- who may write here, not how much quota is set aside.
CREATE TABLE IF NOT EXISTS writer_ownership (
  worktree_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES dispatch_tasks (id),
  acquired_at TEXT NOT NULL
);
