// backend/models/migrations/index.js
//
// Sistema simples de migrações baseado em PRAGMA user_version.
//
// Versão 0 -> 1:
//   - Garante coluna emprestimos.capital_restante REAL
//   - Garante coluna parcelas_originais.explicacao TEXT
//   - Atualiza PRAGMA user_version = 1
//
// Extra (sempre que rodar):
//   - Garante a existência da tabela notificacoes (CREATE TABLE IF NOT EXISTS)
//
// Se já estiver em 1 ou maior, só loga e não faz nada destrutivo.

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const paths = require('../../utils/paths'); // saindo de models/migrations -> utils

function log(msg) {
  console.log('[migrations]', msg);
}

function openDb() {
  const dbPath = paths.getDbPath();
  log(`Usando DB em: ${dbPath}`);
  return new sqlite3.Database(dbPath);
}

function getUserVersion(db) {
  return new Promise((resolve, reject) => {
    db.get('PRAGMA user_version;', (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.user_version || 0 : 0);
    });
  });
}

function setUserVersion(db, version) {
  return new Promise((resolve, reject) => {
    db.run(`PRAGMA user_version = ${Number(version) || 0};`, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function columnExists(db, table, column) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table});`, (err, rows) => {
      if (err) return reject(err);
      const found = (rows || []).some((r) => r.name === column);
      resolve(found);
    });
  });
}

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function runSqlFileIfExists(db, fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    log(`Arquivo de migracao nao encontrado: ${fileName}. Ignorando.`);
    return;
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  if (!String(sql || '').trim()) {
    log(`Arquivo de migracao vazio: ${fileName}. Ignorando.`);
    return;
  }

  await runSql(db, sql);
  log(`Migracao aplicada via arquivo: ${fileName}`);
}

// --------- MIGRAÇÃO 0 -> 1 -----------------------------------------------

async function migrateFrom0To1(db) {
  log('Iniciando migração 0 -> 1…');

  // 1) emprestimos.capital_restante REAL
  const hasCapitalRest = await columnExists(db, 'emprestimos', 'capital_restante');
  if (!hasCapitalRest) {
    log('Adicionando coluna emprestimos.capital_restante…');
    await runSql(db, 'ALTER TABLE emprestimos ADD COLUMN capital_restante REAL;');
  } else {
    log('Coluna emprestimos.capital_restante já existe, ok.');
  }

  // 2) parcelas_originais.explicacao TEXT
  const hasExp = await columnExists(db, 'parcelas_originais', 'explicacao');
  if (!hasExp) {
    log('Adicionando coluna parcelas_originais.explicacao…');
    await runSql(db, 'ALTER TABLE parcelas_originais ADD COLUMN explicacao TEXT;');
  } else {
    log('Coluna parcelas_originais.explicacao já existe, ok.');
  }

  // 3) Atualiza user_version
  await setUserVersion(db, 1);
  log('Migração 0 -> 1 concluída. user_version agora = 1.');
}

// --------- TABELA DE NOTIFICAÇÕES (sempre garantir) -----------------------

async function ensureNotificacoesTable(db) {
  log('Garantindo tabela notificacoes…');

  // Aqui não precisa nem checar: CREATE TABLE IF NOT EXISTS já é seguro.
  const sql = `
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
  `;

  await runSql(db, sql);
  log('Tabela notificacoes OK.');
}

async function ensureClienteCobrancaColumns(db) {
  const hasReceber = await columnExists(db, 'clientes', 'receber_notificacoes_cobranca');
  if (!hasReceber) {
    await runSqlFileIfExists(db, 'add_coluna_receber_notificacoes_cobranca_clientes.sql');
  }

  const hasMotivo = await columnExists(db, 'clientes', 'motivo_notificacoes_cobranca');
  if (!hasMotivo) {
    await runSqlFileIfExists(db, 'add_coluna_motivo_notificacoes_cobranca_clientes.sql');
  }
}

// --------- ORQUESTRADOR ---------------------------------------------------

async function runMigrations() {
  const db = openDb();

  try {
    const current = await getUserVersion(db);
    log(`user_version atual: ${current}`);

    // 0 -> 1 (primeira vez)
    if (current === 0) {
      await migrateFrom0To1(db);
    } else {
      log('Nenhuma migração 0->1 necessária para esta versão.');
    }

    // Sempre garante a tabela de notificações (independente da versão)
    await ensureNotificacoesTable(db);
    await ensureClienteCobrancaColumns(db);
    await runSqlFileIfExists(db, 'add_relatorios_indexes.sql');

  } catch (err) {
    log(`ERRO nas migrações: ${err && err.message || err}`);
    throw err;
  } finally {
    db.close();
  }
}

module.exports = {
  runMigrations,
};
