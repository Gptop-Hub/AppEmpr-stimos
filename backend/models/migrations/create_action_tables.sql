CREATE TABLE IF NOT EXISTS acoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (length(trim(tipo)) BETWEEN 1 AND 100),
  origem TEXT NOT NULL CHECK (length(trim(origem)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK (status IN ('aplicada', 'desfeita', 'falhou', 'bloqueada')),
  resumo TEXT NOT NULL DEFAULT '' CHECK (length(resumo) <= 2000),
  cliente_id INTEGER,
  emprestimo_id INTEGER,
  acao_origem_id INTEGER,
  acao_uid TEXT NOT NULL UNIQUE,
  acao_origem_uid TEXT,
  origin_device_id TEXT NOT NULL,
  origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
  metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version >= 1),
  idempotency_key TEXT,
  metadata_json TEXT,
  FOREIGN KEY (acao_origem_id) REFERENCES acoes(id) ON DELETE RESTRICT,
  FOREIGN KEY (acao_origem_uid) REFERENCES acoes(acao_uid) ON DELETE RESTRICT,
  UNIQUE (origin_device_id, origin_sequence)
);

-- Nao ha FK para cliente/emprestimo: o historico deve sobreviver a exclusoes
-- administrativas das entidades financeiras.
CREATE INDEX IF NOT EXISTS idx_acoes_created_at ON acoes(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_acoes_cliente ON acoes(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acoes_emprestimo ON acoes(emprestimo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acoes_tipo_status ON acoes(tipo, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acoes_uid ON acoes(acao_uid);
CREATE INDEX IF NOT EXISTS idx_acoes_origem_uid ON acoes(acao_origem_uid);
CREATE INDEX IF NOT EXISTS idx_acoes_ordem_estavel ON acoes(created_at DESC, origin_device_id ASC, origin_sequence DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acoes_idempotency_key
  ON acoes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS action_origin_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  origin_device_id TEXT NOT NULL UNIQUE,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS acao_entidades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acao_id INTEGER NOT NULL,
  entidade TEXT NOT NULL CHECK (length(trim(entidade)) BETWEEN 1 AND 100),
  entidade_id INTEGER NOT NULL CHECK (entidade_id > 0),
  entidade_uid TEXT,
  papel TEXT NOT NULL CHECK (length(trim(papel)) BETWEEN 1 AND 100),
  FOREIGN KEY (acao_id) REFERENCES acoes(id) ON DELETE RESTRICT,
  UNIQUE (acao_id, entidade, entidade_id, papel)
);

CREATE INDEX IF NOT EXISTS idx_acao_entidades_acao ON acao_entidades(acao_id, id);
CREATE INDEX IF NOT EXISTS idx_acao_entidades_entidade ON acao_entidades(entidade, entidade_id);

CREATE TABLE IF NOT EXISTS acao_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acao_id INTEGER NOT NULL,
  momento TEXT NOT NULL CHECK (momento IN ('antes', 'depois')),
  entidade TEXT NOT NULL CHECK (length(trim(entidade)) BETWEEN 1 AND 100),
  entidade_id INTEGER NOT NULL CHECK (entidade_id > 0),
  dados_json TEXT NOT NULL,
  FOREIGN KEY (acao_id) REFERENCES acoes(id) ON DELETE RESTRICT,
  UNIQUE (acao_id, momento, entidade, entidade_id)
);

CREATE INDEX IF NOT EXISTS idx_acao_snapshots_acao ON acao_snapshots(acao_id, momento, id);

-- O conteudo historico e imutavel. Somente a transicao explicita de uma acao
-- aplicada para um estado terminal pode atualizar o cabecalho; uma reversao
-- financeira futura continuara sendo registrada como outra linha em acoes.
CREATE TRIGGER IF NOT EXISTS trg_acoes_immutable_update
BEFORE UPDATE ON acoes
WHEN NEW.tipo IS NOT OLD.tipo
  OR NEW.origem IS NOT OLD.origem
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.resumo IS NOT OLD.resumo
  OR NEW.cliente_id IS NOT OLD.cliente_id
  OR NEW.emprestimo_id IS NOT OLD.emprestimo_id
  OR NEW.acao_origem_id IS NOT OLD.acao_origem_id
  OR NEW.acao_uid IS NOT OLD.acao_uid
  OR NEW.acao_origem_uid IS NOT OLD.acao_origem_uid
  OR NEW.origin_device_id IS NOT OLD.origin_device_id
  OR NEW.origin_sequence IS NOT OLD.origin_sequence
  OR NEW.metadata_version IS NOT OLD.metadata_version
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.metadata_json IS NOT OLD.metadata_json
  OR NOT (OLD.status = 'aplicada' AND NEW.status IN ('desfeita', 'falhou', 'bloqueada'))
BEGIN
  SELECT RAISE(ABORT, 'acoes sao imutaveis');
END;

CREATE TRIGGER IF NOT EXISTS trg_acao_entidades_immutable_update
BEFORE UPDATE ON acao_entidades
BEGIN
  SELECT RAISE(ABORT, 'acao_entidades sao imutaveis');
END;

CREATE TRIGGER IF NOT EXISTS trg_acao_snapshots_immutable_update
BEFORE UPDATE ON acao_snapshots
BEGIN
  SELECT RAISE(ABORT, 'acao_snapshots sao imutaveis');
END;
