ALTER TABLE emprestimos ADD COLUMN last_activity_at TEXT;
UPDATE emprestimos SET last_activity_at = datetime('now') WHERE last_activity_at IS NULL;
