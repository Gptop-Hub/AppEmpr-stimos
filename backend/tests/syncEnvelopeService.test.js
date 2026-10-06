const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const test = require('node:test');

const { allAsync, getAsync } = require('../utils/sqliteAsync');
const { atualizarMalPagadorCliente } = require('../services/clienteActionMutationService');
const actionService = require('../services/actionService');
const {
  serializeLocalAction,
  dryRunReceiveEnvelope,
  validateEnvelope,
} = require('../services/syncEnvelopeService');
const { classifyActionType } = require('../services/syncActionClassification');

const actionSchema = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'),
  'utf8'
);

function uuid(value) {
  return `${value.padStart(8, '0')}-1111-4111-8111-111111111111`;
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-envelope-'));
  const dbPath = path.join(directory, 'fixture.db');
  const db = new sqlite3.Database(dbPath);
  await exec(db, `
    CREATE TABLE clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      mal_pagador INTEGER DEFAULT 0,
      receber_notificacoes_cobranca INTEGER DEFAULT 1,
      motivo_notificacoes_cobranca TEXT
    );
    CREATE TABLE clientes_telefones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      telefone TEXT NOT NULL
    );
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER);
    CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER);
    CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY AUTOINCREMENT, emprestimo_id INTEGER);
    ${actionSchema}
    INSERT INTO clientes (id, nome, mal_pagador) VALUES (1, 'Cliente piloto', 0);
  `);
  return {
    db,
    dbPath,
    async close() {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createRealPilotAction(f) {
  await atualizarMalPagadorCliente({ dbPath: f.dbPath, clienteId: 1, malPagador: 1 });
  const action = (await actionService.listarAcoes(
    { tipo: 'CLIENTE_MAL_PAGADOR_ATUALIZADO' },
    { dbHandle: f.db }
  ))[0];
  assert.ok(action, 'a mutação real deve ter gravado uma ação local');
  return action;
}

function remoteEnvelope(envelope, { actionNumber = 9, originNumber = 8, sequence = 1, clientUid } = {}) {
  return {
    contract_version: envelope.contract_version,
    action: {
      ...envelope.action,
      acao_uid: uuid(String(actionNumber)),
      origin_device_id: uuid(String(originNumber)),
      origin_sequence: sequence,
    },
    entities: [{
      entity_type: 'cliente',
      entity_uid: clientUid || envelope.entities[0].entity_uid,
    }],
    payload: { ...envelope.payload },
  };
}

async function persistentState(db) {
  const tables = [
    'clientes', 'emprestimos', 'parcelas', 'pagamentos', 'caixa_movimentos',
    'acoes', 'acao_entidades', 'acao_snapshots', 'action_origin_state',
  ];
  const result = {};
  for (const table of tables) result[table] = await allAsync(db, `SELECT * FROM ${table} ORDER BY id ASC`);
  return result;
}

test('Fase 3B serializa uma ação real do piloto por allowlist e preserva identidades', async () => {
  const f = await fixture();
  try {
    const localAction = await createRealPilotAction(f);
    const localClient = await getAsync(f.db, 'SELECT cliente_uid FROM clientes WHERE id = 1');
    const envelope = await serializeLocalAction(localAction.acao_uid, { dbHandle: f.db });

    assert.deepEqual(Object.keys(envelope), ['contract_version', 'action', 'entities', 'payload']);
    assert.equal(envelope.contract_version, 1);
    assert.equal(envelope.action.acao_uid, localAction.acao_uid);
    assert.equal(envelope.action.origin_device_id, localAction.origin_device_id);
    assert.equal(envelope.action.origin_sequence, localAction.origin_sequence);
    assert.equal(envelope.entities[0].entity_uid, localClient.cliente_uid);
    assert.deepEqual(envelope.payload, { mal_pagador: 1 });
    assert.doesNotThrow(() => validateEnvelope(envelope));

    const serialized = JSON.stringify(envelope);
    for (const forbidden of ['"id"', 'cliente_id', 'emprestimo_id', 'parcela_id', 'pagamento_id', 'caixa_movimento_id', 'historico_id']) {
      assert.equal(serialized.includes(forbidden), false, `envelope não pode transportar ${forbidden}`);
    }
  } finally {
    await f.close();
  }
});

test('dry-run retorna estados corretos e não produz efeito persistente', async () => {
  const f = await fixture();
  try {
    const localAction = await createRealPilotAction(f);
    const envelope = await serializeLocalAction(localAction.acao_uid, { dbHandle: f.db });
    const before = await persistentState(f.db);

    assert.equal((await dryRunReceiveEnvelope(remoteEnvelope(envelope), { dbHandle: f.db })).status, 'READY');
    assert.equal((await dryRunReceiveEnvelope(envelope, { dbHandle: f.db })).status, 'DUPLICATE');

    const divergent = { ...envelope, payload: { mal_pagador: 0 } };
    assert.deepEqual(await dryRunReceiveEnvelope(divergent, { dbHandle: f.db }), {
      status: 'INVALID_CONTRACT', code: 'DUPLICATE_DIVERGENT',
    });

    const missingClient = remoteEnvelope(envelope, {
      actionNumber: 10, originNumber: 9, clientUid: uuid('77'),
    });
    assert.equal((await dryRunReceiveEnvelope(missingClient, { dbHandle: f.db })).status, 'MISSING_DEPENDENCY');

    const gap = remoteEnvelope(envelope, { actionNumber: 11, originNumber: 10, sequence: 2 });
    assert.equal((await dryRunReceiveEnvelope(gap, { dbHandle: f.db })).status, 'OUT_OF_ORDER');
    assert.equal((await dryRunReceiveEnvelope({}, { dbHandle: f.db })).status, 'INVALID_CONTRACT');

    const localOnly = remoteEnvelope(envelope, { actionNumber: 12, originNumber: 11 });
    localOnly.action.tipo = 'NOTIFICACOES_GERADAS';
    localOnly.entities = [];
    localOnly.payload = {};
    assert.equal((await dryRunReceiveEnvelope(localOnly, { dbHandle: f.db })).status, 'LOCAL_ONLY');

    const configLocal = remoteEnvelope(envelope, { actionNumber: 13, originNumber: 12 });
    configLocal.action.tipo = 'CONFIG_NOTIFICACOES_ATUALIZADA';
    configLocal.entities = [];
    configLocal.payload = {};
    assert.equal((await dryRunReceiveEnvelope(configLocal, { dbHandle: f.db })).status, 'LOCAL_ONLY');

    const futureType = remoteEnvelope(envelope, { actionNumber: 14, originNumber: 13 });
    futureType.action.tipo = 'EMPRESTIMO_EDITADO';
    futureType.entities = [{ entity_type: 'emprestimo', entity_uid: uuid('99') }];
    futureType.payload = {};
    assert.equal((await dryRunReceiveEnvelope(futureType, { dbHandle: f.db })).status, 'TYPE_NOT_ENABLED');

    const after = await persistentState(f.db);
    assert.deepEqual(after, before, 'dry-run não pode alterar qualquer tabela SQLite observada');
  } finally {
    await f.close();
  }
});

test('validador recusa aliases, identidade SQLite, segredos e payload inválido', () => {
  const base = {
    contract_version: 1,
    action: {
      acao_uid: uuid('1'), tipo: 'CLIENTE_MAL_PAGADOR_ATUALIZADO', origin_device_id: uuid('2'),
      origin_sequence: 1, metadata_version: 1, created_at: '2026-09-28T12:00:00.000Z',
    },
    entities: [{ entity_type: 'cliente', entity_uid: uuid('3') }],
    payload: { mal_pagador: 1 },
  };
  assert.doesNotThrow(() => validateEnvelope(base));
  assert.throws(() => validateEnvelope({ ...base, action: { ...base.action, tipo: 'despesa_criada' } }), /catálogo canônico/);
  assert.throws(() => validateEnvelope({ ...base, payload: { mal_pagador: 1, cliente_id: 1 } }), /não pode atravessar/);
  assert.throws(() => validateEnvelope({ ...base, payload: { mal_pagador: 2 } }), /0 ou 1/);
  assert.throws(() => validateEnvelope({ ...base, payload: { mal_pagador: 1, token: 'segredo' } }), /não pode atravessar/);
  assert.throws(
    () => validateEnvelope({
      ...base,
      action: { ...base.action, tipo: 'NOTIFICACOES_GERADAS' },
      entities: [],
      payload: {},
    }),
    /LOCAL_ONLY/
  );
});

test('classificação central conhece domínio, local e tipos futuros sem emitir aliases', () => {
  assert.equal(classifyActionType('CLIENTE_MAL_PAGADOR_ATUALIZADO'), 'SYNC_DOMAIN');
  assert.equal(classifyActionType('PAGAMENTO_MANUAL_RENEGOCIADO'), 'SYNC_DOMAIN');
  assert.equal(classifyActionType('NOTIFICACOES_GERADAS'), 'LOCAL_ONLY');
  assert.equal(classifyActionType('reagendamento_cascata'), 'SYNC_DOMAIN');
});
