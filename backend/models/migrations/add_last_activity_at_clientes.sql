ALTER TABLE clientes ADD COLUMN last_activity_at TEXT;
UPDATE clientes SET last_activity_at = datetime('now') WHERE last_activity_at IS NULL;
