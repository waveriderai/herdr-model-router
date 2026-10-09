-- Coordinator workflows. A worktree is bound to exactly one writer authority; a workflow
-- holds one writer session across review, revision, acceptance and delivery. Brief and
-- result plaintext live in private artifact files; only their SHA-256 is stored here.

-- dispatch_lanes also gains session_id and session_cwd (see ADDED_COLUMNS in database.ts):
-- the native session and directory a writer lane was bound to before its first prompt. Older
-- lanes have neither, and a revision refuses them instead of adopting a session.

CREATE TABLE IF NOT EXISTS worktree_bindings (
  worktree_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL CHECK (backend IN ('standalone', 'agent-collab')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('standalone', 'agent-collab')),
  state TEXT NOT NULL CHECK (
    state IN (
      'starting', 'dispatched', 'unknown', 'receipt', 'verifying', 'reviewed', 'revision',
      'accepted', 'delivered', 'released', 'aborted', 'failed'
    )
  ),
  brief_sha256 TEXT NOT NULL,
  writer_role TEXT NOT NULL,
  writer_descriptor TEXT NOT NULL,
  -- The parent descriptor that resolved parent aliases at start; reused by verify and revise.
  parent_descriptor TEXT,
  cwd TEXT NOT NULL,
  baseline_head TEXT NOT NULL,
  baseline_content TEXT NOT NULL,
  -- Standalone: the rules-mode writer task that holds writer_ownership.
  task_id TEXT REFERENCES dispatch_tasks (id),
  -- agent-collab: the external run; the owner capability is never stored here.
  external_run_id TEXT,
  -- agent-collab startup: the pane HMR created, and whether its close was confirmed.
  start_pane_id TEXT,
  start_pane_closed INTEGER,
  agent_name TEXT,
  agent_kind TEXT,
  pane_id TEXT,
  session_id TEXT,
  session_cwd TEXT,
  accepted_attempt_id TEXT,
  accepted_head TEXT,
  accepted_content TEXT,
  acceptance_evidence TEXT,
  delivery_kind TEXT CHECK (delivery_kind IN ('delivered', 'not-applicable')),
  delivery_evidence TEXT,
  delivered_head TEXT,
  closing_evidence TEXT,
  -- One coordinator operation at a time: reserved before any await, cleared when it ends.
  op_token TEXT,
  op_name TEXT,
  op_pid INTEGER,
  op_host TEXT,
  op_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- At most one open workflow per worktree, whatever its backend.
CREATE UNIQUE INDEX IF NOT EXISTS workflows_open_worktree ON workflows (worktree_id)
  WHERE state NOT IN ('released', 'aborted', 'failed');

CREATE TABLE IF NOT EXISTS workflow_attempts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  seq INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('initial', 'revision')),
  prompt_sha256 TEXT NOT NULL,
  -- Standalone: the dispatch_attempts row. agent-collab: its attempt id (a1, a2, ...).
  -- Linked before the prompt is submitted, so a crash mid-send stays recoverable.
  backend_attempt TEXT,
  send_state TEXT NOT NULL CHECK (
    send_state IN ('pending', 'sending', 'sent', 'working', 'blocked', 'unknown', 'not-delivered')
  ),
  send_evidence TEXT,
  result_sha256 TEXT,
  result_status TEXT,
  result_head TEXT,
  result_content TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, seq)
);

CREATE TABLE IF NOT EXISTS workflow_verifications (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  attempt_id TEXT NOT NULL REFERENCES workflow_attempts (id),
  role TEXT NOT NULL,
  task_id TEXT REFERENCES dispatch_tasks (id),
  revision_head TEXT NOT NULL,
  revision_content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_verifier_results (
  verification_id TEXT NOT NULL REFERENCES workflow_verifications (id),
  lane_id TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (verification_id, lane_id)
);

-- Every external mutation is written here, with what it expects to change, before it is
-- called. `observed`: the backend answered ok, but the matching local transition has not
-- committed yet; the two become `done` in one transaction. `pending`, `unknown` and
-- `observed` all block every other external mutation of the workflow until the local commit
-- or `workflow recover` (read-only backend status) settles them. Nothing is replayed.
CREATE TABLE IF NOT EXISTS workflow_intents (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  operation TEXT NOT NULL,
  attempt_id TEXT,
  backend_attempt TEXT,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'observed', 'done', 'refused', 'unknown')),
  observed TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_intents_unresolved ON workflow_intents (workflow_id)
  WHERE state IN ('pending', 'observed', 'unknown');
