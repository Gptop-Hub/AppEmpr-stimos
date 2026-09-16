CREATE TABLE IF NOT EXISTS caixa_movimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA', 'SAIDA')),
  categoria TEXT NOT NULL CHECK (categoria IN ('PAGAMENTO', 'EMPRESTIMO', 'DESPESA')),
  data TEXT NOT NULL,
  cliente_id INTEGER NULL,
  cliente_nome TEXT NULL,
  emprestimo_id INTEGER NULL,
  parcela_id INTEGER NULL,
  parcela_numero INTEGER NULL,
  data_vencimento TEXT NULL,
  data_pagamento TEXT NULL,
  valor_total REAL NOT NULL DEFAULT 0,
  valor_juros REAL NOT NULL DEFAULT 0,
  valor_capital REAL NOT NULL DEFAULT 0,
  valor_emprestimo REAL NOT NULL DEFAULT 0,
  valor_despesa REAL NOT NULL DEFAULT 0,
  descricao TEXT NULL,
  meta_json TEXT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_data ON caixa_movimentos (data);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_categoria ON caixa_movimentos (categoria);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_emprestimo ON caixa_movimentos (emprestimo_id);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_cliente ON caixa_movimentos (cliente_id);
