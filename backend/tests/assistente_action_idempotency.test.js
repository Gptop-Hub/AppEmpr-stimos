const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const { claimActionExecution } = require('../services/assistente/actions/actionIdempotency');

function openDatabase(file) {
  return new sqlite3.Database(file);
}

function closeDatabase(db) {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

test('idempotencia persiste o commit e bloqueia retry apos reinicio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistente-idempotency-'));
  const file = path.join(dir, 'fixture.db');
  let db = openDatabase(file);
  try {
    await runAsync(db, 'CREATE TABLE efeito_financeiro (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)');
    await runAsync(db, 'INSERT INTO efeito_financeiro (id, total) VALUES (1, 0)');

    await runAsync(db, 'BEGIN IMMEDIATE');
    await claimActionExecution(db, { key: 'token-hash-persistente', action: 'registrar_pagamento', emprestimoId: 10 });
    await runAsync(db, 'UPDATE efeito_financeiro SET total = total + 1 WHERE id = 1');
    await runAsync(db, 'COMMIT');
    await closeDatabase(db);

    db = openDatabase(file);
    await runAsync(db, 'BEGIN IMMEDIATE');
    await assert.rejects(
      () => claimActionExecution(db, { key: 'token-hash-persistente', action: 'registrar_pagamento', emprestimoId: 10 }),
      { code: 'action_already_processed' }
    );
    await runAsync(db, 'ROLLBACK');
    assert.equal((await getAsync(db, 'SELECT total FROM efeito_financeiro WHERE id = 1')).total, 1);
  } finally {
    if (db) await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotencia acompanha o rollback da transacao financeira', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistente-idempotency-'));
  const file = path.join(dir, 'fixture.db');
  const db = openDatabase(file);
  try {
    await runAsync(db, 'BEGIN IMMEDIATE');
    await claimActionExecution(db, { key: 'token-hash-rollback', action: 'quitar_emprestimo', emprestimoId: 10 });
    await runAsync(db, 'ROLLBACK');

    await runAsync(db, 'BEGIN IMMEDIATE');
    await claimActionExecution(db, { key: 'token-hash-rollback', action: 'quitar_emprestimo', emprestimoId: 10 });
    await runAsync(db, 'COMMIT');
  } finally {
    await closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
