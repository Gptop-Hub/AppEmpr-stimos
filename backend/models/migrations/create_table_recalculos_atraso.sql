CREATE TABLE IF NOT EXISTS recalculos_atraso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emprestimo_id INTEGER NOT NULL,
  parcela_destino_id INTEGER NOT NULL,
  periodos_detectados INTEGER NOT NULL DEFAULT 0,
  valor_sugerido REAL NOT NULL DEFAULT 0,
  desconto_informado REAL NOT NULL DEFAULT 0,
  valor_aplicado REAL NOT NULL DEFAULT 0,
  data_base TEXT NOT NULL,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  detalhes_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recalculos_atraso_emprestimo
  ON recalculos_atraso(emprestimo_id);

CREATE INDEX IF NOT EXISTS idx_recalculos_atraso_data_base
  ON recalculos_atraso(data_base);
