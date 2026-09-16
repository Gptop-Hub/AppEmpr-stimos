CREATE TABLE IF NOT EXISTS notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,                          -- 'parcela_vence_hoje', 'parcela_atrasada', etc
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  data_referencia TEXT NOT NULL,               -- 'YYYY-MM-DD' (dia que a regra foi avaliada)
  emprestimo_id INTEGER,
  parcela_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pendente',     -- 'pendente', 'lida', 'descartada'
  criado_em TEXT DEFAULT (datetime('now')),
  lido_em TEXT,
  -- Evita criar 500 notificações iguais todo dia:
  UNIQUE (tipo, parcela_id, data_referencia)
);