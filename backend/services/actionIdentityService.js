const crypto = require('crypto');
const { allAsync, getAsync, runAsync } = require('../utils/sqliteAsync');

const ACTION_CONTRACT_VERSION = 1;
const ACTION_METADATA_VERSION = 1;

const ACTION_ORIGINS = Object.freeze([
  'interface',
  'sistema',
  'assistente',
  'importacao'
]);

const ACTION_STATUSES = Object.freeze([
  'aplicada',
  'desfeita',
  'bloqueada',
  'falhou'
]);

const contractMigrationPromises = new WeakMap();
const readyActionDatabases = new WeakSet();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const ACTION_ORIGIN_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS action_origin_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    origin_device_id TEXT NOT NULL UNIQUE,
    next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
    contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version >= 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const ACTIONS_V1_SQL = `
  CREATE TABLE acoes_v1 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    acao_uid TEXT NOT NULL UNIQUE,
    acao_origem_uid TEXT,
    origin_device_id TEXT NOT NULL,
    origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
    metadata_version INTEGER NOT NULL DEFAULT 1 CHECK (metadata_version >= 1),
    tipo TEXT NOT NULL,
    origem TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'aplicada',
    resumo TEXT NOT NULL,
    cliente_id INTEGER,
    emprestimo_id INTEGER,
    acao_origem_id INTEGER,
    idempotency_key TEXT,
    metadata_json TEXT,
    FOREIGN KEY (acao_origem_id) REFERENCES acoes_v1(id) ON DELETE RESTRICT,
    FOREIGN KEY (acao_origem_uid) REFERENCES acoes_v1(acao_uid) ON DELETE RESTRICT,
    UNIQUE (origin_device_id, origin_sequence)
  )
`;

const ACTION_INDEXES_AND_TRIGGERS_SQL = `
  CREATE INDEX IF NOT EXISTS idx_acoes_cliente_created
    ON acoes(cliente_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_acoes_emprestimo_created
    ON acoes(emprestimo_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_acoes_tipo_created
    ON acoes(tipo, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_acoes_origem
    ON acoes(acao_origem_id);
  CREATE INDEX IF NOT EXISTS idx_acoes_uid
    ON acoes(acao_uid);
  CREATE INDEX IF NOT EXISTS idx_acoes_origem_uid
    ON acoes(acao_origem_uid);
  CREATE INDEX IF NOT EXISTS idx_acoes_ordem_estavel
    ON acoes(created_at DESC, origin_device_id, origin_sequence DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_acoes_idempotency_key
    ON acoes(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  DROP TRIGGER IF EXISTS prevent_acoes_update;
  DROP TRIGGER IF EXISTS trg_acoes_immutable_update;
  CREATE TRIGGER trg_acoes_immutable_update
  BEFORE UPDATE ON acoes
  WHEN NEW.acao_uid IS NOT OLD.acao_uid
    OR NEW.acao_origem_uid IS NOT OLD.acao_origem_uid
    OR NEW.origin_device_id IS NOT OLD.origin_device_id
    OR NEW.origin_sequence IS NOT OLD.origin_sequence
    OR NEW.metadata_version IS NOT OLD.metadata_version
    OR NEW.tipo IS NOT OLD.tipo
    OR NEW.origem IS NOT OLD.origem
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.resumo IS NOT OLD.resumo
    OR NEW.cliente_id IS NOT OLD.cliente_id
    OR NEW.emprestimo_id IS NOT OLD.emprestimo_id
    OR NEW.acao_origem_id IS NOT OLD.acao_origem_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.metadata_json IS NOT OLD.metadata_json
    OR NOT (OLD.status = 'aplicada' AND NEW.status IN ('desfeita', 'falhou', 'bloqueada'))
  BEGIN
    SELECT RAISE(ABORT, 'acoes sao imutaveis');
  END;
`;

function createUuid() {
  if (typeof crypto.randomUUID !== 'function') {
    throw new Error('O runtime atual nao oferece crypto.randomUUID() para identidade de acoes.');
  }

  return crypto.randomUUID();
}

function execAsync(dbHandle, sql) {
  return new Promise((resolve, reject) => {
    dbHandle.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function asPositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function tableExists(dbHandle, tableName) {
  const table = await getAsync(
    dbHandle,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return Boolean(table);
}

async function getColumns(dbHandle, tableName) {
  return allAsync(dbHandle, `PRAGMA table_info(${tableName})`);
}

async function getOrCreateOriginState(dbHandle) {
  await runAsync(dbHandle, ACTION_ORIGIN_STATE_SQL);

  const stateColumns = await getColumns(dbHandle, 'action_origin_state');
  const stateColumnNames = new Set(stateColumns.map((column) => column.name));
  if (!stateColumnNames.has('updated_at')) {
    await runAsync(dbHandle, 'ALTER TABLE action_origin_state ADD COLUMN updated_at TEXT');
  }
  if (!stateColumnNames.has('created_at')) {
    await runAsync(dbHandle, 'ALTER TABLE action_origin_state ADD COLUMN created_at TEXT');
  }

  let state = await getAsync(
    dbHandle,
    'SELECT id, origin_device_id, next_sequence, contract_version FROM action_origin_state WHERE id = 1'
  );

  if (!state) {
    const originDeviceId = createUuid();
    await runAsync(
      dbHandle,
      `INSERT INTO action_origin_state
        (id, origin_device_id, next_sequence, contract_version)
       VALUES (1, ?, 1, ?)`,
      [originDeviceId, ACTION_CONTRACT_VERSION]
    );
    state = {
      id: 1,
      origin_device_id: originDeviceId,
      next_sequence: 1,
      contract_version: ACTION_CONTRACT_VERSION
    };
  }

  return {
    ...state,
    next_sequence: asPositiveInteger(state.next_sequence, 1)
  };
}

function normalizeExistingActions(rows, originState) {
  const uidById = new Map();
  const normalized = [];
  let nextSequence = asPositiveInteger(originState.next_sequence, 1);

  for (const row of rows) {
    uidById.set(row.id, row.acao_uid || createUuid());
  }

  for (const row of rows) {
    const sequence = asPositiveInteger(row.origin_sequence);
    if (row.origin_device_id === originState.origin_device_id && sequence) {
      nextSequence = Math.max(nextSequence, sequence + 1);
    }
  }

  for (const row of rows) {
    const acaoUid = uidById.get(row.id);

    const hasExistingIdentity = Boolean(row.origin_device_id && asPositiveInteger(row.origin_sequence));
    const originDeviceId = hasExistingIdentity
      ? row.origin_device_id
      : originState.origin_device_id;
    const originSequence = hasExistingIdentity
      ? asPositiveInteger(row.origin_sequence)
      : nextSequence++;

    normalized.push({
      ...row,
      acao_uid: acaoUid,
      acao_origem_uid: row.acao_origem_uid || uidById.get(row.acao_origem_id) || null,
      origin_device_id: originDeviceId,
      origin_sequence: originSequence,
      metadata_version: asPositiveInteger(row.metadata_version, ACTION_METADATA_VERSION)
    });
  }

  return { normalized, nextSequence };
}

async function rebuildActionsTable(dbHandle, actions) {
  await runAsync(dbHandle, 'DROP TABLE IF EXISTS acoes_v1');
  await runAsync(dbHandle, ACTIONS_V1_SQL);

  for (const action of actions) {
    await runAsync(
      dbHandle,
      `INSERT INTO acoes_v1 (
        id, acao_uid, acao_origem_uid, origin_device_id, origin_sequence,
        metadata_version, tipo, origem, created_at, status, resumo, cliente_id,
        emprestimo_id, acao_origem_id, idempotency_key, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        action.id,
        action.acao_uid,
        action.acao_origem_uid,
        action.origin_device_id,
        action.origin_sequence,
        action.metadata_version,
        action.tipo,
        action.origem,
        action.created_at,
        action.status,
        action.resumo,
        action.cliente_id,
        action.emprestimo_id,
        action.acao_origem_id,
        action.idempotency_key,
        action.metadata_json
      ]
    );
  }

  await runAsync(dbHandle, 'DROP TABLE acoes');
  await runAsync(dbHandle, 'ALTER TABLE acoes_v1 RENAME TO acoes');
  await execAsync(dbHandle, ACTION_INDEXES_AND_TRIGGERS_SQL);
}

function requiresActionsRebuild(columns) {
  const required = [
    'acao_uid',
    'acao_origem_uid',
    'origin_device_id',
    'origin_sequence',
    'metadata_version'
  ];
  const columnsByName = new Map(columns.map((column) => [column.name, column]));

  return required.some((name) => !columnsByName.has(name))
    || ['acao_uid', 'origin_device_id', 'origin_sequence', 'metadata_version'].some(
      (name) => Number(columnsByName.get(name)?.notnull) !== 1
    );
}

async function runEnsureActionContractV1(dbHandle) {
  if (!await tableExists(dbHandle, 'acoes')) {
    return { migrated: false, reason: 'acoes_table_absent' };
  }

  const initialColumns = await getColumns(dbHandle, 'acoes');
  if (!requiresActionsRebuild(initialColumns)) {
    const state = await getOrCreateOriginState(dbHandle);
    const incomplete = await getAsync(
      dbHandle,
      `SELECT id FROM acoes
        WHERE acao_uid IS NULL OR origin_device_id IS NULL
          OR origin_sequence IS NULL OR metadata_version IS NULL
        LIMIT 1`
    );
    if (!incomplete) {
      // Um banco ja V1 nao precisa abrir uma transacao exclusiva a cada boot.
      // Alem de evitar disputar a primeira acao da aplicacao, atualizamos o
      // ponteiro somente se este dispositivo ja possuir sequencias gravadas.
      const maximum = await getAsync(
        dbHandle,
        'SELECT MAX(origin_sequence) AS maximum FROM acoes WHERE origin_device_id = ?',
        [state.origin_device_id]
      );
      const nextSequence = Math.max(
        asPositiveInteger(state.next_sequence, 1),
        asPositiveInteger(maximum?.maximum, 0) + 1
      );
      if (nextSequence !== state.next_sequence) {
        await runAsync(
          dbHandle,
          'UPDATE action_origin_state SET next_sequence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
          [nextSequence]
        );
      }
      return { migrated: true, contractVersion: ACTION_CONTRACT_VERSION };
    }
  }

  await runAsync(dbHandle, 'PRAGMA foreign_keys = OFF');
  let transactionStarted = false;

  try {
    await runAsync(dbHandle, 'BEGIN IMMEDIATE');
    transactionStarted = true;

    const originState = await getOrCreateOriginState(dbHandle);
    const columns = await getColumns(dbHandle, 'acoes');
    const actions = await allAsync(
      dbHandle,
      'SELECT * FROM acoes ORDER BY created_at ASC, id ASC'
    );
    const { normalized, nextSequence } = normalizeExistingActions(actions, originState);

    if (requiresActionsRebuild(columns)) {
      await rebuildActionsTable(dbHandle, normalized);
    } else {
      for (const action of normalized) {
        await runAsync(
          dbHandle,
          `UPDATE acoes
             SET acao_uid = ?, acao_origem_uid = ?, origin_device_id = ?,
                 origin_sequence = ?, metadata_version = ?
           WHERE id = ?
             AND (acao_uid IS NOT ? OR acao_origem_uid IS NOT ?
               OR origin_device_id IS NOT ? OR origin_sequence IS NOT ?
               OR metadata_version IS NOT ?)`,
          [
            action.acao_uid,
            action.acao_origem_uid,
            action.origin_device_id,
            action.origin_sequence,
            action.metadata_version,
            action.id,
            action.acao_uid,
            action.acao_origem_uid,
            action.origin_device_id,
            action.origin_sequence,
            action.metadata_version
          ]
        );
      }
      await execAsync(dbHandle, ACTION_INDEXES_AND_TRIGGERS_SQL);
    }

    await runAsync(
      dbHandle,
      `UPDATE action_origin_state
          SET next_sequence = ?, contract_version = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`,
      [nextSequence, ACTION_CONTRACT_VERSION]
    );

    await runAsync(dbHandle, 'COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await runAsync(dbHandle, 'ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    await runAsync(dbHandle, 'PRAGMA foreign_keys = ON');
  }

  return {
    migrated: true,
    contractVersion: ACTION_CONTRACT_VERSION
  };
}

function ensureActionContractV1(dbHandle) {
  const inProgress = contractMigrationPromises.get(dbHandle);
  if (inProgress) return inProgress;

  const migration = (async () => {
    // O bootstrap historico do banco agenda outras migrations assincronas na
    // mesma conexao SQLite. Se uma delas ainda estiver em transacao, aguarda
    // em vez de registrar falha ou disputar o BEGIN IMMEDIATE.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        return await runEnsureActionContractV1(dbHandle);
      } catch (error) {
        const isNestedTransaction = /cannot start a transaction within a transaction/i.test(String(error?.message || error));
        if (!isNestedTransaction || attempt === 39) throw error;
        await wait(25);
      }
    }
    return null;
  })();
  const trackedMigration = migration.finally(() => {
    contractMigrationPromises.delete(dbHandle);
  });
  contractMigrationPromises.set(dbHandle, trackedMigration);
  return trackedMigration;
}

async function ensureActionContractReady(dbHandle) {
  if (readyActionDatabases.has(dbHandle)) return;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await ensureActionContractV1(dbHandle);
    if (result && result.reason === 'acoes_table_absent') {
      await wait(25);
      continue;
    }
    readyActionDatabases.add(dbHandle);
    return;
  }
  throw new Error('O schema V1 do Motor de Ações não ficou disponível a tempo.');
}

async function allocateActionIdentity(dbHandle) {
  const state = await getOrCreateOriginState(dbHandle);
  const sequence = asPositiveInteger(state.next_sequence, 1);
  const result = await runAsync(
    dbHandle,
    `UPDATE action_origin_state
        SET next_sequence = next_sequence + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND next_sequence = ?`,
    [sequence]
  );

  if (result.changes !== 1) {
    throw new Error('Nao foi possivel reservar uma sequencia unica para a acao.');
  }

  return {
    acao_uid: createUuid(),
    origin_device_id: state.origin_device_id,
    origin_sequence: sequence,
    metadata_version: ACTION_METADATA_VERSION
  };
}

module.exports = {
  ACTION_CONTRACT_VERSION,
  ACTION_METADATA_VERSION,
  ACTION_ORIGINS,
  ACTION_STATUSES,
  allocateActionIdentity,
  ensureActionContractV1,
  ensureActionContractReady,
  getOrCreateOriginState
};
