-- add_idx_clientes_cpf_unique.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_cpf_unique ON clientes (cpf);