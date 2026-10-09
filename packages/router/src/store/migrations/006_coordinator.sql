-- Native coordinator bootstraps (`hmr start "<task>"`). A coordinator is a control role: it
-- reads the task and drives HMR workflows; it is not a source writer and holds no writer
-- ownership. One open coordinator per worktree; its single prompt is recorded as `sending`
-- before it goes out and is never resent. `sent` means Herdr accepted the submission but no
-- activity was observed; `prompted` means activity was observed. State changes are
-- compare-and-set: a closed record never reopens. The task text itself lives only in the prompt the
-- native CLI received; only its SHA-256 is stored here.

CREATE TABLE IF NOT EXISTS coordinators (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  role TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  argv TEXT NOT NULL,
  rules_path TEXT NOT NULL,
  task_sha256 TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('starting', 'sending', 'sent', 'prompted', 'unknown', 'failed', 'closed')
  ),
  send_evidence TEXT,
  pane_id TEXT,
  agent_name TEXT,
  agent_kind TEXT,
  session_id TEXT,
  session_cwd TEXT,
  closing_evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS coordinators_one_open
  ON coordinators (worktree_id)
  WHERE state IN ('starting', 'sending', 'sent', 'prompted', 'unknown');

-- Workflows a coordinator started from its own pane: evidence that roles were assigned, kept
-- apart from the bootstrap itself and from any workflow's completion.
CREATE TABLE IF NOT EXISTS coordinator_workflows (
  coordinator_id TEXT NOT NULL REFERENCES coordinators (id),
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (coordinator_id, workflow_id)
);
