const MAX_RELEVANT_TURNS = 5;
const MAX_MEMORY_MESSAGES = 10;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const PENDING_CLARIFICATION_TTL_MS = 20 * 60 * 1000;
const PENDING_ACTION_DRAFT_TTL_MS = 20 * 60 * 1000;
const RESULT_SET_TTL_MS = 60 * 60 * 1000;
const MAX_RESULT_SETS = 12;
const MAX_RESULT_SET_IDS = 2000;
const MAX_RESULT_SETS_FOR_PLANNER = 4;
const PII_KEYS = new Set([
  'cpf', 'telefone', 'endereco', 'foto_cliente', 'referencia', 'observacao',
  'snapshot_emprestimo', 'snapshot_parcelas', 'detalhes', 'detalhes_json', 'meta_json',
]);
const ENTITY_ID_COLUMNS = Object.freeze({
  cliente: ['cliente_id'],
  emprestimo: ['emprestimo_id'],
  parcela: ['parcela_id'],
  pagamento: ['pagamento_id'],
});

const sessions = new Map();

function nowMs() {
  return Date.now();
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeShortText(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toPositiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function isISODate(value) {
  const text = sanitizeShortText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function normalizeText(value) {
  return sanitizeShortText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function cloneObject(value) {
  if (!isPlainObject(value)) return {};
  return { ...value };
}

function isSensitiveKey(key) {
  return PII_KEYS.has(sanitizeShortText(key).toLowerCase());
}

function sanitizeMetadata(rawValue, depth = 0) {
  if (depth > 2 || rawValue == null) return null;
  if (typeof rawValue === 'string') return sanitizeShortText(rawValue).slice(0, 160) || null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  if (typeof rawValue === 'boolean') return rawValue;
  if (Array.isArray(rawValue)) {
    return rawValue
      .slice(0, 12)
      .map((item) => sanitizeMetadata(item, depth + 1))
      .filter((item) => item != null);
  }
  if (!isPlainObject(rawValue)) return null;
  const out = {};
  for (const [key, value] of Object.entries(rawValue).slice(0, 20)) {
    const cleanKey = sanitizeShortText(key).slice(0, 80);
    if (!cleanKey || isSensitiveKey(cleanKey)) continue;
    const cleanValue = sanitizeMetadata(value, depth + 1);
    if (cleanValue != null) out[cleanKey] = cleanValue;
  }
  return out;
}

function normalizeEntityType(value) {
  const type = sanitizeShortText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENTITY_ID_COLUMNS, type) ? type : 'agregado';
}

function inferEntityType(value, rows) {
  const explicit = normalizeEntityType(value);
  if (explicit !== 'agregado') return explicit;
  const firstRow = Array.isArray(rows) ? rows.find((row) => isPlainObject(row)) : null;
  if (!firstRow) return 'agregado';
  for (const [entityType, columns] of Object.entries(ENTITY_ID_COLUMNS)) {
    if (columns.some((column) => toPositiveInteger(firstRow[column]) != null)) {
      return entityType;
    }
  }
  return 'agregado';
}

function getRowId(row, entityType) {
  if (!isPlainObject(row)) return null;
  const candidates = ENTITY_ID_COLUMNS[entityType] || [];
  for (const column of candidates) {
    const id = toPositiveInteger(row[column]);
    if (id != null) return id;
  }
  return entityType !== 'agregado' ? toPositiveInteger(row.id) : null;
}

function extractEntityIds(rows, entityType) {
  const ids = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = getRowId(row, entityType);
    if (id != null) ids.add(id);
    if (ids.size >= MAX_RESULT_SET_IDS) break;
  }
  return [...ids];
}

function normalizeScopeIds(rawIds) {
  return [...new Set((Array.isArray(rawIds) ? rawIds : [])
    .map((value) => toPositiveInteger(value))
    .filter((value) => value != null))]
    .slice(0, MAX_RESULT_SET_IDS);
}

function extractMetrics(rows, source) {
  const metrics = {
    returned_rows: Number(source && source.returned_rows) || 0,
    truncated: Boolean(source && source.truncated),
  };
  const firstRow = Array.isArray(rows) ? rows[0] : null;
  if (!isPlainObject(firstRow)) return metrics;
  for (const [key, value] of Object.entries(firstRow).slice(0, 16)) {
    if (isSensitiveKey(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    metrics[key] = value;
  }
  return metrics;
}

function compactResultSet(resultSet) {
  if (!isPlainObject(resultSet)) return null;
  return {
    result_set_id: sanitizeShortText(resultSet.result_set_id),
    type: normalizeEntityType(resultSet.type),
    description: sanitizeShortText(resultSet.description),
    entity_count: Array.isArray(resultSet.entity_ids) ? resultSet.entity_ids.length : 0,
    scope_complete: resultSet.scope_complete !== false,
    entity_count_lower_bound: Number(resultSet.entity_count_lower_bound) || 0,
    filters: sanitizeMetadata(resultSet.filters) || {},
    metrics: sanitizeMetadata(resultSet.metrics) || {},
    source_query: sanitizeMetadata(resultSet.source_query) || {},
    created_at: Number(resultSet.created_at) || null,
  };
}

function cleanupResultSets(session, referenceNow = nowMs()) {
  if (!session || !Array.isArray(session.result_sets)) return;
  session.result_sets = session.result_sets
    .filter((resultSet) => {
      const createdAt = Number(resultSet && resultSet.created_at);
      return Number.isFinite(createdAt) && referenceNow - createdAt <= RESULT_SET_TTL_MS;
    })
    .slice(-MAX_RESULT_SETS);
}

function createResultSet(session, candidate) {
  const raw = isPlainObject(candidate) ? candidate : {};
  const source = isPlainObject(raw.tool_result) ? raw.tool_result : {};
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const scope = isPlainObject(raw.semantic_scope) ? raw.semantic_scope : {};
  const entityType = inferEntityType(scope.entity_type || raw.entity_type, rows);
  const hasSemanticScope = Array.isArray(scope.entity_ids);
  const scopeIds = normalizeScopeIds(scope.entity_ids);
  const entityIds = hasSemanticScope ? scopeIds : extractEntityIds(rows, entityType);
  const scopeComplete = hasSemanticScope
    ? Boolean(scope.scope_complete)
    : true;
  const resultSet = {
    result_set_id: `rs_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: entityType,
    // A descricao e derivada do tipo estrutural, nunca de linhas retornadas
    // nem de texto livre que possa transportar dados pessoais.
    description: `Resultado financeiro de ${entityType}`,
    entity_ids: entityIds,
    scope_complete: scopeComplete,
    entity_count_lower_bound: hasSemanticScope
      ? Number(scope.entity_count_lower_bound || entityIds.length)
      : entityIds.length,
    filters: sanitizeMetadata(raw.filters) || {},
    metrics: extractMetrics(rows, source),
    source_query: {
      tool_name: 'query_financial_data',
      sql_fingerprint: sanitizeShortText(source.sql_fingerprint).slice(0, 80),
      reused_result_set_id: sanitizeShortText(raw.reused_result_set_id).slice(0, 120) || null,
    },
    created_at: nowMs(),
  };
  session.result_sets.push(resultSet);
  cleanupResultSets(session);
  const active = isPlainObject(session.active_entities) ? session.active_entities : {};
  if (entityIds.length) active[entityType] = entityIds.slice(0, 20);
  session.active_entities = active;
  session.last_financial_query = resultSet;
  return resultSet;
}

function cleanupExpiredSessions() {
  const now = nowMs();
  for (const [key, session] of sessions.entries()) {
    const updatedAt = Number(session && session.updated_at);
    if (!Number.isFinite(updatedAt) || now - updatedAt > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
}

function ensureSession(sessionId) {
  cleanupExpiredSessions();
  const key = sanitizeShortText(sessionId, '__default__');
  const existing = sessions.get(key);
  if (existing && isPlainObject(existing)) {
    existing.updated_at = nowMs();
    return existing;
  }

  const created = {
    session_id: key,
    updated_at: nowMs(),
    turns: [],
    active_context: {},
    active_entities: {},
    result_sets: [],
    last_financial_query: null,
    pending_clarification: null,
    pending_action_draft: null,
  };
  sessions.set(key, created);
  return created;
}

function sanitizeEntities(rawValue) {
  if (!isPlainObject(rawValue)) return {};
  const out = {};
  for (const [key, value] of Object.entries(rawValue)) {
    const cleanKey = sanitizeShortText(key);
    if (!cleanKey) continue;
    if (typeof value === 'string') {
      const v = sanitizeShortText(value);
      if (!v) continue;
      out[cleanKey] = v.slice(0, 200);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[cleanKey] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      out[cleanKey] = value;
    }
  }
  return out;
}

function sanitizeResolvedContext(rawValue) {
  if (!isPlainObject(rawValue)) return {};
  const out = {};
  for (const [key, value] of Object.entries(rawValue)) {
    const cleanKey = sanitizeShortText(key);
    if (!cleanKey) continue;
    if (value == null) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[cleanKey] = value;
      continue;
    }
    if (typeof value === 'string') {
      const cleanValue = sanitizeShortText(value);
      if (!cleanValue) continue;
      out[cleanKey] = cleanValue.slice(0, 200);
      continue;
    }
    if (typeof value === 'boolean') {
      out[cleanKey] = value;
    }
  }
  return out;
}

function extractIdsFromContext({ entities, resolvedContext, toolName, toolArgs }) {
  const ent = isPlainObject(entities) ? entities : {};
  const ctx = isPlainObject(resolvedContext) ? resolvedContext : {};
  const args = isPlainObject(toolArgs) ? toolArgs : {};
  const tool = sanitizeShortText(toolName).toLowerCase();

  const clienteId = toPositiveInteger(
    ctx.cliente_id || ent.cliente_id || ent.id || args.id
  );
  const emprestimoId = toPositiveInteger(
    ctx.emprestimo_id || ent.emprestimo_id || args.emprestimo_id
  );
  const parcelaId = toPositiveInteger(
    ctx.parcela_id || ent.parcela_id || args.parcela_id
  );

  if (tool === 'emprestimo_detalhe') {
    return {
      cliente_id: clienteId,
      emprestimo_id: toPositiveInteger(args.emprestimo_id || emprestimoId),
      parcela_id: parcelaId,
    };
  }
  if (tool === 'cliente_busca') {
    return {
      cliente_id: toPositiveInteger(args.id || clienteId),
      emprestimo_id: emprestimoId,
      parcela_id: parcelaId,
    };
  }
  return {
    cliente_id: clienteId,
    emprestimo_id: emprestimoId,
    parcela_id: parcelaId,
  };
}

function updateActiveContext(session, payload) {
  const base = isPlainObject(session.active_context) ? session.active_context : {};
  const next = { ...base };
  const ids = extractIdsFromContext(payload || {});

  if (ids.cliente_id != null) next.cliente_id = ids.cliente_id;
  if (ids.emprestimo_id != null) next.emprestimo_id = ids.emprestimo_id;
  if (ids.parcela_id != null) next.parcela_id = ids.parcela_id;

  const intent = sanitizeShortText(payload && payload.intent);
  const questionType = sanitizeShortText(payload && payload.questionType);
  if (intent) next.intent = intent;
  if (questionType) next.question_type = questionType;

  next.updated_at = nowMs();
  session.active_context = next;
}

function resetSessionMemory(sessionId) {
  const session = ensureSession(sessionId);
  session.turns = [];
  session.active_context = {};
  session.active_entities = {};
  session.result_sets = [];
  session.last_financial_query = null;
  session.pending_clarification = null;
  session.pending_action_draft = null;
  session.updated_at = nowMs();
  return true;
}

function sanitizePendingActionDraft(raw) {
  const { actionRegistry } = require('./actions/actionRegistry');
  if (!isPlainObject(raw)) return null;
  const action = sanitizeShortText(raw.action);
  const definition = actionRegistry.get(action);
  if (!definition) return null;
  const ids = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map(toPositiveInteger).filter((value) => value != null))].slice(0, 20);
  const candidate = isPlainObject(raw.candidate_entities) ? raw.candidate_entities : {};
  const sourceArgs = isPlainObject(raw.arguments) ? raw.arguments : raw;
  const args = {};
  for (const field of definition.required_fields) {
    if (field === 'cliente_id' || field === 'emprestimo_id') args[field] = toPositiveInteger(sourceArgs[field]);
    else if (field === 'valor') { const value = Number(sourceArgs.valor); args.valor = Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null; }
    else if (field === 'data') args.data = isISODate(sanitizeShortText(sourceArgs.data)) ? sanitizeShortText(sourceArgs.data) : null;
    else if (field === 'tipo_pagamento') args.tipo_pagamento = 'normal';
  }
  return {
    action,
    arguments: args,
    // Aliases de leitura mantem consumidores legados compatíveis; a fonte de
    // verdade do rascunho continua sendo arguments, por acao registrada.
    ...args,
    candidate_entities: {
      cliente: ids(candidate.cliente),
      emprestimo: ids(candidate.emprestimo),
    },
    entity_sources: sanitizeMetadata(raw.entity_sources) || {},
    created_at: Number(raw.created_at) || nowMs(),
    updated_at: Number(raw.updated_at) || nowMs(),
  };
}

function pendingActionDraftMissingFields(draft) {
  if (!draft) return [];
  const { actionRegistry } = require('./actions/actionRegistry');
  const definition = actionRegistry.get(draft.action);
  const args = draft.arguments || {};
  return definition ? definition.required_fields.filter((field) => args[field] == null) : [];
}

function getPendingActionDraft(sessionId, referenceNow = nowMs()) {
  const session = ensureSession(sessionId);
  const draft = sanitizePendingActionDraft(session.pending_action_draft);
  if (!draft || Number(referenceNow) - Number(draft.updated_at) > PENDING_ACTION_DRAFT_TTL_MS) {
    session.pending_action_draft = null;
    return null;
  }
  return { ...draft, missing_fields: pendingActionDraftMissingFields(draft) };
}

function savePendingActionDraft(sessionId, rawDraft) {
  const session = ensureSession(sessionId);
  const draft = sanitizePendingActionDraft(rawDraft);
  if (!draft) return null;
  session.pending_action_draft = { ...draft, updated_at: nowMs() };
  session.updated_at = nowMs();
  return getPendingActionDraft(sessionId);
}

function clearPendingActionDraft(sessionId) {
  const session = ensureSession(sessionId);
  session.pending_action_draft = null;
  session.updated_at = nowMs();
  return true;
}

function invalidateFinancialResultSets(sessionId) {
  const session = ensureSession(sessionId);
  session.result_sets = [];
  session.last_financial_query = null;
  session.active_entities = {};
  session.updated_at = nowMs();
  return true;
}

// A mudanca de assunto e decidida pelo modelo a partir do contexto estruturado.
// Esta funcao e mantida por compatibilidade, sem interpretar texto por palavras-chave.
function maybeResetSessionContext(sessionId) {
  ensureSession(sessionId);
  return false;
}

function recordConversationTurn({
  sessionId,
  turnId,
  userText,
  answerText,
  mode = 'answer',
  intent = '',
  questionType = '',
  entities = {},
  resolvedContext = {},
  toolName = '',
  toolArgs = {},
  financialResult = null,
}) {
  const session = ensureSession(sessionId);
  const entry = {
    turn_id: sanitizeShortText(turnId) || null,
    user_text: sanitizeShortText(userText).slice(0, 1200),
    answer_text: sanitizeShortText(answerText).slice(0, 1200),
    mode: sanitizeShortText(mode, 'answer').toLowerCase(),
    intent: sanitizeShortText(intent),
    question_type: sanitizeShortText(questionType),
    entities: sanitizeEntities(entities),
    resolved_context: sanitizeResolvedContext(resolvedContext),
    tool_name: sanitizeShortText(toolName),
    tool_args: sanitizeResolvedContext(toolArgs),
    created_at: nowMs(),
  };

  if (!entry.user_text && !entry.answer_text) return;

  session.turns.push(entry);
  if (session.turns.length > MAX_RELEVANT_TURNS) {
    session.turns = session.turns.slice(session.turns.length - MAX_RELEVANT_TURNS);
  }
  updateActiveContext(session, {
    entities: entry.entities,
    resolvedContext: entry.resolved_context,
    toolName: entry.tool_name,
    toolArgs: entry.tool_args,
    intent: entry.intent,
    questionType: entry.question_type,
  });
  const resultSet = financialResult ? createResultSet(session, financialResult) : null;
  session.updated_at = nowMs();
  return {
    result_set: compactResultSet(resultSet),
  };
}

function mapTurnsToConversation(turns) {
  const out = [];
  for (const turn of turns || []) {
    if (!isPlainObject(turn)) continue;
    const turnId = sanitizeShortText(turn.turn_id) || null;
    const userText = sanitizeShortText(turn.user_text);
    const answerText = sanitizeShortText(turn.answer_text);
    if (userText) {
      out.push({
        role: 'user',
        text: userText.slice(0, 1000),
        quality: 'unknown',
        turn_id: turnId,
      });
    }
    if (answerText) {
      out.push({
        role: 'assistant',
        text: answerText.slice(0, 1000),
        quality: 'unknown',
        turn_id: turnId,
      });
    }
  }
  if (out.length <= MAX_MEMORY_MESSAGES) return out;
  return out.slice(out.length - MAX_MEMORY_MESSAGES);
}

function getSessionConversationContext(sessionId) {
  const session = ensureSession(sessionId);
  return mapTurnsToConversation(session.turns || []);
}

function getSessionMemorySnapshot(sessionId) {
  const session = ensureSession(sessionId);
  cleanupResultSets(session);
  const pending = getPendingClarification(sessionId);
  return {
    active_context: cloneObject(session.active_context),
    recent_turns: Array.isArray(session.turns)
      ? session.turns.map((turn) => ({
          turn_id: sanitizeShortText(turn.turn_id) || null,
          intent: sanitizeShortText(turn.intent),
          question_type: sanitizeShortText(turn.question_type),
          entities: sanitizeEntities(turn.entities),
          mode: sanitizeShortText(turn.mode),
          created_at: turn.created_at || null,
        }))
      : [],
    active_entities: sanitizeMetadata(session.active_entities) || {},
    result_sets: (session.result_sets || [])
      .slice(-MAX_RESULT_SETS_FOR_PLANNER)
      .map((resultSet) => compactResultSet(resultSet))
      .filter(Boolean),
    last_financial_query: compactResultSet(session.last_financial_query),
    pending_clarification: pending,
    pending_action_draft: getPendingActionDraft(sessionId),
  };
}

function getResultSetById(sessionId, resultSetId) {
  const session = ensureSession(sessionId);
  cleanupResultSets(session);
  const id = sanitizeShortText(resultSetId);
  if (!id) return null;
  const found = (session.result_sets || []).find((resultSet) => resultSet.result_set_id === id);
  if (!found) return null;
  return {
    result_set_id: found.result_set_id,
    entity_type: found.type,
    entity_ids: Array.isArray(found.entity_ids) ? found.entity_ids.slice(0, MAX_RESULT_SET_IDS) : [],
    scope_complete: found.scope_complete !== false,
  };
}

function pruneResultSets(sessionId, referenceNow) {
  const session = ensureSession(sessionId);
  cleanupResultSets(session, Number.isFinite(Number(referenceNow)) ? Number(referenceNow) : nowMs());
  return (session.result_sets || []).map((resultSet) => compactResultSet(resultSet)).filter(Boolean);
}

function mergeConversationContexts(externalContext, memoryContext) {
  const merged = [];
  const seen = new Set();
  const pushUnique = (item) => {
    if (!isPlainObject(item)) return;
    const role = sanitizeShortText(item.role).toLowerCase();
    const text = sanitizeShortText(item.text);
    if ((role !== 'user' && role !== 'assistant') || !text) return;
    const turnId = sanitizeShortText(item.turn_id || item.turnId);
    const key = `${role}|${turnId}|${text.slice(0, 180)}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({
      role,
      text: text.slice(0, 1000),
      quality: sanitizeShortText(item.quality, 'unknown'),
      turn_id: turnId || null,
    });
  };

  for (const item of Array.isArray(memoryContext) ? memoryContext : []) {
    pushUnique(item);
  }
  for (const item of Array.isArray(externalContext) ? externalContext : []) {
    pushUnique(item);
  }
  if (merged.length <= MAX_MEMORY_MESSAGES) return merged;
  return merged.slice(merged.length - MAX_MEMORY_MESSAGES);
}

function sanitizePendingCandidate(candidate) {
  if (!isPlainObject(candidate)) return null;
  const toolName = sanitizeShortText(candidate.tool_name);
  const toolArgs = sanitizeResolvedContext(candidate.tool_args);
  if (!toolName) return null;
  return {
    label: sanitizeShortText(candidate.label, toolName),
    tool_name: toolName,
    tool_args: toolArgs,
    intent: sanitizeShortText(candidate.intent),
    resolved_context: sanitizeResolvedContext(candidate.resolved_context),
  };
}

function setPendingClarification(sessionId, payload) {
  const session = ensureSession(sessionId);
  const raw = isPlainObject(payload) ? payload : {};
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options = rawOptions
    .map((item) => sanitizeShortText(item))
    .filter(Boolean)
    .slice(0, 5);

  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const candidates = rawCandidates
    .map((item) => sanitizePendingCandidate(item))
    .filter(Boolean)
    .slice(0, 5);

  if (options.length < 2) {
    session.pending_clarification = null;
    session.updated_at = nowMs();
    return null;
  }

  const resolvedOptions = candidates.length >= 2
    ? options.slice(0, candidates.length)
    : options;

  const pending = {
    created_at: nowMs(),
    original_question: sanitizeShortText(raw.original_question).slice(0, 1000),
    original_intent: sanitizeShortText(raw.original_intent),
    options: resolvedOptions,
    candidates,
  };
  session.pending_clarification = pending;
  session.updated_at = nowMs();
  return pending;
}

function clearPendingClarification(sessionId) {
  const session = ensureSession(sessionId);
  session.pending_clarification = null;
  session.updated_at = nowMs();
}

function getPendingClarification(sessionId) {
  const session = ensureSession(sessionId);
  const pending = isPlainObject(session.pending_clarification)
    ? session.pending_clarification
    : null;
  if (!pending) return null;
  const createdAt = Number(pending.created_at || 0);
  if (!Number.isFinite(createdAt) || nowMs() - createdAt > PENDING_CLARIFICATION_TTL_MS) {
    session.pending_clarification = null;
    session.updated_at = nowMs();
    return null;
  }
  return {
    ...pending,
    options: Array.isArray(pending.options) ? pending.options.slice(0, 5) : [],
    candidates: Array.isArray(pending.candidates) ? pending.candidates.slice(0, 5) : [],
  };
}

function parseOptionSelection(userText, maxOption) {
  const text = normalizeText(userText);
  if (!text) return null;
  const directNumber = Number(text);
  if (Number.isInteger(directNumber) && directNumber >= 1 && directNumber <= maxOption) {
    return directNumber;
  }

  const normalized = text.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return null;
  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return null;

  if (tokens.length === 1) {
    const value = Number(tokens[0]);
    if (Number.isInteger(value) && value >= 1 && value <= maxOption) {
      return value;
    }
    if (tokens[0] === 'primeira' || tokens[0] === 'primeiro') return 1;
    if (tokens[0] === 'segunda' || tokens[0] === 'segundo') return 2;
    if (tokens[0] === 'terceira' || tokens[0] === 'terceiro') return 3;
  }

  for (const token of tokens) {
    const value = Number(token);
    if (Number.isInteger(value) && value >= 1 && value <= maxOption) {
      return value;
    }
  }

  return null;
}

function resolvePendingClarificationSelection({ sessionId, userText }) {
  const pending = getPendingClarification(sessionId);
  if (!pending) {
    return {
      status: 'none',
      selection: null,
      pending: null,
      candidate: null,
    };
  }

  const optionCount = Array.isArray(pending.options) ? pending.options.length : 0;
  if (!optionCount) {
    clearPendingClarification(sessionId);
    return {
      status: 'none',
      selection: null,
      pending: null,
      candidate: null,
    };
  }

  const selection = parseOptionSelection(userText, optionCount);
  if (selection == null) {
    return {
      status: 'pending',
      selection: null,
      pending,
      candidate: null,
    };
  }

  const candidate = Array.isArray(pending.candidates)
    ? pending.candidates[selection - 1] || null
    : null;
  clearPendingClarification(sessionId);
  return {
    status: 'resolved',
    selection,
    pending,
    candidate,
  };
}

function applyActiveContextToScreenContext(screenContext, activeContext) {
  const ctx = isPlainObject(screenContext) ? { ...screenContext } : {};
  const selected = isPlainObject(ctx.selected_ids) ? { ...ctx.selected_ids } : {};
  const active = isPlainObject(activeContext) ? activeContext : {};

  if (selected.cliente == null && toPositiveInteger(active.cliente_id) != null) {
    selected.cliente = toPositiveInteger(active.cliente_id);
  }
  if (selected.emprestimo == null && toPositiveInteger(active.emprestimo_id) != null) {
    selected.emprestimo = toPositiveInteger(active.emprestimo_id);
  }
  if (selected.parcela == null && toPositiveInteger(active.parcela_id) != null) {
    selected.parcela = toPositiveInteger(active.parcela_id);
  }
  ctx.selected_ids = selected;
  return ctx;
}

module.exports = {
  applyActiveContextToScreenContext,
  clearPendingClarification,
  getPendingClarification,
  getPendingActionDraft,
  savePendingActionDraft,
  clearPendingActionDraft,
  getSessionConversationContext,
  getSessionMemorySnapshot,
  getResultSetById,
  pruneResultSets,
  maybeResetSessionContext,
  mergeConversationContexts,
  recordConversationTurn,
  resolvePendingClarificationSelection,
  setPendingClarification,
  resetSessionMemory,
  invalidateFinancialResultSets,
  __internal: {
    cleanupResultSets,
    compactResultSet,
    createResultSet,
    inferEntityType,
    RESULT_SET_TTL_MS,
    MAX_RESULT_SETS,
    MAX_RESULT_SET_IDS,
    PENDING_ACTION_DRAFT_TTL_MS,
    pendingActionDraftMissingFields,
  },
};
