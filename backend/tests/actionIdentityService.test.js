const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

const { allAsync, getAsync, runAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');
const { ensureActionContractV1 } = require('../services/actionIdentityService');
const { createBackupBundle, extractBackupBundle } = require('../services/backupBundleService');

const v1Schema = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'),
  'utf8'
);

const phase1Schema = `
  CREATE TABLE acoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL, origem TEXT NOT NULL, created_at TEXT NOT NULL,
    status TEXT NOT NULL, resumo TEXT NOT NULL, cliente_id INTEGER,
    emprestimo_id INTEGER, acao_origem_id INTEGER, idempotency_key TEXT,
    metadata_json TEXT, FOREIGN KEY (acao_origem_id) REFERENCES acoes(id)
  );
  CREATE TABLE acao_entidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, acao_id INTEGER NOT NULL,
    entidade TEXT NOT NULL, entidade_id INTEGER NOT NULL, papel TEXT NOT NULL,
    FOREIGN KEY (acao_id) REFERENCES acoes(id)
  );
  CREATE TABLE acao_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, acao_id INTEGER NOT NULL,
    momento TEXT NOT NULL, entidade TEXT NOT NULL, entidade_id INTEGER NOT NULL,
    dados_json TEXT NOT NULL, FOREIGN KEY (acao_id) REFERENCES acoes(id)
  );
`;

async function createFixture(schema = v1Schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'action-identity-'));
  const dbPath = path.join(directory, 'fixture.db');
  const db = new sqlite3.Database(dbPath);
  await new Promise((resolve, reject) => db.exec(schema, (error) => error ? reject(error) : resolve()));
  return {
    db,
    directory,
    dbPath,
    async close() {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function createPhase1FixtureWithActions() {
  const fixture = await createFixture(phase1Schema);
  await runAsync(
    fixture.db,
    `INSERT INTO acoes
      (id, tipo, origem, created_at, status, resumo, cliente_id, emprestimo_id, metadata_json)
     VALUES (1, 'reagendamento_parcela', 'interface', '2026-01-01 09:00:00', 'aplicada', 'Primeira', 3, 7, '{"antes":true}')`
  );
  await runAsync(
    fixture.db,
    `INSERT INTO acoes
      (id, tipo, origem, created_at, status, resumo, cliente_id, emprestimo_id, acao_origem_id, metadata_json)
     VALUES (2, 'despesa_excluida', 'interface', '2026-01-02 09:00:00', 'aplicada', 'Segunda', 3, 7, 1, '{"depois":true}')`
  );
  await runAsync(
    fixture.db,
    `INSERT INTO acao_snapshots (acao_id, momento, entidade, entidade_id, dados_json)
     VALUES (1, 'antes', 'parcela', 41, '{"valor":10.25,"vencimento":"2026-01-01"}')`
  );
  await runAsync(
    fixture.db,
    `INSERT INTO acao_entidades (acao_id, entidade, entidade_id, papel)
     VALUES (2, 'caixa_movimentos', 9, 'excluida')`
  );
  return fixture;
}

test('banco novo recebe o contrato V1 e a primeira acao ganha identidade automaticamente', async () => {
  const fixture = await createFixture();
  try {
    await ensureActionContractV1(fixture.db);
    const state = await getAsync(fixture.db, 'SELECT * FROM action_origin_state WHERE id = 1');
    assert.match(state.origin_device_id, /^[0-9a-f-]{36}$/i);
    assert.equal(state.next_sequence, 1);

    const context = await actions.iniciarAcao(
      { tipo: 'despesa_criada', origem: 'interface', resumo: 'Despesa criada' },
      { dbHandle: fixture.db }
    );
    const action = await actions.buscarAcaoPorUid(context.acaoUid, { dbHandle: fixture.db });
    assert.equal(action.id, context.actionId);
    assert.equal(action.origin_device_id, state.origin_device_id);
    assert.equal(action.origin_sequence, 1);
    assert.equal(action.metadata_version, 1);
    assert.match(action.acao_uid, /^[0-9a-f-]{36}$/i);
  } finally {
    await fixture.close();
  }
});

test('migration Fase 1/Fase 2A preserva acoes, snapshots e cria UIDs estaveis em ordem historica', async () => {
  const fixture = await createPhase1FixtureWithActions();
  try {
    await runAsync(fixture.db, 'PRAGMA foreign_keys = ON');
    await ensureActionContractV1(fixture.db);
    const migrated = await allAsync(
      fixture.db,
      'SELECT id, tipo, acao_uid, acao_origem_uid, origin_device_id, origin_sequence, metadata_version, metadata_json FROM acoes ORDER BY id'
    );
    assert.equal(migrated.length, 2);
    assert.deepEqual(migrated.map((row) => row.tipo), ['reagendamento_parcela', 'despesa_excluida']);
    assert.equal(migrated[0].origin_sequence, 1);
    assert.equal(migrated[1].origin_sequence, 2);
    assert.equal(migrated[0].origin_device_id, migrated[1].origin_device_id);
    assert.equal(migrated[1].acao_origem_uid, migrated[0].acao_uid);
    assert.equal(migrated[0].metadata_version, 1);
    assert.equal(migrated[0].metadata_json, '{"antes":true}');
    assert.equal(
      (await getAsync(fixture.db, 'SELECT dados_json FROM acao_snapshots WHERE acao_id = 1')).dados_json,
      '{"valor":10.25,"vencimento":"2026-01-01"}'
    );
    assert.deepEqual(await allAsync(fixture.db, 'PRAGMA foreign_key_check'), []);

    const beforeRepeat = migrated.map((row) => [row.acao_uid, row.origin_device_id, row.origin_sequence]);
    await ensureActionContractV1(fixture.db);
    const afterRepeat = await allAsync(
      fixture.db,
      'SELECT acao_uid, origin_device_id, origin_sequence FROM acoes ORDER BY id'
    );
    assert.deepEqual(afterRepeat.map((row) => [row.acao_uid, row.origin_device_id, row.origin_sequence]), beforeRepeat);
  } finally {
    await fixture.close();
  }
});

test('sequencia e transacional: rollback devolve a reserva e a proxima acao reutiliza a sequencia', async () => {
  const fixture = await createFixture();
  try {
    await ensureActionContractV1(fixture.db);
    await runAsync(fixture.db, 'BEGIN IMMEDIATE');
    const reverted = await actions.iniciarAcao(
      { tipo: 'reagendamento_cascata', origem: 'interface', resumo: 'Sera revertida' },
      { dbHandle: fixture.db }
    );
    await runAsync(fixture.db, 'ROLLBACK');
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);

    const committed = await actions.iniciarAcao(
      { tipo: 'reagendamento_cascata', origem: 'interface', resumo: 'Persistida' },
      { dbHandle: fixture.db }
    );
    assert.equal(reverted.originSequence, committed.originSequence);

    const next = await actions.iniciarAcao(
      { tipo: 'alteracao_dia_vencimento', origem: 'interface', resumo: 'Seguinte' },
      { dbHandle: fixture.db }
    );
    assert.equal(next.originSequence, committed.originSequence + 1);
  } finally {
    await fixture.close();
  }
});

test('acao de origem transportavel e busca por UID preservam a referencia local legada', async () => {
  const fixture = await createFixture();
  try {
    await ensureActionContractV1(fixture.db);
    const origin = await actions.iniciarAcao(
      { tipo: 'despesa_criada', origem: 'interface', resumo: 'Origem' },
      { dbHandle: fixture.db }
    );
    const reversal = await actions.iniciarAcao(
      { tipo: 'despesa_excluida', origem: 'interface', resumo: 'Compensacao', acao_origem_uid: origin.acaoUid },
      { dbHandle: fixture.db }
    );
    const reversalAction = await actions.buscarAcaoPorUid(reversal.acaoUid, { dbHandle: fixture.db });
    assert.equal(reversalAction.acao_origem_uid, origin.acaoUid);
    assert.equal(reversalAction.acao_origem_id, null);
    assert.equal((await actions.resolverAcaoOrigemUid(reversal.acaoUid, { dbHandle: fixture.db })).id, origin.actionId);

    await assert.rejects(
      () => runAsync(
        fixture.db,
        `INSERT INTO acoes
          (acao_uid, origin_device_id, origin_sequence, metadata_version, tipo, origem, status, resumo)
         SELECT acao_uid, origin_device_id, origin_sequence + 100, metadata_version, tipo, origem, status, resumo
           FROM acoes WHERE id = ?`,
        [origin.actionId]
      ),
      /UNIQUE/
    );
  } finally {
    await fixture.close();
  }
});

test('backup/restauracao SQLite preserva UIDs, estado do dispositivo e sequencia', async () => {
  const fixture = await createFixture();
  try {
    await ensureActionContractV1(fixture.db);
    const action = await actions.iniciarAcao(
      { tipo: 'reagendamento_parcela', origem: 'interface', resumo: 'Para backup' },
      { dbHandle: fixture.db }
    );
    const expectedAction = await getAsync(fixture.db, 'SELECT acao_uid, origin_device_id, origin_sequence FROM acoes WHERE id = ?', [action.actionId]);
    const expectedState = await getAsync(fixture.db, 'SELECT origin_device_id, next_sequence FROM action_origin_state WHERE id = 1');
    const photos = path.join(fixture.directory, 'photos');
    fs.mkdirSync(photos);
    const bundle = path.join(fixture.directory, 'backup.emprestimos-backup');
    await createBackupBundle({ dbPath: fixture.dbPath, clientPhotosDir: photos, outputPath: bundle });
    const restored = await extractBackupBundle({ backupPath: bundle, destinationDir: path.join(fixture.directory, 'restored') });
    const restoredDb = new sqlite3.Database(restored.dbPath);
    try {
      assert.deepEqual(
        await getAsync(restoredDb, 'SELECT acao_uid, origin_device_id, origin_sequence FROM acoes WHERE id = ?', [action.actionId]),
        expectedAction
      );
      assert.deepEqual(
        await getAsync(restoredDb, 'SELECT origin_device_id, next_sequence FROM action_origin_state WHERE id = 1'),
        expectedState
      );
    } finally {
      await new Promise((resolve) => restoredDb.close(resolve));
    }
  } finally {
    await fixture.close();
  }
});

test('banco legado sem tabelas de acoes continua apto a receber o schema V1 sem criar acoes historicas', async () => {
  const fixture = await createFixture('CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT);');
  try {
    assert.deepEqual(await ensureActionContractV1(fixture.db), { migrated: false, reason: 'acoes_table_absent' });
    await new Promise((resolve, reject) => fixture.db.exec(v1Schema, (error) => error ? reject(error) : resolve()));
    await ensureActionContractV1(fixture.db);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    assert.equal((await getAsync(fixture.db, 'SELECT COUNT(*) AS total FROM action_origin_state')).total, 1);
  } finally {
    await fixture.close();
  }
});
