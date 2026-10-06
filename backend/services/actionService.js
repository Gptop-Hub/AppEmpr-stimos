const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const {
  ACTION_METADATA_VERSION,
  ACTION_STATUSES: ACTION_STATUS_VALUES,
  allocateActionIdentity
} = require('./actionIdentityService');
const { canonicalActionType, compatibleActionTypes } = require('./actionTypeContract');

const ACTION_STATUSES = new Set(ACTION_STATUS_VALUES);
const SNAPSHOT_MOMENTS = new Set(['antes', 'depois']);
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,99}$/;
const entityUidSchemaReady = new WeakSet();

const UID_ENTITY_MAP = Object.freeze({
  cliente: ['clientes', 'cliente_uid'], clientes: ['clientes', 'cliente_uid'],
  emprestimo: ['emprestimos', 'emprestimo_uid'], emprestimos: ['emprestimos', 'emprestimo_uid'],
  parcela: ['parcelas', 'parcela_uid'], parcelas: ['parcelas', 'parcela_uid'],
});

function actionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') throw actionError('invalid_action_input', `${field} deve ser texto.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw actionError('invalid_action_input', `${field} invalido.`);
  return text;
}

function optionalId(value, field) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw actionError('invalid_action_input', `${field} invalido.`);
  return id;
}

function requiredId(value, field) {
  const id = optionalId(value, field);
  if (id == null) throw actionError('invalid_action_input', `${field} e obrigatorio.`);
  return id;
}

function entityName(value) {
  const text = requiredText(value, 'entidade', 100);
  if (!IDENTIFIER_RE.test(text)) throw actionError('invalid_action_input', 'entidade invalida.');
  return text;
}

function normalizeJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw actionError('invalid_snapshot', 'Snapshot contem numero nao finito.');
    return value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value)) {
    throw actionError('invalid_snapshot', 'Snapshot contem valor nao serializavel.');
  }
  if (seen.has(value)) throw actionError('invalid_snapshot', 'Snapshot contem referencia circular.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw actionError('invalid_snapshot', 'Snapshot deve conter apenas objetos simples.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized = {};
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw actionError('invalid_snapshot', 'Snapshot nao pode executar getters.');
      }
      if (descriptor.value === undefined) {
        throw actionError('invalid_snapshot', 'Snapshot nao pode conter undefined.');
      }
      normalized[key] = normalizeJsonValue(descriptor.value, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function serializeDeterministic(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

function parseJson(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function assertContext(context) {
  if (!context || !context.dbHandle || !Number.isSafeInteger(context.actionId) || context.actionId <= 0) {
    throw actionError('invalid_action_context', 'Contexto de acao invalido.');
  }
  if (context.closed) throw actionError('action_closed', 'A acao ja foi finalizada.');
}

async function ensureActionEntityUidSchema(dbHandle) {
  if (entityUidSchemaReady.has(dbHandle)) return;
  const columns = await allAsync(dbHandle, 'PRAGMA table_info(acao_entidades)');
  if (!columns.some((column) => column.name === 'entidade_uid')) {
    await runAsync(dbHandle, 'ALTER TABLE acao_entidades ADD COLUMN entidade_uid TEXT');
  }
  await runAsync(dbHandle, 'CREATE INDEX IF NOT EXISTS idx_acao_entidades_uid ON acao_entidades(entidade_uid)');
  // Bancos Fase 2A já possuem o trigger antigo; recriamos para manter a nova
  // referência transportável tão imutável quanto os IDs locais.
  await runAsync(dbHandle, 'DROP TRIGGER IF EXISTS trg_acao_entidades_immutable_update');
  await runAsync(dbHandle, `CREATE TRIGGER trg_acao_entidades_immutable_update
    BEFORE UPDATE ON acao_entidades
    BEGIN SELECT RAISE(ABORT, 'acao_entidades sao imutaveis'); END`);
  entityUidSchemaReady.add(dbHandle);
}

async function resolveEntityUid(dbHandle, entity, entityId, requestedUid = null) {
  if (requestedUid != null && String(requestedUid).trim()) return String(requestedUid).trim();
  const mapping = UID_ENTITY_MAP[entity];
  if (!mapping) return null;
  const [table, column] = mapping;
  const columns = await allAsync(dbHandle, `PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) return null;
  const row = await getAsync(dbHandle, `SELECT ${column} AS uid FROM ${table} WHERE id = ?`, [entityId]);
  return row && row.uid ? String(row.uid) : null;
}

/**
 * Todas as primitivas recebem a conexao do chamador e nunca abrem/fecham
 * transacoes. Isso permite que a futura mutacao de negocio e sua auditoria
 * sejam confirmadas ou revertidas pelo mesmo BEGIN/COMMIT/ROLLBACK.
 */
async function iniciarAcao(input = {}, { dbHandle } = {}) {
  if (!dbHandle) throw actionError('db_required', 'dbHandle e obrigatorio.');
  const tipo = canonicalActionType(requiredText(input.tipo, 'tipo', 100));
  const origem = requiredText(input.origem, 'origem', 100);
  const resumo = input.resumo == null ? '' : String(input.resumo).trim();
  if (resumo.length > 2000) throw actionError('invalid_action_input', 'resumo invalido.');
  const status = input.status == null ? 'aplicada' : requiredText(input.status, 'status', 20);
  if (!ACTION_STATUSES.has(status)) throw actionError('invalid_action_input', 'status invalido.');
  const metadataJson = input.metadata == null ? null : serializeDeterministic(input.metadata);
  const acaoOrigemId = optionalId(input.acao_origem_id, 'acao_origem_id');
  const requestedAcaoOrigemUid = input.acao_origem_uid == null
    ? null
    : requiredText(input.acao_origem_uid, 'acao_origem_uid', 100);
  let acaoOrigemUid = requestedAcaoOrigemUid;

  if (acaoOrigemId != null) {
    const originAction = await getAsync(
      dbHandle,
      'SELECT id, acao_uid FROM acoes WHERE id = ?',
      [acaoOrigemId]
    );
    if (originAction && requestedAcaoOrigemUid && requestedAcaoOrigemUid !== originAction.acao_uid) {
      throw actionError('invalid_action_origin', 'As referencias de acao de origem divergem.');
    }
    acaoOrigemUid = originAction ? originAction.acao_uid : requestedAcaoOrigemUid;
  } else if (acaoOrigemUid) {
    const originAction = await getAsync(
      dbHandle,
      'SELECT id FROM acoes WHERE acao_uid = ?',
      [acaoOrigemUid]
    );
    if (!originAction) throw actionError('action_origin_not_found', 'Acao de origem nao encontrada.');
  }

  const identity = await allocateActionIdentity(dbHandle);
  const result = await runAsync(dbHandle, `INSERT INTO acoes
    (acao_uid, acao_origem_uid, origin_device_id, origin_sequence, metadata_version,
     tipo, origem, status, resumo, cliente_id, emprestimo_id, acao_origem_id, idempotency_key, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    identity.acao_uid, acaoOrigemUid, identity.origin_device_id, identity.origin_sequence,
    identity.metadata_version,
    tipo, origem, status, resumo, optionalId(input.cliente_id, 'cliente_id'),
    optionalId(input.emprestimo_id, 'emprestimo_id'), acaoOrigemId,
    input.idempotency_key == null ? null : requiredText(input.idempotency_key, 'idempotency_key', 500), metadataJson,
  ]);
  return {
    actionId: Number(result.lastID),
    acaoUid: identity.acao_uid,
    originDeviceId: identity.origin_device_id,
    originSequence: identity.origin_sequence,
    metadataVersion: ACTION_METADATA_VERSION,
    dbHandle,
    closed: false,
    status
  };
}

async function registrarEntidade(context, input = {}) {
  assertContext(context);
  await ensureActionEntityUidSchema(context.dbHandle);
  const entidade = entityName(input.entidade);
  const entidadeId = requiredId(input.entidade_id, 'entidade_id');
  const entidadeUid = await resolveEntityUid(context.dbHandle, entidade, entidadeId, input.entidade_uid);
  await runAsync(context.dbHandle, `INSERT INTO acao_entidades (acao_id, entidade, entidade_id, entidade_uid, papel)
    VALUES (?, ?, ?, ?, ?)`, [
    context.actionId, entidade, entidadeId, entidadeUid, requiredText(input.papel, 'papel', 100),
  ]);
}

async function registrarSnapshot(context, input = {}) {
  assertContext(context);
  const momento = requiredText(input.momento, 'momento', 10);
  if (!SNAPSHOT_MOMENTS.has(momento)) throw actionError('invalid_snapshot', 'momento invalido.');
  await runAsync(context.dbHandle, `INSERT INTO acao_snapshots
    (acao_id, momento, entidade, entidade_id, dados_json) VALUES (?, ?, ?, ?, ?)`, [
    context.actionId, momento, entityName(input.entidade), requiredId(input.entidade_id, 'entidade_id'),
    serializeDeterministic(input.dados),
  ]);
}

async function finalizarAcaoAplicada(context) {
  assertContext(context);
  const row = await getAsync(context.dbHandle, 'SELECT status FROM acoes WHERE id = ?', [context.actionId]);
  if (!row) throw actionError('action_not_found', 'Acao nao encontrada.');
  if (row.status !== 'aplicada') throw actionError('invalid_action_state', 'Acao nao esta aplicada.');
  context.closed = true;
  return buscarAcaoPorId(context.actionId, { dbHandle: context.dbHandle });
}

async function marcarAcaoFalha(context) {
  assertContext(context);
  await runAsync(context.dbHandle, "UPDATE acoes SET status = 'falhou' WHERE id = ? AND status = 'aplicada'", [context.actionId]);
  context.closed = true;
}

function mapAction(row) {
  return row ? {
    ...row,
    // Mantem `tipo` exatamente como foi gravado para auditoria e backups de
    // historicos. Consumidores multiplataforma podem usar o contrato comum.
    tipo_canonico: canonicalActionType(row.tipo),
    metadata: parseJson(row.metadata_json),
  } : null;
}

async function buscarAcaoPorId(id, { dbHandle } = {}) {
  if (!dbHandle) throw actionError('db_required', 'dbHandle e obrigatorio.');
  const actionId = optionalId(id, 'id');
  const action = await getAsync(dbHandle, 'SELECT * FROM acoes WHERE id = ?', [actionId]);
  if (!action) return null;
  const [entidades, snapshots] = await Promise.all([
    allAsync(dbHandle, 'SELECT entidade, entidade_id, entidade_uid, papel FROM acao_entidades WHERE acao_id = ? ORDER BY id', [actionId]),
    allAsync(dbHandle, 'SELECT momento, entidade, entidade_id, dados_json FROM acao_snapshots WHERE acao_id = ? ORDER BY id', [actionId]),
  ]);
  return {
    ...mapAction(action),
    entidades,
    snapshots: snapshots.map((snapshot) => ({ ...snapshot, dados: parseJson(snapshot.dados_json) })),
  };
}

async function buscarAcaoPorUid(acaoUid, { dbHandle } = {}) {
  if (!dbHandle) throw actionError('db_required', 'dbHandle e obrigatorio.');
  const uid = requiredText(acaoUid, 'acao_uid', 100);
  const action = await getAsync(dbHandle, 'SELECT id FROM acoes WHERE acao_uid = ?', [uid]);
  return action ? buscarAcaoPorId(action.id, { dbHandle }) : null;
}

async function resolverAcaoOrigemUid(acaoUid, { dbHandle } = {}) {
  const action = await buscarAcaoPorUid(acaoUid, { dbHandle });
  if (!action || !action.acao_origem_uid) return null;
  return buscarAcaoPorUid(action.acao_origem_uid, { dbHandle });
}

async function listarAcoes(filters = {}, { dbHandle } = {}) {
  if (!dbHandle) throw actionError('db_required', 'dbHandle e obrigatorio.');
  const where = [];
  const params = [];
  for (const [field, column] of [['cliente_id', 'cliente_id'], ['emprestimo_id', 'emprestimo_id']]) {
    if (filters[field] != null && filters[field] !== '') {
      where.push(`${column} = ?`);
      params.push(optionalId(filters[field], field));
    }
  }
  if (filters.tipo != null && filters.tipo !== '') {
    const types = compatibleActionTypes(requiredText(filters.tipo, 'tipo', 100));
    where.push(`tipo IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (filters.status != null && filters.status !== '') {
    const status = requiredText(filters.status, 'status', 20);
    if (!ACTION_STATUSES.has(status)) throw actionError('invalid_action_input', 'status invalido.');
    where.push('status = ?'); params.push(status);
  }
  if (filters.de != null && filters.de !== '') { where.push('created_at >= ?'); params.push(requiredText(filters.de, 'de', 40)); }
  if (filters.ate != null && filters.ate !== '') { where.push('created_at <= ?'); params.push(requiredText(filters.ate, 'ate', 40)); }
  const limit = filters.limit == null ? 100 : Number(filters.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw actionError('invalid_action_input', 'limit invalido.');
  const rows = await allAsync(dbHandle, `SELECT * FROM acoes${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, origin_device_id ASC, origin_sequence DESC, id DESC LIMIT ?`, [...params, limit]);
  return rows.map(mapAction);
}

module.exports = {
  iniciarAcao,
  registrarEntidade,
  registrarSnapshot,
  finalizarAcaoAplicada,
  marcarAcaoFalha,
  buscarAcaoPorId,
  buscarAcaoPorUid,
  resolverAcaoOrigemUid,
  listarAcoes,
  serializeDeterministic,
  __internal: { normalizeJsonValue },
};
