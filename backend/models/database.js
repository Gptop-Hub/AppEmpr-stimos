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
  applyMigrationIfMissing(db, 'add_coluna_dia_pagamento.sql', 'emprestimos', 'dia_pagamento');
  applyMigrationIfMissing(db, 'add_coluna_valor_pago.sql', 'parcelas', 'valor_pago');
  applyMigrationIfMissing(db, 'add_coluna_observacao_parcelas.sql', 'parcelas', 'observacao');
  applyMigrationIfMissing(db, 'add_coluna_pago.sql', 'parcelas', 'pago');
  applyMigrationIfMissing(db, 'add_coluna_valor_excedente.sql', 'parcelas', 'valor_excedente');
  applyMigrationIfMissing(db, 'add_coluna_parcela_origem_em_pagamentos.sql', 'pagamentos', 'parcela_origem');
  applyMigrationIfMissing(db, 'capital_restante.sql', 'parcelas', 'capital_restante');
  applyMigrationIfMissing(db, 'create_table_parcelas_originais.sql', 'parcelas_originais', 'id');
  applyMigrationIfMissing(db, 'add_coluna_parcela_origem_numero.sql', 'parcelas', 'parcela_origem_numero');
  applyMigrationIfMissing(db, 'add_coluna_parcela_id.sql', 'parcelas_originais', 'parcela_id');
  applyMigrationIfMissing(db, 'add_coluna_valor_pago_parcelas_originais.sql', 'parcelas_originais', 'valor_pago');
  applyMigrationIfMissing(db, 'add_coluna_valor_excedente_parcelas_originais.sql', 'parcelas_originais', 'valor_excedente');
  applyMigrationIfMissing(db, 'add_coluna_data_pagamento_parcelas_originais.sql', 'parcelas_originais', 'data_pagamento');
  applyMigrationIfMissing(db, 'add_coluna_pago_parcelas_originais.sql', 'parcelas_originais', 'pago');

  // novas
  applyMigrationIfMissing(db, 'renegociacao.sql', 'emprestimos', 'ativo');

  // ⬇️ aqui trocamos a sentinela para 'updated_at' (antes estava 'parcelas')
  applyMigrationIfMissing(db, 'audit.sql', 'emprestimos', 'updated_at');

  // ⬇️ NOVO: migração que cria valor_emprestado / valor_atual
  applyMigrationIfMissing(db, 'valor_emprestado.sql', 'emprestimos', 'valor_emprestado');

  applyMigrationIfMissing(db, 'renegociacoes_historico.sql', 'renegociacoes_historico', 'id');
}

function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cpf TEXT,
    telefone TEXT,
    endereco TEXT,
    trabalho TEXT,
    referencia TEXT,
    observacao TEXT,
    criadoEm TEXT
  )`);

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
    saldo_devedor REAL
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
    valor_excedente REAL,
    explicacao TEXT,
    tipo_pagamento TEXT,
    capital_restante REAL,
    parcela_origem_numero INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emprestimo_id INTEGER,
    valor REAL,
    data TEXT,
    tipo_pagamento TEXT,
    observacao TEXT,
    parcela_origem INTEGER,
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

  applyMigrations(db);
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