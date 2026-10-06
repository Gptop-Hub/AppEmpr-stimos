const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const { ensureEntityIdentityV1 } = require('../services/entityIdentityService');
const actions = require('../services/actionService');
const { createBackupBundle, extractBackupBundle } = require('../services/backupBundleService');

const actionMigration = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-identity-'));
  const dbPath = path.join(directory, 'fixture.db');
  const db = new sqlite3.Database(dbPath);
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT);
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, valor REAL);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER);
    INSERT INTO clientes VALUES (1, 'Antigo');
    INSERT INTO emprestimos VALUES (10, 1, 100);
    INSERT INTO parcelas VALUES (100, 10, 1);
  `, (error) => error ? reject(error) : resolve()));
  return { db, dbPath, directory, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('migration preenche UIDs legados uma vez e trigger atribui UIDs aos novos registros', async () => {
  const f = await fixture();
  try {
    await ensureEntityIdentityV1(f.db);
    const before = await Promise.all([
      getAsync(f.db, 'SELECT cliente_uid FROM clientes WHERE id=1'),
      getAsync(f.db, 'SELECT emprestimo_uid FROM emprestimos WHERE id=10'),
      getAsync(f.db, 'SELECT parcela_uid FROM parcelas WHERE id=100'),
    ]);
    for (const row of before) assert.match(Object.values(row)[0], UUID_RE);
    await ensureEntityIdentityV1(f.db);
    const after = await Promise.all([
      getAsync(f.db, 'SELECT cliente_uid FROM clientes WHERE id=1'),
      getAsync(f.db, 'SELECT emprestimo_uid FROM emprestimos WHERE id=10'),
      getAsync(f.db, 'SELECT parcela_uid FROM parcelas WHERE id=100'),
    ]);
    assert.deepEqual(after, before);

    await runAsync(f.db, "INSERT INTO clientes (id,nome) VALUES (2,'Novo')");
    await runAsync(f.db, 'INSERT INTO emprestimos (id,cliente_id,valor) VALUES (20,2,200)');
    await runAsync(f.db, 'INSERT INTO parcelas (id,emprestimo_id,numero) VALUES (200,20,1)');
    const uids = await allAsync(f.db, `SELECT cliente_uid AS uid FROM clientes
      UNION ALL SELECT emprestimo_uid FROM emprestimos
      UNION ALL SELECT parcela_uid FROM parcelas`);
    assert.equal(uids.length, 6);
    assert.equal(new Set(uids.map((row) => row.uid)).size, 6);
    assert.ok(uids.every((row) => UUID_RE.test(row.uid)));
  } finally { await f.close(); }
});

test('rollback não deixa entidade ou UID parcial e ações guardam UID transportável', async () => {
  const f = await fixture();
  try {
    await ensureEntityIdentityV1(f.db);
    await runAsync(f.db, 'BEGIN IMMEDIATE');
    await runAsync(f.db, "INSERT INTO clientes (id,nome) VALUES (2,'Rollback')");
    await runAsync(f.db, 'ROLLBACK');
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM clientes WHERE id=2')).total, 0);

    await new Promise((resolve, reject) => f.db.exec(actionMigration, (error) => error ? reject(error) : resolve()));
    const action = await actions.iniciarAcao({ tipo: 'uid_teste', origem: 'teste', resumo: 'UID' }, { dbHandle: f.db });
    await actions.registrarEntidade(action, { entidade: 'cliente', entidade_id: 1, papel: 'afetado' });
    await actions.registrarEntidade(action, { entidade: 'emprestimo', entidade_id: 10, papel: 'afetado' });
    await actions.registrarEntidade(action, { entidade: 'parcela', entidade_id: 100, papel: 'afetada' });
    await actions.finalizarAcaoAplicada(action);
    const entities = await allAsync(f.db, 'SELECT entidade, entidade_uid FROM acao_entidades WHERE acao_id = ? ORDER BY entidade', [action.actionId]);
    assert.deepEqual(entities, [
      { entidade: 'cliente', entidade_uid: (await getAsync(f.db, 'SELECT cliente_uid FROM clientes WHERE id=1')).cliente_uid },
      { entidade: 'emprestimo', entidade_uid: (await getAsync(f.db, 'SELECT emprestimo_uid FROM emprestimos WHERE id=10')).emprestimo_uid },
      { entidade: 'parcela', entidade_uid: (await getAsync(f.db, 'SELECT parcela_uid FROM parcelas WHERE id=100')).parcela_uid },
    ]);
  } finally { await f.close(); }
});

test('backup e restauração SQLite preservam UIDs sem reescrita', async () => {
  const f = await fixture();
  try {
    await ensureEntityIdentityV1(f.db);
    const original = await getAsync(f.db, 'SELECT cliente_uid FROM clientes WHERE id=1');
    const photos = path.join(f.directory, 'photos');
    fs.mkdirSync(photos);
    const bundle = path.join(f.directory, 'backup.emprestimos-backup');
    await createBackupBundle({ dbPath: f.dbPath, clientPhotosDir: photos, outputPath: bundle });
    const restored = await extractBackupBundle({ backupPath: bundle, destinationDir: path.join(f.directory, 'restore') });
    const restoredDb = new sqlite3.Database(restored.dbPath);
    assert.equal((await getAsync(restoredDb, 'SELECT cliente_uid FROM clientes WHERE id=1')).cliente_uid, original.cliente_uid);
    await new Promise((resolve) => restoredDb.close(resolve));
  } finally { await f.close(); }
});
