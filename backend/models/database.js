const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { getDbPath } = require('../utils/paths');

const log = (...args) => console.info('[database]', ...args);

let currentDb = null;

function escapeIdentifier(identifier) {
  return String(identifier).replace(/"/g, '""');
}

function columnExists(db, table, column, callback) {
  const tableEscaped = escapeIdentifier(table);
  db.all(`PRAGMA table_info("${tableEscaped}");`, (err, rows) => {
    if (err) {
      log(`Error checking column ${table}.${column}: ${err.message}`);
      callback(false);
      return;
    }
    const exists = Array.isArray(rows) && rows.some((col) => col && col.name === column);
    callback(exists);
  });
}

function applyMigrationIfMissing(db, file, table, column) {
  // Aponta para backend/models/migrations
  const migrationsDir = path.resolve(__dirname, './migrations');
  const migrationPath = path.join(migrationsDir, file);

  if (!fs.existsSync(migrationPath)) {
    log(`Migration file not found (${file}). Skipping.`);
    return;
  }

  const sql = fs.readFileSync(migrationPath, 'utf8');
  columnExists(db, table, column, (exists) => {
    if (exists) {
      log(`Column ${table}.${column} already present. Ignoring ${file}.`);
      return;
    }

    db.exec(sql, (err) => {
      if (err) {
        const message = String(err && err.message ? err.message : err);
        const lower = message.toLowerCase();
        if (lower.includes('duplicate column') || lower.includes('already exists')) {
          log(`Migration ${file} skipped because column already exists (${column}).`);
          return;
        }
        console.error(`[database] Migration ${file} failed: ${message}`);
        return;
      }
      log(`Migration applied: ${file}`);
    });
  });
}

function applyMigrations(db) {
  // antigas
  applyMigrationIfMissing(db, 'add_coluna_data_pagamento.sql', 'parcelas', 'data_pagamento');
  applyMigrationIfMissing(db, 'add_coluna_juros_adicionais.sql', 'parcelas', 'juros_adicionais');
  applyMigrationIfMissing(db, 'add_coluna_juros_pendentes.sql', 'parcelas', 'juros_pendentes');
  applyMigrationIfMissing(db, 'add_coluna_dia_pagamento.sql', 'emprestimos', 'dia_pagamento');
  applyMigrationIfMissing(db, 'add_coluna_valor_pago.sql', 'parcelas', 'valor_pago');
  applyMigrationIfMissing(db, 'add_coluna_observacao_parcelas.sql', 'parcelas', 'observacao');
  applyMigrationIfMissing(db, 'add_coluna_pago.sql', 'parcelas', 'pago');
  applyMigrationIfMissing(db, 'add_coluna_valor_excedente.sql', 'parcelas', 'valor_excedente');
  applyMigrationIfMissing(db, 'add_coluna_parcela_origem_em_pagamentos.sql', 'pagamentos', 'parcela_origem');
  applyMigrationIfMissing(
    db,
    'add_coluna_renegociacao_id_pagamentos.sql',
    'pagamentos',
    'renegociacao_id'
  );
  applyMigrationIfMissing(db, 'capital_restante.sql', 'parcelas', 'capital_restante');
  applyMigrationIfMissing(db, 'add_coluna_versao_parcelas.sql', 'parcelas', 'versao');
  applyMigrationIfMissing(db, 'create_table_parcelas_originais.sql', 'parcelas_originais', 'id');
  applyMigrationIfMissing(db, 'add_coluna_parcela_origem_numero.sql', 'parcelas', 'parcela_origem_numero');
  applyMigrationIfMissing(db, 'add_coluna_parcela_id.sql', 'parcelas_originais', 'parcela_id');
  applyMigrationIfMissing(db, 'add_coluna_valor_pago_parcelas_originais.sql', 'parcelas_originais', 'valor_pago');
  applyMigrationIfMissing(db, 'add_coluna_valor_excedente_parcelas_originais.sql', 'parcelas_originais', 'valor_excedente');
  applyMigrationIfMissing(db, 'add_coluna_data_pagamento_parcelas_originais.sql', 'parcelas_originais', 'data_pagamento');
  applyMigrationIfMissing(db, 'add_coluna_pago_parcelas_originais.sql', 'parcelas_originais', 'pago');

  // novas
  applyMigrationIfMissing(db, 'renegociacao.sql', 'emprestimos', 'ativo');
  applyMigrationIfMissing(db, 'add_coluna_versao_atual_emprestimos.sql', 'emprestimos', 'versao_atual');

  // ⬇️ aqui trocamos a sentinela para 'updated_at' (antes estava 'parcelas')
  applyMigrationIfMissing(db, 'audit.sql', 'emprestimos', 'updated_at');

  // ⬇️ NOVO: migração que cria valor_emprestado / valor_atual
  applyMigrationIfMissing(db, 'valor_emprestado.sql', 'emprestimos', 'valor_emprestado');

  // last_activity_at para ordenação "Último trabalhado"
  applyMigrationIfMissing(db, 'add_last_activity_at_clientes.sql', 'clientes', 'last_activity_at');
  applyMigrationIfMissing(db, 'add_last_activity_at_emprestimos.sql', 'emprestimos', 'last_activity_at');
  applyMigrationIfMissing(db, 'add_coluna_categoria_trabalho_clientes.sql', 'clientes', 'categoria_trabalho');
  applyMigrationIfMissing(db, 'add_coluna_mal_pagador_clientes.sql', 'clientes', 'mal_pagador');
  applyMigrationIfMissing(db, 'add_coluna_receber_notificacoes_cobranca_clientes.sql', 'clientes', 'receber_notificacoes_cobranca');
  applyMigrationIfMissing(db, 'add_coluna_motivo_notificacoes_cobranca_clientes.sql', 'clientes', 'motivo_notificacoes_cobranca');
  applyMigrationIfMissing(db, 'add_foto_cliente_clientes.sql', 'clientes', 'foto_cliente');
  applyMigrationIfMissing(db, 'create_table_clientes_telefones.sql', 'clientes_telefones', 'id');

  applyMigrationIfMissing(db, 'renegociacoes_historico.sql', 'renegociacoes_historico', 'id');
  applyMigrationIfMissing(db, 'add_colunas_renegociacoes_historico.sql', 'renegociacoes_historico', 'tipo');
  applyMigrationIfMissing(db, 'create_table_caixa_movimentos.sql', 'caixa_movimentos', 'id');
  applyMigrationIfMissing(db, 'create_table_recalculos_atraso.sql', 'recalculos_atraso', 'id');
  applyMigrationIfMissing(
    db,
    'create_table_assistant_cost_interactions.sql',
    'assistant_cost_interactions',
    'id'
  );
  applyMigrationIfMissing(
    db,
    'create_table_assistant_cost_settings.sql',
    'assistant_cost_settings',
    'id'
  );
}

function backfillJurosPendentes(db) {
  columnExists(db, 'parcelas', 'juros_pendentes', (hasPendentes) => {
    if (!hasPendentes) return;
    columnExists(db, 'parcelas', 'juros_adicionais', (hasAdic) => {
      if (!hasAdic) return;
      db.run(
        `
        UPDATE parcelas
        SET juros_pendentes = COALESCE(juros_adicionais, 0)
        WHERE (juros_pendentes IS NULL OR juros_pendentes = 0)
          AND COALESCE(juros_adicionais, 0) != 0
        `,
        (err) => {
          if (err) {
            log(`Backfill juros_pendentes failed: ${err.message}`);
          }
        }
      );
    });
  });
}

function sanitizeDataPagamentoParcelas(db) {
  db.run(
    `
    UPDATE parcelas
       SET data_pagamento = NULL
     WHERE (data_pagamento IS NOT NULL AND TRIM(COALESCE(data_pagamento, '')) != '')
       AND COALESCE(pago, 0) = 0
       AND COALESCE(valor_pago, 0) <= 0
    `,
    (err) => {
      if (err) {
        log(`Sanitize data_pagamento failed: ${err.message}`);
      }
    }
  );
}

function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cpf TEXT,
    telefone TEXT,
    endereco TEXT,
    trabalho TEXT,
    categoria_trabalho TEXT,
    mal_pagador INTEGER DEFAULT 0,
    receber_notificacoes_cobranca INTEGER NOT NULL DEFAULT 1,
    motivo_notificacoes_cobranca TEXT,
    foto_cliente TEXT,
    referencia TEXT,
    observacao TEXT,
    criadoEm TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clientes_telefones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    telefone TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
  )`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_clientes_telefones_cliente
     ON clientes_telefones(cliente_id)`
  );
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_telefones_cliente_telefone_unique
     ON clientes_telefones(cliente_id, telefone)`
  );

  // 👇 ATUALIZADO: inclui valor_emprestado, valor_atual,
  // e já deixa capital_restante / saldo_devedor para bancos novos
  db.run(`CREATE TABLE IF NOT EXISTS emprestimos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER,
    codigo_cliente TEXT,
    valor REAL,
    valor_emprestado REAL,
    valor_atual REAL,
    data TEXT,
    modalidade TEXT,
    taxa_juros REAL,
    observacao TEXT,
    dia_pagamento INTEGER,
    capital_restante REAL,
    saldo_devedor REAL,
    versao_atual INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emprestimo_id INTEGER,
    numero INTEGER,
    valor_total REAL,
    valor_capital REAL,
    valor_juros REAL,
    vencimento TEXT,
    pago INTEGER,
    observacao TEXT,
    valor_pago REAL,
    data_pagamento TEXT,
    juros_adicionais REAL,
    juros_pendentes REAL,
    valor_excedente REAL,
    explicacao TEXT,
    tipo_pagamento TEXT,
    capital_restante REAL,
    parcela_origem_numero INTEGER,
    versao INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emprestimo_id INTEGER,
    valor REAL,
    data TEXT,
    tipo_pagamento TEXT,
    observacao TEXT,
    parcela_origem INTEGER,
    renegociacao_id INTEGER,
    FOREIGN KEY (emprestimo_id) REFERENCES emprestimos(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parcelas_originais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parcela_id INTEGER,
    emprestimo_id INTEGER,
    numero INTEGER,
    valor_total REAL,
    valor_capital REAL,
    valor_juros REAL,
    valor_pago REAL,
    valor_excedente REAL,
    pago INTEGER,
    data_pagamento TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS caixa_movimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    categoria TEXT NOT NULL,
    data TEXT NOT NULL,
    cliente_id INTEGER,
    cliente_nome TEXT,
    emprestimo_id INTEGER,
    parcela_id INTEGER,
    parcela_numero INTEGER,
    data_vencimento TEXT,
    data_pagamento TEXT,
    valor_total REAL NOT NULL DEFAULT 0,
    valor_juros REAL NOT NULL DEFAULT 0,
    valor_capital REAL NOT NULL DEFAULT 0,
    valor_emprestimo REAL NOT NULL DEFAULT 0,
    valor_despesa REAL NOT NULL DEFAULT 0,
    descricao TEXT,
    meta_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_data ON caixa_movimentos(data)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_categoria ON caixa_movimentos(categoria)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_emprestimo ON caixa_movimentos(emprestimo_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_cliente ON caixa_movimentos(cliente_id)`);

  db.run(`CREATE TABLE IF NOT EXISTS recalculos_atraso (
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
  )`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_recalculos_atraso_emprestimo
     ON recalculos_atraso(emprestimo_id)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_recalculos_atraso_data_base
     ON recalculos_atraso(data_base)`
  );

  db.run(`CREATE TABLE IF NOT EXISTS assistant_cost_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL UNIQUE,
    stt_usage_json TEXT,
    llm_planning_usage_json TEXT,
    llm_answer_usage_json TEXT,
    tts_estimated_cost REAL NOT NULL DEFAULT 0,
    interaction_total_estimated_usd REAL NOT NULL DEFAULT 0,
    cost_source TEXT NOT NULL DEFAULT 'api_usage+fallback',
    cost_mode TEXT NOT NULL DEFAULT 'estimated',
    user_credit_balance REAL,
    balance_source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_assistant_cost_interactions_session
     ON assistant_cost_interactions(session_id)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_assistant_cost_interactions_created_at
     ON assistant_cost_interactions(created_at)`
  );

  db.run(`CREATE TABLE IF NOT EXISTS assistant_cost_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_credit_balance REAL NOT NULL DEFAULT 0,
    balance_source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS assistant_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    feedback TEXT NOT NULL,
    route TEXT,
    note TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_assistant_feedback_session
     ON assistant_feedback(session_id, created_at DESC)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_assistant_feedback_turn
     ON assistant_feedback(turn_id, created_at DESC)`
  );

  applyMigrations(db);
  backfillJurosPendentes(db);
  sanitizeDataPagamentoParcelas(db);
}

function configureConnection(db) {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON;', (err) => {
      if (err) {
        log(`PRAGMA foreign_keys error: ${err.message}`);
      } else {
        log('PRAGMA foreign_keys=ON');
      }
    });

    db.get('PRAGMA journal_mode = WAL;', (err, row) => {
      if (err) {
        log(`PRAGMA journal_mode=WAL error: ${err.message}`);
      } else {
        const mode = row && (row.journal_mode || row['journal_mode']);
        log(`PRAGMA journal_mode=WAL -> ${mode || JSON.stringify(row) || 'unknown'}`);
      }
    });

    ensureSchema(db);
  });

  log(`Database ready at ${getDbPath()}`);
}

function openConnection() {
  if (currentDb) {
    return currentDb;
  }

  const dbPath = getDbPath();
  log(`Opening SQLite database at ${dbPath}`);

  currentDb = new sqlite3.Database(
    dbPath,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    (err) => {
      if (err) {
        log(`Failed to open database: ${err.message}`);
      } else {
        log('SQLite handle acquired');
      }
    }
  );

  configureConnection(currentDb);
  return currentDb;
}

function getConnection() {
  return openConnection();
}

function closeConnection() {
  return new Promise((resolve, reject) => {
    if (!currentDb) {
      resolve();
      return;
    }

    const dbToClose = currentDb;
    dbToClose.close((err) => {
      if (err) {
        log(`Error closing SQLite: ${err.message}`);
        reject(err);
        return;
      }
      if (currentDb === dbToClose) {
        currentDb = null;
      }
      log('SQLite connection closed');
      resolve();
    });
  });
}

async function reopenConnection() {
  await closeConnection();
  openConnection();
  return currentDb;
}

function getCurrentDbPath() {
  return getDbPath();
}

openConnection();

const dbProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'closeConnection') return closeConnection;
      if (prop === 'reopenConnection') return reopenConnection;
      if (prop === 'getConnection') return getConnection;
      if (prop === 'getDbPath') return getCurrentDbPath;

      const conn = getConnection();
      const value = conn[prop];
      if (typeof value === 'function') return value.bind(conn);
      return value;
    },
  }
);

module.exports = dbProxy;
