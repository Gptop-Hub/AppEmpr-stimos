const actionService = require('./actionService');
const { allAsync, getAsync } = require('../utils/sqliteAsync');
const {
  classifyActionType,
  isCanonicalPortableType,
} = require('./syncActionClassification');
const { ACTION_TYPES } = require('./actionTypeContract');

const CONTRACT_VERSION = 1;
const PILOT_TYPE = ACTION_TYPES.CLIENTE_MAL_PAGADOR_ATUALIZADO;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_LOCAL_ID_FIELDS = new Set([
  'id', 'cliente_id', 'emprestimo_id', 'parcela_id', 'pagamento_id',
  'caixa_movimento_id', 'historico_id', 'acao_id', 'acao_origem_id',
  'entity_id', 'entidade_id', 'local_id', 'sqlite_id',
]);
const FORBIDDEN_SECRET_OR_PATH_FIELDS = new Set([
  'senha', 'password', 'password_hash', 'senha_hash', 'token', 'secret',
  'api_key', 'path', 'file_path', 'physical_path',
]);

class SyncContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SyncContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail('INVALID_STRUCTURE', `${label} deve ser um objeto simples.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('UNEXPECTED_FIELD', `${label} possui campos inesperados ou ausentes.`);
  }
}

function requiredUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('INVALID_UUID', `${label} deve ser UUID válido.`);
  return value.toLowerCase();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_NUMBER', `${label} deve ser inteiro positivo.`);
  return value;
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TIMESTAMP', 'created_at é obrigatório.');
  if (Number.isNaN(Date.parse(value))) fail('INVALID_TIMESTAMP', 'created_at é inválido.');
  return value;
}

function assertNoForbiddenFields(value, path = 'envelope') {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) fail('INVALID_STRUCTURE', `${path} contém valor não serializável.`);
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_LOCAL_ID_FIELDS.has(key)) {
      fail('LOCAL_ID_FORBIDDEN', `${path}.${key} não pode atravessar o contrato portátil.`);
    }
    if (FORBIDDEN_SECRET_OR_PATH_FIELDS.has(key)) {
      fail('SENSITIVE_FIELD_FORBIDDEN', `${path}.${key} não pode atravessar o contrato portátil.`);
    }
    assertNoForbiddenFields(item, `${path}.${key}`);
  }
}

function normalizeEntities(entities, { allowEmpty = false } = {}) {
  if (!Array.isArray(entities) || (!allowEmpty && entities.length < 1)) {
    fail('INVALID_ENTITIES', 'entities deve conter as entidades do contrato.');
  }
  const seen = new Set();
  return entities.map((entity, index) => {
    exactKeys(entity, ['entity_type', 'entity_uid'], `entities[${index}]`);
    if (!['cliente', 'emprestimo', 'parcela'].includes(entity.entity_type)) {
      fail('INVALID_ENTITY', 'entity_type não pertence ao contrato portátil.');
    }
    const entityUid = requiredUuid(entity.entity_uid, 'entity_uid');
    const key = `${entity.entity_type}:${entityUid}`;
    if (seen.has(key)) fail('DUPLICATE_ENTITY', 'entities contém referência duplicada.');
    seen.add(key);
    return { entity_type: entity.entity_type, entity_uid: entityUid };
  });
}

function validatePilotPayload(payload, entities) {
  exactKeys(payload, ['mal_pagador'], 'payload');
  if (payload.mal_pagador !== 0 && payload.mal_pagador !== 1) {
    fail('INVALID_PAYLOAD', 'payload.mal_pagador deve ser 0 ou 1.');
  }
  if (entities.length !== 1 || entities[0].entity_type !== 'cliente') {
    fail('INVALID_ENTITY', 'CLIENTE_MAL_PAGADOR_ATUALIZADO exige exatamente um cliente.');
  }
  return { mal_pagador: payload.mal_pagador };
}

/**
 * Valida somente o contrato transportável. Não lê nem grava SQLite.
 * Para tipos futuros, valida o cabeçalho e os campos proibidos, sem inferir
 * semântica financeira que ainda não foi implementada.
 */
function validateEnvelope(envelope, { allowLocalOnly = false } = {}) {
  exactKeys(envelope, ['contract_version', 'action', 'entities', 'payload'], 'envelope');
  if (envelope.contract_version !== CONTRACT_VERSION) {
    fail('UNSUPPORTED_CONTRACT_VERSION', 'contract_version não é suportado.');
  }
  exactKeys(
    envelope.action,
    ['acao_uid', 'tipo', 'origin_device_id', 'origin_sequence', 'metadata_version', 'created_at'],
    'action'
  );
  const action = {
    acao_uid: requiredUuid(envelope.action.acao_uid, 'acao_uid'),
    tipo: typeof envelope.action.tipo === 'string' ? envelope.action.tipo.trim() : '',
    origin_device_id: requiredUuid(envelope.action.origin_device_id, 'origin_device_id'),
    origin_sequence: positiveInteger(envelope.action.origin_sequence, 'origin_sequence'),
    metadata_version: positiveInteger(envelope.action.metadata_version, 'metadata_version'),
    created_at: requiredTimestamp(envelope.action.created_at),
  };
  if (!isCanonicalPortableType(action.tipo)) {
    fail('TYPE_NOT_CANONICAL', 'tipo deve pertencer ao catálogo canônico portátil.');
  }
  const classification = classifyActionType(action.tipo);
  if (classification === 'LOCAL_ONLY' && !allowLocalOnly) {
    fail('LOCAL_ONLY', 'Tipo LOCAL_ONLY não pode ser aceito pelo contrato de sync.');
  }
  const entities = normalizeEntities(envelope.entities, { allowEmpty: classification === 'LOCAL_ONLY' });
  if (!isPlainObject(envelope.payload)) fail('INVALID_PAYLOAD', 'payload deve ser um objeto simples.');
  assertNoForbiddenFields(envelope);

  const payload = action.tipo === PILOT_TYPE
    ? validatePilotPayload(envelope.payload, entities)
    : { ...envelope.payload };

  return {
    contract_version: CONTRACT_VERSION,
    action,
    entities,
    payload,
    classification,
  };
}

function deterministicStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(deterministicStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${deterministicStringify(value[key])}`).join(',')}}`;
}

function finalMalPagador(action) {
  const snapshot = (action.snapshots || []).find(
    (item) => item.momento === 'depois' && item.entidade === 'clientes'
  );
  const value = snapshot?.dados?.estado?.mal_pagador;
  if (value !== 0 && value !== 1) {
    fail('AMBIGUOUS_LOCAL_ACTION', 'A ação local não contém valor final inequívoco de mal_pagador.');
  }
  return value;
}

function clientUidFromAction(action) {
  const clientEntities = (action.entidades || []).filter(
    (item) => item.entidade === 'clientes' && item.papel === 'afetado' && typeof item.entidade_uid === 'string'
  );
  if (clientEntities.length !== 1) {
    fail('AMBIGUOUS_LOCAL_ACTION', 'A ação local deve conter exatamente um cliente afetado com UID.');
  }
  return requiredUuid(clientEntities[0].entidade_uid, 'cliente_uid');
}

/**
 * Constrói, por allowlist, o envelope de uma ação já persistida. Nenhum
 * snapshot ou metadata local é copiado para a saída.
 */
async function serializeLocalAction(acaoUid, { dbHandle } = {}) {
  if (!dbHandle) fail('DB_REQUIRED', 'dbHandle é obrigatório.');
  const action = await actionService.buscarAcaoPorUid(acaoUid, { dbHandle });
  if (!action) fail('LOCAL_ACTION_NOT_FOUND', 'A ação local não foi encontrada.');
  if (action.tipo !== PILOT_TYPE) {
    fail('TYPE_NOT_ENABLED', 'Somente CLIENTE_MAL_PAGADOR_ATUALIZADO possui serialização habilitada nesta fase.');
  }
  const envelope = {
    contract_version: CONTRACT_VERSION,
    action: {
      acao_uid: requiredUuid(action.acao_uid, 'acao_uid'),
      tipo: PILOT_TYPE,
      origin_device_id: requiredUuid(action.origin_device_id, 'origin_device_id'),
      origin_sequence: positiveInteger(action.origin_sequence, 'origin_sequence'),
      metadata_version: positiveInteger(action.metadata_version, 'metadata_version'),
      created_at: requiredTimestamp(action.created_at),
    },
    entities: [{
      entity_type: 'cliente',
      entity_uid: clientUidFromAction(action),
    }],
    payload: {
      mal_pagador: finalMalPagador(action),
    },
  };
  // A validação é executada antes do retorno, mas o contrato público contém
  // apenas os quatro campos V1 — sem metadados internos de classificação.
  validateEnvelope(envelope);
  return envelope;
}

function result(status, fields = {}) {
  return { status, ...fields };
}

async function analyzeOriginSequence(action, dbHandle) {
  const rows = await allAsync(
    dbHandle,
    `SELECT acao_uid, origin_sequence
       FROM acoes
      WHERE origin_device_id = ?
      ORDER BY origin_sequence ASC`,
    [action.origin_device_id]
  );
  const sameSequence = rows.find((row) => Number(row.origin_sequence) === action.origin_sequence);
  if (sameSequence) {
    return {
      issue: 'ORIGIN_SEQUENCE_COLLISION',
      expected_sequence: null,
      conflicting_action_uid: sameSequence.acao_uid,
    };
  }
  const known = new Set(rows.map((row) => Number(row.origin_sequence)));
  let expected = 1;
  while (known.has(expected)) expected += 1;
  const missing = [];
  for (let sequence = 1; sequence < action.origin_sequence; sequence += 1) {
    if (!known.has(sequence)) missing.push(sequence);
  }
  if (missing.length) {
    return { issue: 'OUT_OF_ORDER', expected_sequence: expected, missing_sequences: missing };
  }
  return { issue: null, expected_sequence: expected };
}

/**
 * Inspeção de recepção sem qualquer escrita: não cria ação, não consome
 * sequência e não persiste checkpoint ou deduplicação remota.
 */
async function dryRunReceiveEnvelope(envelope, { dbHandle } = {}) {
  if (!dbHandle) return result('INVALID_CONTRACT', { code: 'DB_REQUIRED' });
  let normalized;
  try {
    normalized = validateEnvelope(envelope, { allowLocalOnly: true });
  } catch (error) {
    if (error instanceof SyncContractError && error.code === 'TYPE_NOT_CANONICAL') {
      return result('INVALID_CONTRACT', { code: error.code });
    }
    return result('INVALID_CONTRACT', { code: error.code || 'INVALID_CONTRACT' });
  }

  if (normalized.classification === 'LOCAL_ONLY') {
    return result('LOCAL_ONLY', { tipo: normalized.action.tipo });
  }
  if (normalized.action.tipo !== PILOT_TYPE) {
    return result('TYPE_NOT_ENABLED', { tipo: normalized.action.tipo });
  }

  const localAction = await getAsync(
    dbHandle,
    'SELECT id FROM acoes WHERE acao_uid = ?',
    [normalized.action.acao_uid]
  );
  if (localAction) {
    try {
      const localEnvelope = await serializeLocalAction(normalized.action.acao_uid, { dbHandle });
      if (deterministicStringify(validateEnvelope(localEnvelope)) !== deterministicStringify(normalized)) {
        return result('INVALID_CONTRACT', { code: 'DUPLICATE_DIVERGENT' });
      }
      return result('DUPLICATE', { acao_uid: normalized.action.acao_uid });
    } catch (error) {
      return result('INVALID_CONTRACT', { code: error.code || 'DUPLICATE_DIVERGENT' });
    }
  }

  const sequence = await analyzeOriginSequence(normalized.action, dbHandle);
  if (sequence.issue === 'ORIGIN_SEQUENCE_COLLISION') {
    return result('INVALID_CONTRACT', sequence);
  }
  if (sequence.issue === 'OUT_OF_ORDER') {
    return result('OUT_OF_ORDER', sequence);
  }

  const clientUid = normalized.entities[0].entity_uid;
  const client = await getAsync(
    dbHandle,
    'SELECT 1 FROM clientes WHERE cliente_uid = ? LIMIT 1',
    [clientUid]
  );
  if (!client) return result('MISSING_DEPENDENCY', { entity_type: 'cliente', entity_uid: clientUid });

  return result('READY', {
    acao_uid: normalized.action.acao_uid,
    tipo: normalized.action.tipo,
    expected_sequence: sequence.expected_sequence,
  });
}

module.exports = {
  CONTRACT_VERSION,
  PILOT_TYPE,
  SyncContractError,
  validateEnvelope,
  deterministicStringify,
  serializeLocalAction,
  dryRunReceiveEnvelope,
};
