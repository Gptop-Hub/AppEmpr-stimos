-- Campos de auditoria e contagem de parcelas para renegociação in-place
ALTER TABLE emprestimos ADD COLUMN parcelas   INTEGER;
ALTER TABLE emprestimos ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE emprestimos ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));