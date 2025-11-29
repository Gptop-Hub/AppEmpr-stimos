// backend/models/migrations/index.js
//
// Sistema simples de migrações baseado em PRAGMA user_version.
//
// Versão 0 -> 1:
//   - Garante coluna emprestimos.capital_restante REAL
//   - Garante coluna parcelas_originais.explicacao TEXT
//   - Atualiza PRAGMA user_version = 1
//
// Se já estiver em 1 ou maior, só loga e não faz nada destrutivo.

const sqlite3 = require('sqlite3').verbose();
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

// --------- ORQUESTRADOR ---------------------------------------------------

async function runMigrations() {
  const db = openDb();

  try {
    const current = await getUserVersion(db);
    log(`user_version atual: ${current}`);

    // aqui você vai encadeando futuras migrações:
    // 0 -> 1, 1 -> 2, 2 -> 3, etc.
    if (current === 0) {
      await migrateFrom0To1(db);
    } else {
      log('Nenhuma migração necessária para esta versão.');
    }

    // Se no futuro tiver uma 1 -> 2:
    // if (current === 1) await migrateFrom1To2(db);

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