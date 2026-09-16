CREATE TABLE IF NOT EXISTS clientes_telefones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  telefone TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clientes_telefones_cliente
ON clientes_telefones(cliente_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_telefones_cliente_telefone_unique
ON clientes_telefones(cliente_id, telefone);
