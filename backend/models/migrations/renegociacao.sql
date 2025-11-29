-- migrations/20251110_renegociacao.sql

-- Flags de versionamento simples
ALTER TABLE emprestimos ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1;               -- 1 = vigente, 0 = arquivado
ALTER TABLE emprestimos ADD COLUMN substituido_por INTEGER;                        -- id do novo emprestimo que substituiu este
ALTER TABLE emprestimos ADD COLUMN renegociacao_de INTEGER;                        -- id do emprestimo antigo (se este for o novo)

-- Tabela de vínculo (log de renegociação)
CREATE TABLE IF NOT EXISTS renegociacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  antigo_id INTEGER NOT NULL,
  novo_id   INTEGER NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  observacao TEXT,
  FOREIGN KEY (antigo_id) REFERENCES emprestimos(id),
  FOREIGN KEY (novo_id)   REFERENCES emprestimos(id)
);