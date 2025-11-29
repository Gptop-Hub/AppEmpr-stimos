CREATE TABLE IF NOT EXISTS renegociacoes_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emprestimo_id INTEGER NOT NULL,
  versao INTEGER NOT NULL,
  snapshot_emprestimo TEXT NOT NULL,
  snapshot_parcelas   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id)
);

CREATE INDEX IF NOT EXISTS idx_hist_emprestimo_id
  ON renegociacoes_historico(emprestimo_id);