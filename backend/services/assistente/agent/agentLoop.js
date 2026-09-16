const {
  getToolCatalog,
  sanitizeScreenContext,
  validateToolCall,
  isPlainObject,
} = require('../contracts');
const { resolveToolCallWithContext } = require('../contextResolver');
const { executeRepoReadTool } = require('../tools/repoReadTools');
const { decideKnowledgeSource } = require('../repoReadPolicy');
const {
  routeAssistantIntent,
  normalizeText,
} = require('./intentRouter');
const { planWithLLM } = require('./planningLLM');
const { generateAnswerWithLLM } = require('./answerLLM');
const { createActionPreviewFromPlan } = require('../actions/actionProposal');
const { getActionGateway } = require('../actions/actionGatewayInstance');
const { getResultSetById } = require('../conversationMemory');
const {
  getPendingActionDraft,
  savePendingActionDraft,
  clearPendingActionDraft,
} = require('../conversationMemory');
const { safeDraft, resolutionEntitiesFromRows } = require('../actions/actionDraft');
const {
  discoverActiveDatabase,
  inspectDatabaseSchema,
  executeReadOnlySql,
  executeScopeReadOnlySql,
  readBackendLogs,
  fetchInternalEndpoint,
  isReadOnlySql,
} = require('./runtimeReadTools');
const { buildVerificationReport } = require('./verifier');
const {
  buildDomainAnswer,
  buildCodeEvidenceAnswer,
  buildLogAnswer,
  buildSourceFootnote,
  composeFinalAnswer,
} = require('./responseComposer');

function sanitizeText(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

const FINANCIAL_SCHEMA_TABLES = new Set([
  'clientes',
  'emprestimos',
  'parcelas',
  'parcelas_originais',
  'pagamentos',
  'renegociacoes',
  'renegociacoes_historico',
  'recalculos_atraso',
  'notificacoes',
  'caixa_movimentos',
]);
const PRIVATE_SCHEMA_COLUMNS = new Set([
  'cpf',
  'telefone',
  'endereco',
  'foto_cliente',
  'referencia',
  'observacao',
  'snapshot_emprestimo',
  'snapshot_parcelas',
  'detalhes',
  'detalhes_json',
  'meta_json',
]);
const FINANCIAL_SCOPE_ENTITIES = Object.freeze({
  cliente: 'clientes',
  emprestimo: 'emprestimos',
  parcela: 'parcelas',
  pagamento: 'pagamentos',
});
const FINANCIAL_SCOPE_ENTITY_TYPES = new Set(Object.keys(FINANCIAL_SCOPE_ENTITIES));
const MAX_ACTION_RESOLUTION_ITERATIONS = 5;

function normalizeSqlForScopeValidation(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function countTableReferences(sql, tableName) {
  const matches = normalizeSqlForScopeValidation(sql)
    .match(new RegExp(`\\b(?:from|join)\\s+${tableName}\\b`, 'g'));
  return matches ? matches.length : 0;
}

function isScopeSqlForEntity(sql, entityType) {
  const tableName = FINANCIAL_SCOPE_ENTITIES[entityType];
  if (!tableName || !isReadOnlySql(sql)) return false;
  const normalized = normalizeSqlForScopeValidation(sql);
  const expectedProjection = new RegExp(
    `^select(?: distinct)? scope_root\\.id as entity_id from ${tableName} as scope_root\\b`
  );
  return expectedProjection.test(normalized) && countTableReferences(normalized, tableName) >= 1;
}

function isAnalyticSqlBoundToScope(sql, entityType) {
  const tableName = FINANCIAL_SCOPE_ENTITIES[entityType];
  if (!tableName || !isReadOnlySql(sql, { allowSemanticResultSet: true })) return false;
  const normalized = normalizeSqlForScopeValidation(sql);
  // O escopo contem todos os filtros. A analise so agrega/ordena esse universo,
  // sem CTEs, subconsultas ou filtros paralelos que poderiam reconstruir outro.
  if ((normalized.match(/\bselect\b/g) || []).length !== 1) return false;
  if (/\b(?:with|where|having|union|intersect|except|cross join)\b/.test(normalized)) return false;
  const requiredJoin = new RegExp(
    `\\bfrom ${tableName} as scope_root join semantic_result_set as scope_ids on ` +
    `(?:scope_ids\\.entity_id = scope_root\\.id|scope_root\\.id = scope_ids\\.entity_id)\\b`
  );
  if (!requiredJoin.test(normalized)) return false;
  return countTableReferences(normalized, tableName) === 1 &&
    countTableReferences(normalized, 'semantic_result_set') === 1;
}

// Relacoes de dominio expostas ao planejador. Sao apenas metadados de leitura:
// nenhuma consulta e montada a partir delas sem passar pela validacao SQL.
const FINANCIAL_SCHEMA_RELATIONS = Object.freeze([
  ['emprestimos', 'cliente_id', 'clientes', 'id'],
  ['parcelas', 'emprestimo_id', 'emprestimos', 'id'],
  ['parcelas_originais', 'emprestimo_id', 'emprestimos', 'id'],
  ['pagamentos', 'emprestimo_id', 'emprestimos', 'id'],
  ['renegociacoes', 'antigo_id', 'emprestimos', 'id'],
  ['renegociacoes', 'novo_id', 'emprestimos', 'id'],
  ['renegociacoes_historico', 'emprestimo_id', 'emprestimos', 'id'],
  ['recalculos_atraso', 'emprestimo_id', 'emprestimos', 'id'],
  ['notificacoes', 'emprestimo_id', 'emprestimos', 'id'],
  ['notificacoes', 'parcela_id', 'parcelas', 'id'],
  ['caixa_movimentos', 'cliente_id', 'clientes', 'id'],
  ['caixa_movimentos', 'emprestimo_id', 'emprestimos', 'id'],
  ['caixa_movimentos', 'parcela_id', 'parcelas', 'id'],
]);

function buildFinancialSchemaForPlanning(schema) {
  const objects = Array.isArray(schema && schema.objects) ? schema.objects : [];
  const tables = objects
    .filter((item) => item && item.type === 'table' && FINANCIAL_SCHEMA_TABLES.has(item.name))
    .map((item) => ({
      name: item.name,
      columns: (Array.isArray(item.columns) ? item.columns : [])
        .map((column) => String(column && column.name ? column.name : '').trim())
        .filter((name) => name && !PRIVATE_SCHEMA_COLUMNS.has(name))
        .slice(0, 40),
    }))
    .filter((item) => item.columns.length > 0)
    .slice(0, 20);
  const tableNames = new Set(tables.map((table) => table.name));
  const columnSetByTable = new Map(tables.map((table) => [table.name, new Set(table.columns)]));
  const relations = FINANCIAL_SCHEMA_RELATIONS
    .filter(([fromTable, fromColumn, toTable, toColumn]) => (
      tableNames.has(fromTable) && tableNames.has(toTable) &&
      columnSetByTable.get(fromTable).has(fromColumn) &&
      columnSetByTable.get(toTable).has(toColumn)
    ))
    .map(([from_table, from_column, to_table, to_column]) => ({
      from_table,
      from_column,
      to_table,
      to_column,
    }));

  return {
    source: 'runtime_schema_overview',
    read_only: true,
    tables,
    relations,
    financial_semantics: {
      canonical_parcela: [
        'Para status operacional, exclua parcelas com numero = -1.',
        'Para uma mesma combinacao emprestimo_id + numero, use somente a maior id.',
        'Quando houver JOIN com emprestimos, use (parcelas.versao IS NULL OR parcelas.versao = emprestimos.versao_atual).',
      ],
      open_parcela: 'Parcela em aberto: pago nao e 1 e valor_pago + 0.009 < CASE WHEN valor_total > 0 THEN valor_total + COALESCE(juros_adicionais, 0) ELSE COALESCE(valor_capital, 0) + COALESCE(valor_juros, 0) + COALESCE(juros_adicionais, 0) + COALESCE(juros_pendentes, 0) END.',
      debt: 'Saldo em aberto por parcela: MAX(total_devido - COALESCE(valor_pago, 0), 0), usando a mesma formula de total_devido.',
      dates: 'Use date(...) ou strftime(...) para comparacoes de datas e explique quando a pergunta nao definir periodo.',
    },
  };
}

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function shiftISO(baseISO, deltaDays) {
  const dt = new Date(`${baseISO}T00:00:00`);
  dt.setDate(dt.getDate() + Number(deltaDays || 0));
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function buildMonthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    de: start,
    ate: end,
  };
}

function buildWeekRange(weekOffset) {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset + (weekOffset * 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const toISO = (d) => {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };

  return {
    de: toISO(monday),
    ate: toISO(sunday),
  };
}

const WEEKDAY_MAP = Object.freeze({
  domingo: 0,
  dom: 0,
  segunda: 1,
  seg: 1,
  terca: 2,
  ter: 2,
  quarta: 3,
  qua: 3,
  quinta: 4,
  qui: 4,
  sexta: 5,
  sex: 5,
  sabado: 6,
  sab: 6,
});

function nextWeekdayISO(baseISO, targetDay, includeToday = true) {
  const base = new Date(`${baseISO}T00:00:00`);
  if (Number.isNaN(base.getTime())) return '';

  const currentDay = base.getDay();
  let delta = (Number(targetDay) - currentDay + 7) % 7;
  if (!includeToday && delta === 0) delta = 7;
  return shiftISO(baseISO, delta);
}

function detectWeekdayTarget(text) {
  const normalized = normalizeText(text);
  const matches = [];
  for (const [token, day] of Object.entries(WEEKDAY_MAP)) {
    const re = new RegExp(`\\b${token}\\b`, 'i');
    const found = normalized.match(re);
    if (!found) continue;
    const idx = normalized.indexOf(token);
    matches.push({ token, day, index: idx >= 0 ? idx : 9999 });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.index - b.index);
  return matches[0];
}

function parseDateRangeFromText(userText) {
  const text = normalizeText(userText);
  const lexicalText = ` ${text.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const isoMatches = Array.from(String(userText || '').matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g))
    .map((m) => String(m[1] || '').trim())
    .filter(Boolean);

  if (isoMatches.length >= 2) {
    const sorted = isoMatches.slice(0, 2).sort();
    return {
      reference: 'iso_explicit_range',
      de: sorted[0],
      ate: sorted[1],
    };
  }

  if (isoMatches.length === 1) {
    return {
      reference: 'iso_explicit_day',
      de: isoMatches[0],
      ate: isoMatches[0],
    };
  }

  const yearRange = text.match(/\b(20\d{2})\b[^\d]{0,24}\b(20\d{2})\b/);
  if (yearRange) {
    const y1 = Number(yearRange[1]);
    const y2 = Number(yearRange[2]);
    if (Math.abs(y1 - y2) <= 20) {
      const start = Math.min(y1, y2);
      const end = Math.max(y1, y2);
      return {
        reference: 'year_explicit_range',
        de: `${start}-01-01`,
        ate: `${end}-12-31`,
      };
    }
  }

  const yearsFound = Array.from(text.matchAll(/\b(20\d{2})\b/g))
    .map((m) => Number(m[1]))
    .filter((y) => Number.isInteger(y));
  if (yearsFound.length >= 2 && (text.includes('ate') || text.includes('entre') || text.includes(' a '))) {
    const y1 = yearsFound[0];
    const y2 = yearsFound[1];
    const start = Math.min(y1, y2);
    const end = Math.max(y1, y2);
    return {
      reference: 'year_explicit_range_loose',
      de: `${start}-01-01`,
      ate: `${end}-12-31`,
    };
  }

  const singleYear = text.match(/\b(20\d{2})\b/);
  if (singleYear && !text.includes('ate') && !text.includes(' a ')) {
    const year = Number(singleYear[1]);
    return {
      reference: 'year_explicit_single',
      de: `${year}-01-01`,
      ate: `${year}-12-31`,
    };
  }

  const today = todayISO();
  const weekday = detectWeekdayTarget(text);
  const hasAteLike =
    lexicalText.includes(' ate ') ||
    lexicalText.includes(' at ') ||
    lexicalText.startsWith('ate ');
  const hasDeHoje = lexicalText.includes(' de hoje ');
  const hasHoje = lexicalText.includes(' hoje ');

  if (weekday && (hasAteLike || hasDeHoje)) {
    const end = nextWeekdayISO(today, weekday.day, true);
    return {
      reference: 'today_to_weekday',
      de: today,
      ate: end,
    };
  }

  if (
    weekday &&
    !hasDeHoje &&
    !hasAteLike &&
    !hasHoje &&
    (lexicalText.includes(' agora ') || lexicalText.includes(' proximo ') || lexicalText.includes(' nesse '))
  ) {
    const day = nextWeekdayISO(today, weekday.day, true);
    return {
      reference: 'weekday_single',
      de: day,
      ate: day,
    };
  }

  if (text.includes('hoje')) {
    return { reference: 'today', de: today, ate: today };
  }
  if (text.includes('ontem')) {
    const yesterday = shiftISO(today, -1);
    return { reference: 'yesterday', de: yesterday, ate: yesterday };
  }
  if (text.includes('amanha')) {
    const tomorrow = shiftISO(today, 1);
    return { reference: 'tomorrow', de: tomorrow, ate: tomorrow };
  }

  if (text.includes('semana passada')) {
    const week = buildWeekRange(-1);
    return { reference: 'last_week', ...week };
  }
  if (text.includes('semana que vem') || text.includes('proxima semana')) {
    const week = buildWeekRange(1);
    return { reference: 'next_week', ...week };
  }
  if (text.includes('esta semana') || text.includes('nessa semana')) {
    const week = buildWeekRange(0);
    return { reference: 'current_week', ...week };
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (text.includes('mes passado')) {
    let y = year;
    let m = month - 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    const range = buildMonthRange(y, m);
    return { reference: 'last_month', ...range };
  }

  if (text.includes('proximo mes') || text.includes('mes que vem')) {
    let y = year;
    let m = month + 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const range = buildMonthRange(y, m);
    return { reference: 'next_month', ...range };
  }

  if (text.includes('este mes') || text.includes('nesse mes')) {
    const range = buildMonthRange(year, month);
    return { reference: 'current_month', ...range };
  }

  if (text.includes('ano passado')) {
    return { reference: 'last_year', de: `${year - 1}-01-01`, ate: `${year - 1}-12-31` };
  }
  if (text.includes('este ano') || text.includes('nesse ano')) {
    return { reference: 'current_year', de: `${year}-01-01`, ate: `${year}-12-31` };
  }

  return {
    reference: 'undefined',
    de: '',
    ate: '',
  };
}

function inferParcelasTipo(text) {
  if (text.includes('vencid') || text.includes('atrasad')) return 'vencidas';
  if (text.includes('vencendo') || text.includes('vence') || text.includes('vencer')) return 'vencendo';
  return 'todas';
}

function inferDomainToolByHeuristics({ userText, screenContext }) {
  const text = normalizeText(userText);
  const selected = isPlainObject(screenContext && screenContext.selected_ids)
    ? screenContext.selected_ids
    : {};

  const emprestimoMatch = text.match(/emprestimo\s*#?\s*(\d+)/i);
  const clienteMatch = text.match(/cliente\s*#?\s*(\d+)/i);
  const forecastSignals = [
    'vou receber',
    'previsao',
    'previsto',
    'se pagar',
    'se pagarem',
    'pagarem certinho',
    'receber de',
  ];
  const isForecastQuery =
    forecastSignals.some((term) => text.includes(term)) ||
    (text.includes('receber') && !text.includes('recebi') && (text.includes('ate') || text.includes('de hoje')));

  if (text.includes('notific')) {
    return {
      tool_name: 'notificacoes_pendentes',
      tool_args: {},
      confidence: 0.95,
      intent: 'fila_alertas',
    };
  }

  const emprestimoId = Number(emprestimoMatch && emprestimoMatch[1]) || Number(selected.emprestimo || 0);
  if (text.includes('emprestimo') && Number.isFinite(emprestimoId) && emprestimoId > 0) {
    return {
      tool_name: 'emprestimo_detalhe',
      tool_args: { emprestimo_id: emprestimoId },
      confidence: 0.93,
      intent: 'detalhe_emprestimo',
    };
  }

  const clienteId = Number(clienteMatch && clienteMatch[1]) || Number(selected.cliente || 0);
  if (text.includes('cliente') && clienteId > 0) {
    return {
      tool_name: 'cliente_busca',
      tool_args: { id: clienteId },
      confidence: 0.9,
      intent: 'busca_cliente',
    };
  }

  if (isForecastQuery) {
    const range = parseDateRangeFromText(userText);
    if (!range.de || !range.ate) {
      return {
        needs_clarification: true,
        clarification_question: 'Informe o periodo da previsao de recebimento (data inicial e final).',
      };
    }
    return {
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: 'vencendo',
        de: range.de,
        ate: range.ate,
        incluirPagas: false,
      },
      confidence: 0.92,
      intent: 'previsao_recebimento_parcelas',
    };
  }

  if (text.includes('caixa') || text.includes('recebi') || text.includes('entrou') || text.includes('juros') || text.includes('capital')) {
    const range = parseDateRangeFromText(userText);
    if (!range.de || !range.ate) {
      return {
        needs_clarification: true,
        clarification_question: 'Informe o periodo da consulta de caixa (ex.: hoje, este mes ou data inicial/final).',
      };
    }
    return {
      tool_name: 'caixa_resumo',
      tool_args: {
        periodo: range.de === range.ate ? 'dia' : 'custom',
        de: range.de,
        ate: range.ate,
      },
      confidence: 0.9,
      intent: 'resumo_caixa',
    };
  }

  if (text.includes('parcela') || text.includes('venc') || text.includes('pagou') || text.includes('pagaram') || text.includes('devo') || text.includes('atrasad')) {
    const range = parseDateRangeFromText(userText);
    if (!range.de || !range.ate) {
      return {
        needs_clarification: true,
        clarification_question: 'Informe o periodo da consulta de parcelas com data inicial e final.',
      };
    }
    return {
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: inferParcelasTipo(text),
        de: range.de,
        ate: range.ate,
        incluirPagas: text.includes('pagas') || text.includes('pagou') || text.includes('pagaram'),
      },
      confidence: 0.87,
      intent: 'consulta_parcelas',
    };
  }

  return {
    tool_name: '',
    tool_args: {},
    confidence: 0.4,
    intent: 'outro',
  };
}

function inferRepoScope(userText) {
  const text = normalizeText(userText);
  if (text.includes('frontend') || text.includes('react') || text.includes('jsx') || text.includes('tela')) {
    return 'frontend';
  }
  if (text.includes('backend') || text.includes('controller') || text.includes('service') || text.includes('sql') || text.includes('orchestrator')) {
    return 'backend';
  }
  return 'project';
}

function tokenize(userText) {
  return normalizeText(userText)
    .split(/[^a-z0-9_]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function buildRepoQueries({ userText, llmPlan, domainPlan }) {
  const terms = new Set();

  const quoted = Array.from(String(userText || '').matchAll(/"([^"]{3,})"/g))
    .map((m) => String(m[1] || '').trim())
    .filter(Boolean);
  for (const q of quoted) terms.add(q);

  for (const token of tokenize(userText).slice(0, 8)) {
    terms.add(token);
  }

  if (llmPlan && llmPlan.tool_name) terms.add(llmPlan.tool_name);
  if (domainPlan && domainPlan.tool_name) terms.add(domainPlan.tool_name);
  if (normalizeText(userText).includes('runassistantquery')) terms.add('runAssistantQuery');
  if (normalizeText(userText).includes('orquestrador') || normalizeText(userText).includes('orchestrator')) terms.add('orchestrator');
  if (normalizeText(userText).includes('juros')) terms.add('juros');
  if (normalizeText(userText).includes('capital')) terms.add('capital_restante');

  const list = Array.from(terms).filter(Boolean);
  if (!list.length) {
    return ['orchestrator'];
  }
  return list.slice(0, 8);
}

function toRequestClassificationCategory(routeCategory) {
  if (routeCategory === 'question_real_data') return 'simples';
  if (routeCategory === 'question_architecture_code') return 'simples';
  if (routeCategory === 'question_business_rule') return 'complexa';
  if (routeCategory === 'action_modification') return 'complexa';
  return 'complexa';
}

function extractDomainMetrics(toolName, result) {
  const tool = sanitizeText(toolName).toLowerCase();
  const payload = result && typeof result === 'object' ? result : {};

  if (tool === 'caixa_resumo') {
    return {
      total_recebido: Number(payload.total_recebido || 0),
      total_juros_recebido: Number(payload.total_juros_recebido || 0),
      total_capital_recebido: Number(payload.total_capital_recebido || 0),
      saldo: Number(payload.saldo || 0),
    };
  }

  if (tool === 'parcelas_por_periodo') {
    return {
      total_parcelas: Number(payload.total || 0),
    };
  }

  if (tool === 'notificacoes_pendentes') {
    return {
      total_notificacoes: Number(payload.total || 0),
    };
  }

  if (tool === 'cliente_busca') {
    return {
      total_clientes: Number(payload.total || 0),
    };
  }

  if (tool === 'emprestimo_detalhe') {
    return {
      parcelas_em_aberto: Number(payload.parcelas_em_aberto || 0),
      capital_restante: Number(payload.capital_restante || 0),
      total_pago: Number(payload.total_pago || 0),
    };
  }

  return {};
}

function buildClarificationResult({
  answerText,
  route,
  sessionId,
  turnId,
  planningTrace = null,
  startMs,
}) {
  return {
    mode: 'clarification',
    reasoning_mode: 'agent_loop_v2',
    request_classification: {
      category: toRequestClassificationCategory(route.category),
      route,
    },
    answer_text: answerText,
    intent: route.category,
    confidence: 0.35,
    resolved_context: {},
    tool_trace: [],
    repo_trace: [],
    repo_evidence: [],
    sources: [
      {
        source_type: 'inference',
        label: 'clarification_required',
        details: 'Faltam parametros obrigatorios para consulta segura.',
      },
    ],
    verification: {
      validated: false,
      confidence: 0.35,
      source_stats: {
        database: 0,
        code: 0,
        logs: 0,
        endpoint: 0,
        inference: 1,
        other: 0,
      },
      conflicts: [],
      execution_errors: [],
    },
    session_id: sessionId || null,
    turn_id: turnId || null,
    follow_up: null,
    usage_trace: {
      planning: planningTrace,
      answer: {
        model: null,
        usage: null,
        metadata: {
          generation: 'local_clarification',
        },
      },
    },
    telemetry: {
      flow: 'agent_loop_v2',
      planning_ms: planningTrace && Number(planningTrace.latency_ms) > 0 ? Number(planningTrace.latency_ms) : 0,
      tool_execution_ms: 0,
      response_generation_ms: 0,
      orchestration_ms: Date.now() - startMs,
    },
  };
}

async function executeRepoEvidenceFlow({
  userText,
  llmPlan,
  domainPlan,
  toolTrace,
  executionErrors,
}) {
  const isUsefulMatch = (match) => {
    const relPath = sanitizeText(match && match.path).toLowerCase();
    if (!relPath) return false;
    if (relPath.endsWith('package-lock.json')) return false;
    const validExt = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.sql', '.md'];
    return validExt.some((ext) => relPath.endsWith(ext));
  };

  const repoScope = inferRepoScope(userText);
  const queries = buildRepoQueries({ userText, llmPlan, domainPlan });
  const collected = [];
  const repoTrace = [];

  for (const query of queries.slice(0, 2)) {
    const startedAt = Date.now();
    try {
      const searchResult = await executeRepoReadTool('repo_search', {
        scope: repoScope,
        query,
        is_regex: false,
        case_sensitive: false,
        max_matches: 50,
      });
      const latency = Date.now() - startedAt;

      repoTrace.push({
        tool: 'repo_search',
        input: { scope: repoScope, query },
        latency_ms: latency,
        result_count: Number(searchResult && searchResult.total_matches) || 0,
      });
      toolTrace.push(repoTrace[repoTrace.length - 1]);

      if (Array.isArray(searchResult && searchResult.matches)) {
        const usefulMatches = searchResult.matches.filter(isUsefulMatch);
        collected.push(...usefulMatches);
      }
      if (collected.length >= 20) break;
    } catch (err) {
      executionErrors.push(`repo_search:${query}:${err && err.message ? err.message : 'erro'}`);
    }
  }

  let snippets = [];
  if (collected.length) {
    const hits = collected.slice(0, 8).map((m) => ({ path: m.path, line: m.line }));
    const startedAt = Date.now();
    try {
      const sn = await executeRepoReadTool('repo_snippets', {
        scope: repoScope,
        hits,
        context_before: 2,
        context_after: 3,
        max_snippets: 4,
        max_chars_total: 2800,
      });
      const latency = Date.now() - startedAt;

      repoTrace.push({
        tool: 'repo_snippets',
        input: { scope: repoScope, hits: hits.length },
        latency_ms: latency,
        result_count: Number(sn && sn.total_snippets) || 0,
        truncated: Boolean(sn && sn.truncated),
      });
      toolTrace.push(repoTrace[repoTrace.length - 1]);

      snippets = Array.isArray(sn && sn.snippets) ? sn.snippets : [];
    } catch (err) {
      executionErrors.push(`repo_snippets:${err && err.message ? err.message : 'erro'}`);
    }
  }

  return {
    repo_scope: repoScope,
    repo_trace: repoTrace,
    repo_evidence: snippets,
  };
}

function buildActionDraftResult({
  route, requestClassification, sourceDecision, plan, answerText, sessionId, turnId,
  planningTrace, startedAt, draft = null, actionPreview = null, actionPreviewInvalidated = false,
  toolTrace = [], executionErrors = [],
}) {
  const hasPreview = Boolean(actionPreview);
  return {
    mode: hasPreview ? 'action_preview' : 'answer',
    reasoning_mode: 'agent_loop_v2',
    request_classification: { ...requestClassification, route, knowledge_source: sourceDecision, llm_plan: plan },
    answer_text: answerText,
    intent: hasPreview ? 'registrar_pagamento_preview' : 'registrar_pagamento_draft',
    confidence: hasPreview ? 0.9 : 0.7,
    resolved_context: {}, tool_trace: toolTrace, repo_trace: [], repo_evidence: [],
    sources: hasPreview ? [{ source_type: 'action_preview', label: 'registrar_pagamento' }] : [],
    verification: {
      validated: hasPreview, confidence: hasPreview ? 0.9 : 0.7,
      source_stats: { database: 0, code: 0, logs: 0, endpoint: 0, inference: 1, other: 0 },
      conflicts: [], execution_errors: executionErrors,
    },
    session_id: sessionId || null, turn_id: turnId || null,
    action_preview: actionPreview,
    action_preview_invalidated: Boolean(actionPreviewInvalidated),
    pending_action_draft: draft,
    follow_up: hasPreview ? { type: 'action_preview', writable_execution_enabled: false } : { type: 'action_draft', writable_execution_enabled: false },
    usage_trace: { planning: planningTrace, answer: { model: null, usage: null, metadata: { generation: 'action_draft_contract' } } },
    telemetry: {
      flow: 'agent_loop_v2', planning_ms: Number(planningTrace.latency_ms || 0),
      tool_execution_ms: toolTrace.reduce((total, item) => total + Number(item.latency_ms || 0), 0),
      response_generation_ms: 0, orchestration_ms: Date.now() - startedAt, steps_executed: toolTrace.length,
    },
  };
}

async function runAgentLoop({
  userText,
  screenContext,
  conversationContext,
  memoryContext = {},
  sessionId,
  turnId,
}) {
  const startedAt = Date.now();
  const question = sanitizeText(userText);
  const safeScreen = sanitizeScreenContext(screenContext);
  const safeConversation = Array.isArray(conversationContext) ? conversationContext : [];

  const route = routeAssistantIntent(question);
  const requestClassification = {
    category: toRequestClassificationCategory(route.category),
    route,
  };

  const sourceDecision = decideKnowledgeSource({
    userText: question,
    requestClassification,
    semanticProfile: null,
  });

  const toolCatalog = getToolCatalog({ includeRepoRead: false });
  const runtimeToolCatalog = [
    {
      name: 'query_financial_data',
      description: 'Consulta financeira generica. Recebe uma unica SQL SELECT/WITH; o backend aceita apenas tabelas financeiras permitidas, remove PII e aplica limite de linhas em conexao SQLite somente leitura.',
    },
    { name: 'runtime_logs_tail', description: 'Le as ultimas linhas de log do backend.' },
    { name: 'runtime_endpoint_get', description: 'Consulta endpoint interno confiavel via GET.' },
  ];

  let financialSchema = { source: 'runtime_schema_overview', read_only: true, tables: [] };
  try {
    const schema = await inspectDatabaseSchema({ maxTables: 80, includeColumns: true });
    financialSchema = buildFinancialSchemaForPlanning(schema);
  } catch (_) {
    // O planejador ainda pode usar tools de dominio se a introspeccao falhar.
  }

  const llmPlanning = await planWithLLM({
    userText: question,
    screenContext: safeScreen,
    conversationContext: safeConversation,
    toolCatalog,
    runtimeToolCatalog,
    financialSchema,
    semanticMemory: memoryContext,
  });

  // A indisponibilidade do provedor nao pode cair no compositor local como se
  // uma resposta da IA tivesse sido produzida. O controller a traduz em 429
  // sem revelar detalhes do provedor ao usuario.
  if (llmPlanning && llmPlanning.unavailable) {
    const error = new Error('Provedor de IA indisponivel.');
    error.code = 'assistant_provider_unavailable';
    throw error;
  }

  const planningTrace = llmPlanning && llmPlanning.ok
    ? {
        model: llmPlanning.model || null,
        usage: llmPlanning.usage || null,
        latency_ms: Date.now() - startedAt,
        metadata: {
          planner: 'openai',
          reason: 'llm_plan',
        },
      }
    : llmPlanning && !llmPlanning.skipped
      ? {
          model: llmPlanning.model || null,
          usage: llmPlanning.usage || null,
          latency_ms: Date.now() - startedAt,
          metadata: {
            planner: 'openai',
            error: llmPlanning.reason || 'planning_failed',
          },
        }
      : {
          model: null,
          usage: null,
          latency_ms: 0,
          metadata: {
            planner: 'heuristic',
            reason: llmPlanning && llmPlanning.reason ? llmPlanning.reason : 'no_api_key',
          },
        };

  const llmPlan = llmPlanning && llmPlanning.ok ? llmPlanning.plan : null;

  // A decisao de criar ou continuar um rascunho vem exclusivamente do plano
  // estruturado do modelo. O backend apenas persiste dados validados e roda
  // SELECTs protegidos durante, no maximo, cinco iteracoes.
  if (llmPlan && (llmPlan.action_proposal || llmPlan.action_draft)) {
    const gateway = getActionGateway();
    const actionToolTrace = [];
    const actionErrors = [];
    const resolutionEntities = { cliente: [], emprestimo: [] };
    let currentPlan = llmPlan;
    let pendingDraft = getPendingActionDraft(sessionId);
    let previewInvalidated = false;

    for (let iteration = 0; iteration < MAX_ACTION_RESOLUTION_ITERATIONS; iteration += 1) {
      if (currentPlan.action_draft) {
        const draftUpdate = safeDraft(currentPlan.action_draft, pendingDraft, {
          screenContext: safeScreen, memoryContext, resolutionEntities,
        });
        if (!draftUpdate.ok) {
          return buildActionDraftResult({
            route, requestClassification, sourceDecision, plan: currentPlan,
            answerText: 'Nao consegui validar os dados dessa intencao. Informe somente o dado que falta ou selecione a entidade correta.',
            sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
            toolTrace: actionToolTrace, executionErrors: [draftUpdate.reason],
          });
        }
        if (draftUpdate.abandoned) {
          clearPendingActionDraft(sessionId);
          previewInvalidated = (await gateway.invalidatePendingForSession(sessionId)) > 0;
          return buildActionDraftResult({
            route, requestClassification, sourceDecision, plan: currentPlan,
            answerText: 'A intencao de pagamento foi descartada. Nenhum pagamento foi registrado.',
            sessionId, turnId, planningTrace, startedAt, draft: null, actionPreviewInvalidated: previewInvalidated,
          });
        }
        if (draftUpdate.changed) {
          pendingDraft = savePendingActionDraft(sessionId, draftUpdate.draft);
          previewInvalidated = (await gateway.invalidatePendingForSession(sessionId)) > 0;
        } else {
          pendingDraft = getPendingActionDraft(sessionId);
        }
      }

      if (currentPlan.action_proposal) {
        const actionOutcome = await createActionPreviewFromPlan({
          plan: currentPlan, screenContext: safeScreen, memoryContext, resolutionEntities,
          pendingDraft, sessionId, gateway,
        });
        const hasPreview = actionOutcome.kind === 'preview';
        return buildActionDraftResult({
          route, requestClassification, sourceDecision, plan: currentPlan,
          answerText: hasPreview
            ? 'Encontrei um pagamento para preparar. Revise a previa abaixo: nada foi registrado ainda. A confirmacao so acontece pelo botao Confirmar.'
            : (actionOutcome.message || 'Nao foi possivel preparar uma acao financeira.'),
          sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
          actionPreview: hasPreview ? actionOutcome.action_preview : null,
          actionPreviewInvalidated: previewInvalidated,
          toolTrace: actionToolTrace, executionErrors: hasPreview ? [] : [actionOutcome.kind],
        });
      }

      const canResolveWithSql = Boolean(
        currentPlan.wants_runtime_sql && currentPlan.tool_name === 'query_financial_data' &&
        currentPlan.sql_query && isReadOnlySql(currentPlan.sql_query)
      );
      if (!canResolveWithSql) {
        const missing = pendingDraft && Array.isArray(pendingDraft.missing_fields)
          ? pendingDraft.missing_fields.join(', ') : 'dados necessarios';
        return buildActionDraftResult({
          route, requestClassification, sourceDecision, plan: currentPlan,
          answerText: currentPlan.clarification_question || `Para continuar, preciso de: ${missing}.`,
          sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
          actionPreviewInvalidated: previewInvalidated, toolTrace: actionToolTrace, executionErrors: actionErrors,
        });
      }

      try {
        const queryStartedAt = Date.now();
        const sqlResult = await executeReadOnlySql({ sql: currentPlan.sql_query, maxRows: 20 });
        const resolved = resolutionEntitiesFromRows(sqlResult.rows);
        resolutionEntities.cliente = [...new Set([...resolutionEntities.cliente, ...resolved.cliente])].slice(0, 20);
        resolutionEntities.emprestimo = [...new Set([...resolutionEntities.emprestimo, ...resolved.emprestimo])].slice(0, 20);
        if (pendingDraft) {
          pendingDraft = savePendingActionDraft(sessionId, {
            ...pendingDraft,
            candidate_entities: {
              cliente: resolutionEntities.cliente,
              emprestimo: resolutionEntities.emprestimo,
            },
            entity_sources: { ...(pendingDraft.entity_sources || {}), action_resolution: 'query_financial_data' },
          });
        }
        actionToolTrace.push({
          tool: 'query_financial_data', input: { sql_fingerprint: sqlResult.sql_fingerprint },
          latency_ms: Date.now() - queryStartedAt, result_count: Number(sqlResult.returned_rows || 0),
        });
      } catch (err) {
        actionErrors.push(`action_resolution:${err && err.message ? err.message : 'erro'}`);
        return buildActionDraftResult({
          route, requestClassification, sourceDecision, plan: currentPlan,
          answerText: 'Nao foi possivel localizar a entidade agora. O rascunho foi preservado sem registrar nenhum pagamento.',
          sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
          actionPreviewInvalidated: previewInvalidated, toolTrace: actionToolTrace, executionErrors: actionErrors,
        });
      }

      const replanned = await planWithLLM({
        userText: question, screenContext: safeScreen, conversationContext: safeConversation,
        toolCatalog, runtimeToolCatalog, financialSchema,
        semanticMemory: { ...memoryContext, pending_action_draft: pendingDraft },
        actionResolution: { candidate_entities: resolutionEntities, iteration: iteration + 1 },
      });
      if (replanned && replanned.unavailable) {
        const error = new Error('Provedor de IA indisponivel.');
        error.code = 'assistant_provider_unavailable';
        throw error;
      }
      if (!replanned || !replanned.ok) {
        return buildActionDraftResult({
          route, requestClassification, sourceDecision, plan: currentPlan,
          answerText: 'O rascunho foi preservado, mas nao consegui concluir a resolucao agora.',
          sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
          actionPreviewInvalidated: previewInvalidated, toolTrace: actionToolTrace,
          executionErrors: [...actionErrors, 'action_replanning_failed'],
        });
      }
      currentPlan = replanned.plan;
    }

    return buildActionDraftResult({
      route, requestClassification, sourceDecision, plan: currentPlan,
      answerText: 'A resolucao precisou de mais etapas do que o limite seguro. O rascunho foi preservado sem registrar nenhum pagamento.',
      sessionId, turnId, planningTrace, startedAt, draft: pendingDraft,
      actionPreviewInvalidated: previewInvalidated, toolTrace: actionToolTrace,
      executionErrors: ['action_resolution_iteration_limit'],
    });
  }

  const executionErrors = [];
  const toolTrace = [];
  const repoTrace = [];
  const sources = [];
  const notes = [];

  const wantsData =
    Boolean(route.flags.wantsData) ||
    sourceDecision.strategy === 'domain_only' ||
    sourceDecision.strategy === 'hybrid';
  const explicitCodeRequest = Boolean(route.flags.wantsCode);
  const wantsCode =
    explicitCodeRequest ||
    sourceDecision.strategy === 'repo_only' ||
    sourceDecision.strategy === 'hybrid' ||
    (
      Boolean(llmPlan && llmPlan.wants_code_evidence) &&
      (explicitCodeRequest || sourceDecision.strategy !== 'domain_only')
    );
  const wantsLogs =
    Boolean(route.flags.wantsLogs) ||
    Boolean(llmPlan && llmPlan.wants_logs);
  const wantsGenericFinancialQuery = Boolean(
    llmPlan &&
      llmPlan.wants_runtime_sql &&
      (llmPlan.tool_name === 'query_financial_data' || llmPlan.strategy === 'financial_query') &&
      llmPlan.sql_query
  );
  const wantsEndpoint = Boolean(route.flags.wantsEndpoint);

  if (route.category === 'action_modification') {
    const repoFlow = await executeRepoEvidenceFlow({
      userText: question,
      llmPlan,
      domainPlan: null,
      toolTrace,
      executionErrors,
    });

    const codeSummary = buildCodeEvidenceAnswer(repoFlow.repo_evidence || []);
    const answerText = composeFinalAnswer({
      route,
      domainSummary: '',
      codeSummary,
      logSummary: '',
      verification: {
        validated: (repoFlow.repo_evidence || []).length > 0,
      },
      notes: [
        'Plano sugerido: 1) mapear impacto por modulo, 2) gerar patch incremental, 3) rodar testes, 4) validar regressao.',
      ],
    });

    const actionSources = (repoFlow.repo_evidence || []).slice(0, 6).map((item) => ({
      source_type: 'code_snippet',
      label: `${sanitizeText(item.path)}:${Number(item.start_line) || 1}`,
      path: item.path,
      line: Number(item.start_line) || 1,
    }));
    sources.push(...actionSources);

    const verification = buildVerificationReport({
      intentRoute: route,
      sources,
      executionErrors,
    });

    return {
      mode: 'action_plan',
      reasoning_mode: 'agent_loop_v2',
      request_classification: {
        ...requestClassification,
        route,
        knowledge_source: sourceDecision,
        llm_plan: llmPlan,
      },
      answer_text: `${answerText}\n\n${buildSourceFootnote(sources)}`,
      intent: 'action_modification',
      confidence: verification.confidence,
      resolved_context: {},
      tool_trace: toolTrace,
      repo_trace: repoFlow.repo_trace || [],
      repo_evidence: repoFlow.repo_evidence || [],
      sources,
      verification,
      session_id: sessionId || null,
      turn_id: turnId || null,
      follow_up: {
        type: 'action_plan',
        writable_execution_enabled: false,
      },
      usage_trace: {
        planning: planningTrace,
        answer: {
          model: null,
          usage: null,
          metadata: {
            generation: 'local_action_plan',
          },
        },
      },
      telemetry: {
        flow: 'agent_loop_v2',
        planning_ms: Number(planningTrace.latency_ms || 0),
        tool_execution_ms: toolTrace.reduce((sum, t) => sum + Number(t && t.latency_ms ? t.latency_ms : 0), 0),
        response_generation_ms: 0,
        orchestration_ms: Date.now() - startedAt,
      },
    };
  }

  let domainPlan = wantsGenericFinancialQuery
    ? {
        tool_name: '',
        tool_args: {},
        confidence: Number(llmPlan.confidence || 0.8),
        intent: llmPlan.intent || 'consulta_financeira_livre',
      }
    : inferDomainToolByHeuristics({
        userText: question,
        screenContext: safeScreen,
      });

  if (llmPlan && llmPlan.tool_name && !wantsGenericFinancialQuery) {
    const hasHeuristicConcretePlan =
      domainPlan &&
      domainPlan.tool_name &&
      !domainPlan.needs_clarification &&
      isPlainObject(domainPlan.tool_args) &&
      Object.keys(domainPlan.tool_args).length > 0;
    const llmCandidateArgs = isPlainObject(llmPlan.tool_args) ? llmPlan.tool_args : {};
    const llmValidation = validateToolCall(llmPlan.tool_name, llmCandidateArgs);
    const trustLlmClarification = Boolean(llmPlan.needs_clarification) && !hasHeuristicConcretePlan;
    const canAdoptLlmPlan =
      !hasHeuristicConcretePlan
        ? (llmValidation.ok || trustLlmClarification)
        : (
            llmValidation.ok &&
            llmPlan.tool_name === domainPlan.tool_name &&
            Number(llmPlan.confidence || 0) >= Number(domainPlan.confidence || 0)
          );

    if (canAdoptLlmPlan) {
      domainPlan = {
        ...domainPlan,
        tool_name: llmPlan.tool_name,
        tool_args: llmValidation.ok
          ? (llmValidation.normalized_args || llmCandidateArgs)
          : llmCandidateArgs,
        confidence: llmPlan.confidence != null ? llmPlan.confidence : domainPlan.confidence,
        intent: llmPlan.intent || domainPlan.intent,
        needs_clarification: trustLlmClarification,
        clarification_question: trustLlmClarification
          ? (llmPlan.clarification_question || domainPlan.clarification_question)
          : (domainPlan.clarification_question || ''),
      };
    } else if (hasHeuristicConcretePlan) {
      notes.push('Planejamento LLM ignorado: mantida rota heuristica validada.');
    }
  }

  if (domainPlan && domainPlan.needs_clarification) {
    return buildClarificationResult({
      answerText: domainPlan.clarification_question || 'Preciso de mais detalhes para executar a consulta com seguranca.',
      route,
      sessionId,
      turnId,
      planningTrace,
      startMs: startedAt,
    });
  }

  let domainSummary = '';
  let codeSummary = '';
  let logSummary = '';
  let resolvedContext = {};
  let selectedToolResult = null;
  let selectedValidation = null;
  let semanticMemoryCandidate = null;

  if (wantsData && domainPlan && domainPlan.tool_name) {
    const resolved = resolveToolCallWithContext({
      toolName: domainPlan.tool_name,
      toolArgs: domainPlan.tool_args,
      entities: {},
      screenContext: safeScreen,
    });

    if (resolved.needs_clarification) {
      return buildClarificationResult({
        answerText: resolved.clarification_question || 'Preciso de mais contexto para consultar os dados.',
        route,
        sessionId,
        turnId,
        planningTrace,
        startMs: startedAt,
      });
    }

    const validation = validateToolCall(domainPlan.tool_name, resolved.resolved_args || {});
    if (!validation.ok) {
      return buildClarificationResult({
        answerText: validation.errors && validation.errors.length
          ? validation.errors[0]
          : 'Nao consegui validar os parametros da consulta.',
        route,
        sessionId,
        turnId,
        planningTrace,
        startMs: startedAt,
      });
    }

    selectedValidation = validation;
    resolvedContext = resolved.resolved_context || {};

    const toolStartedAt = Date.now();
    try {
      // Carregamento tardio: a consulta financeira generica nao deve inicializar
      // o banco gravavel apenas para manter as tools legadas disponiveis.
      const { executeReadOnlyTool } = require('../tools/readOnlyTools');
      selectedToolResult = await executeReadOnlyTool(validation.tool_name, validation.normalized_args);
      const latency = Date.now() - toolStartedAt;
      const traceEntry = {
        tool: validation.tool_name,
        input: validation.normalized_args,
        latency_ms: latency,
      };
      toolTrace.push(traceEntry);

      domainSummary = buildDomainAnswer({
        toolName: validation.tool_name,
        toolArgs: validation.normalized_args,
        toolResult: selectedToolResult,
        intent: domainPlan.intent,
      });

      sources.push({
        source_type: 'database_tool',
        label: validation.tool_name,
        tool: validation.tool_name,
        args: validation.normalized_args,
        metrics: extractDomainMetrics(validation.tool_name, selectedToolResult),
      });
    } catch (err) {
      executionErrors.push(`domain_tool:${validation.tool_name}:${err && err.message ? err.message : 'erro'}`);
      notes.push('Falha ao consultar tool de dominio.');
    }
  }

  if (wantsGenericFinancialQuery) {
    const sql = sanitizeText(llmPlan.sql_query);
    const scopeSql = sanitizeText(llmPlan.scope_sql);
    const scopeEntityType = sanitizeText(llmPlan.scope_entity_type).toLowerCase();
    const reusedResultSet = llmPlan.result_set_id
      ? getResultSetById(sessionId, llmPlan.result_set_id)
      : null;
    const hasDeclaredScope = Boolean(scopeSql);
    let activeScope = null;
    let semanticScope = null;

    if (hasDeclaredScope && llmPlan.result_set_id) {
      executionErrors.push('query_financial_scope:cannot_mix_declared_and_reused_scope');
    } else if (hasDeclaredScope) {
      if (!FINANCIAL_SCOPE_ENTITY_TYPES.has(scopeEntityType)) {
        executionErrors.push('query_financial_scope:entity_type_invalid');
      } else if (!isScopeSqlForEntity(scopeSql, scopeEntityType)) {
        executionErrors.push('query_financial_scope:sql_not_bound_to_declared_entity');
      } else {
        const scopeStartedAt = Date.now();
        try {
          const scopeResult = await executeScopeReadOnlySql({ sql: scopeSql });
          toolTrace.push({
            tool: 'query_financial_scope',
            input: { sql_fingerprint: scopeResult.sql_fingerprint },
            latency_ms: Date.now() - scopeStartedAt,
            result_count: Number(scopeResult.entity_ids.length || 0),
            truncated: Boolean(scopeResult.truncated),
          });
          if (!scopeResult.scope_complete) {
            executionErrors.push('query_financial_scope:scope_limit_exceeded');
          } else {
            activeScope = {
              result_set_id: `scope_${scopeResult.sql_fingerprint}`,
              entity_type: scopeEntityType,
              entity_ids: scopeResult.entity_ids,
            };
            semanticScope = {
              entity_type: scopeEntityType,
              entity_ids: scopeResult.entity_ids,
              scope_complete: true,
              entity_count_lower_bound: scopeResult.entity_ids.length,
            };
          }
        } catch (scopeErr) {
          executionErrors.push(`query_financial_scope:${scopeErr && scopeErr.message ? scopeErr.message : 'erro'}`);
        }
      }
    } else if (llmPlan.result_set_id) {
      if (!reusedResultSet || reusedResultSet.scope_complete === false || !reusedResultSet.entity_ids.length) {
        executionErrors.push('query_financial_data:result_set_not_found_or_incomplete');
      } else {
        activeScope = reusedResultSet;
        semanticScope = {
          entity_type: reusedResultSet.entity_type,
          entity_ids: reusedResultSet.entity_ids,
          scope_complete: true,
          entity_count_lower_bound: reusedResultSet.entity_ids.length,
        };
      }
    }

    const requiresScopeBinding = Boolean(hasDeclaredScope || llmPlan.result_set_id);
    if (requiresScopeBinding && !activeScope) {
      // O erro especifico ja foi registrado acima; nao executa uma analise solta.
    } else if (requiresScopeBinding && !isAnalyticSqlBoundToScope(sql, activeScope.entity_type)) {
      executionErrors.push('query_financial_data:analytic_sql_not_bound_to_scope');
    } else if (!requiresScopeBinding && !isReadOnlySql(sql)) {
      executionErrors.push('query_financial_data:sql_not_readonly');
    } else {
      const startedSql = Date.now();
      try {
        const sqlResult = await executeReadOnlySql({
          sql,
          maxRows: 100,
          semanticResultSet: activeScope,
        });
        toolTrace.push({
          tool: 'query_financial_data',
          input: { sql },
          latency_ms: Date.now() - startedSql,
          result_count: Number(sqlResult.returned_rows || 0),
        });

        selectedToolResult = sqlResult;
        selectedValidation = {
          tool_name: 'query_financial_data',
          normalized_args: {
            sql_fingerprint: sqlResult.sql_fingerprint,
            returned_rows: sqlResult.returned_rows,
          },
        };
        domainSummary = buildDomainAnswer({
          toolName: 'query_financial_data',
          toolArgs: {},
          toolResult: sqlResult,
          intent: llmPlan.intent || 'consulta_financeira_livre',
        });

        sources.push({
          source_type: 'database_sql',
          label: 'query_financial_data',
          sql_fingerprint: sqlResult.sql_fingerprint,
          metrics: {
            returned_rows: Number(sqlResult.returned_rows || 0),
          },
        });
        semanticMemoryCandidate = {
          entity_type: llmPlan.result_set_type,
          description: llmPlan.result_set_description || llmPlan.semantic_intent || llmPlan.intent,
          filters: {
            semantic_intent: llmPlan.semantic_intent,
            aggregation: llmPlan.aggregation,
            temporal_scope: llmPlan.temporal_scope,
            period_reference: llmPlan.period_reference,
          },
          reused_result_set_id: reusedResultSet ? reusedResultSet.result_set_id : '',
          tool_result: sqlResult,
          semantic_scope: semanticScope,
        };
      } catch (err) {
        executionErrors.push(`query_financial_data:${err && err.message ? err.message : 'erro'}`);
      }
    }
  }

  if (wantsEndpoint) {
    try {
      const endpointStartedAt = Date.now();
      const endpointResult = await fetchInternalEndpoint({
        path: '/health',
        query: {},
        timeoutMs: 2500,
      });

      toolTrace.push({
        tool: 'runtime_endpoint_get',
        input: { path: '/health' },
        latency_ms: Date.now() - endpointStartedAt,
        status: endpointResult.status,
      });

      sources.push({
        source_type: 'endpoint_get',
        label: '/health',
      });

      notes.push(`Endpoint interno /health status=${endpointResult.status}.`);
    } catch (err) {
      executionErrors.push(`runtime_endpoint_get:${err && err.message ? err.message : 'erro'}`);
    }
  }

  let repoEvidence = [];
  if (wantsCode || (!domainSummary && sourceDecision.strategy !== 'domain_only')) {
    const repoFlow = await executeRepoEvidenceFlow({
      userText: question,
      llmPlan,
      domainPlan,
      toolTrace,
      executionErrors,
    });

    repoTrace.push(...(repoFlow.repo_trace || []));
    repoEvidence = repoFlow.repo_evidence || [];
    if (repoEvidence.length) {
      codeSummary = buildCodeEvidenceAnswer(repoEvidence);
      for (const item of repoEvidence.slice(0, 6)) {
        sources.push({
          source_type: 'code_snippet',
          label: `${sanitizeText(item.path)}:${Number(item.start_line) || 1}`,
          path: item.path,
          line: Number(item.start_line) || 1,
        });
      }
    }
  }

  if (wantsLogs) {
    const fileName = normalizeText(question).includes('main.log') ? 'main.log' : 'backend.log';
    const logStartedAt = Date.now();
    try {
      const logPayload = await readBackendLogs({
        file: fileName,
        maxLines: 120,
      });
      toolTrace.push({
        tool: 'runtime_logs_tail',
        input: { file: fileName, maxLines: 120 },
        latency_ms: Date.now() - logStartedAt,
        result_count: Number(logPayload && logPayload.line_count ? logPayload.line_count : 0),
      });

      logSummary = buildLogAnswer(logPayload);
      sources.push({
        source_type: 'log_tail',
        label: fileName,
      });
    } catch (err) {
      executionErrors.push(`runtime_logs_tail:${err && err.message ? err.message : 'erro'}`);
    }
  }

  if (!sources.length) {
    try {
      const dbInfo = await discoverActiveDatabase();
      const schema = await inspectDatabaseSchema({ maxTables: 40, includeColumns: false });
      sources.push({
        source_type: 'database_runtime',
        label: 'runtime_db_info',
        details: dbInfo,
      });
      sources.push({
        source_type: 'database_runtime',
        label: 'runtime_schema_overview',
        details: {
          total_objects: schema.total_objects,
        },
      });
      notes.push(`Banco ativo detectado em ${dbInfo.db_path}. Objetos de schema: ${schema.total_objects}.`);
    } catch (err) {
      executionErrors.push(`runtime_db_info:${err && err.message ? err.message : 'erro'}`);
    }
  }

  const verification = buildVerificationReport({
    intentRoute: route,
    sources,
    executionErrors,
  });

  const localFinalAnswer = composeFinalAnswer({
    route,
    domainSummary,
    codeSummary,
    logSummary,
    verification,
    notes: [
      ...notes,
      `Confianca estimada: ${Math.round(Number(verification.confidence || 0) * 100)}%.`,
      verification.validated ? 'Validacao: concluida.' : 'Validacao: parcial/inconclusiva.',
    ],
  });

  const selectedTool = selectedValidation
    ? {
        name: selectedValidation.tool_name,
        args: selectedValidation.normalized_args,
        result: selectedToolResult,
      }
    : null;

  const answerLlm = await generateAnswerWithLLM({
    userText: question,
    route,
    requestClassification,
    domainPlan,
    resolvedContext,
    selectedTool,
    domainSummary,
    codeSummary,
    logSummary,
    repoEvidence,
    sources,
    verification,
    notes,
  });

  if (answerLlm && answerLlm.unavailable) {
    const error = new Error('Provedor de IA indisponivel.');
    error.code = 'assistant_provider_unavailable';
    throw error;
  }

  const responseGenerationMs = Number(answerLlm && answerLlm.latency_ms ? answerLlm.latency_ms : 0);
  const answerCoreText =
    answerLlm && answerLlm.ok && sanitizeText(answerLlm.answer_text)
      ? sanitizeText(answerLlm.answer_text)
      : localFinalAnswer;
  const answerText = `${answerCoreText}\n\n${buildSourceFootnote(sources)}`;

  const answerTrace =
    answerLlm && answerLlm.ok
      ? {
          model: answerLlm.model || null,
          usage: answerLlm.usage || null,
          metadata: {
            generation: 'openai_answer_v1',
          },
        }
      : {
          model: null,
          usage: null,
          metadata: {
            generation: 'local_response_composer_v2',
            fallback_reason:
              answerLlm && answerLlm.reason
                ? String(answerLlm.reason)
                : 'answer_llm_unavailable',
          },
        };

  return {
    mode: 'answer',
    reasoning_mode: 'agent_loop_v2',
    request_classification: {
      ...requestClassification,
      route,
      knowledge_source: sourceDecision,
      llm_plan: llmPlan,
    },
    answer_text: answerText,
    intent: sanitizeText(domainPlan && domainPlan.intent, route.category),
    confidence: verification.confidence,
    resolved_context: resolvedContext,
    semantic_memory_candidate: semanticMemoryCandidate,
    tool_trace: toolTrace,
    repo_trace: repoTrace.length ? repoTrace : undefined,
    repo_evidence: repoEvidence.length ? repoEvidence : undefined,
    sources,
    verification,
    session_id: sessionId || null,
    turn_id: turnId || null,
    follow_up: null,
    usage_trace: {
      planning: planningTrace,
      answer: answerTrace,
    },
    telemetry: {
      flow: 'agent_loop_v2',
      planning_ms: Number(planningTrace && planningTrace.latency_ms ? planningTrace.latency_ms : 0),
      tool_execution_ms: toolTrace.reduce((sum, t) => sum + Number(t && t.latency_ms ? t.latency_ms : 0), 0),
      response_generation_ms: responseGenerationMs,
      orchestration_ms: Date.now() - startedAt,
      steps_executed: toolTrace.length,
    },
  };
}

module.exports = {
  runAgentLoop,
  __internal: {
    parseDateRangeFromText,
    inferDomainToolByHeuristics,
    inferRepoScope,
    buildRepoQueries,
    extractDomainMetrics,
    buildFinancialSchemaForPlanning,
    isScopeSqlForEntity,
    isAnalyticSqlBoundToScope,
    createActionPreviewFromPlan,
    MAX_ACTION_RESOLUTION_ITERATIONS,
  },
};
