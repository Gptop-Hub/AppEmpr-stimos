CREATE TABLE IF NOT EXISTS assistant_cost_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_credit_balance REAL NOT NULL DEFAULT 0,
  balance_source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
