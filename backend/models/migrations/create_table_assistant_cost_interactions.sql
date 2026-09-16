CREATE TABLE IF NOT EXISTS assistant_cost_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  stt_usage_json TEXT,
  llm_planning_usage_json TEXT,
  llm_answer_usage_json TEXT,
  tts_estimated_cost REAL NOT NULL DEFAULT 0,
  interaction_total_estimated_usd REAL NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL DEFAULT 'api_usage+fallback',
  cost_mode TEXT NOT NULL DEFAULT 'estimated',
  user_credit_balance REAL,
  balance_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_cost_interactions_session
  ON assistant_cost_interactions(session_id);

CREATE INDEX IF NOT EXISTS idx_assistant_cost_interactions_created_at
  ON assistant_cost_interactions(created_at);
