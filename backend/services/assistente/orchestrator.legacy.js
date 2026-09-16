const {
  getToolCatalog,
  isISODate,
  isPlainObject,
  sanitizeScreenContext,
  validateToolCall,
} = require('./contracts');
const { resolveToolCallWithContext } = require('./contextResolver');
const { executeReadOnlyTool } = require('./tools/readOnlyTools');
const { executeRepoReadTool } = require('./tools/repoReadTools');
const { decideKnowledgeSource } = require('./repoReadPolicy');
const {
  applyActiveContextToScreenContext,
  clearPendingClarification,
  getSessionConversationContext,
  getSessionMemorySnapshot,
  maybeResetSessionContext,
  mergeConversationContexts,
  recordConversationTurn,
  resolvePendingClarificationSelection,
  setPendingClarification,
} = require('./conversationMemory');
const {
  buildPlanningSystemPrompt,
  buildAnswerSystemPrompt,
} = require('./systemPrompt');

const EXECUTION_CONFIDENCE_THRESHOLD = 0.85;
const MAX_CONTEXT_TURNS = 10;
const MAX_MEMORY_TURNS_HINT = 5;
const QUESTION_TYPES = new Set([
  'evento',
  'estoque',
  'detalhe',
  'resumo',
  'ambiguous_event_vs_stock',
  'outro',
]);
const AMBIGUITY_LEVELS = new Set(['baixo', 'medio', 'alto']);
const INDIRECT_REFERENCE_TERMS = Object.freeze([
  'esse',
  'essa',
  'esses',
  'essas',
  'isso',
  'isto',
  'aquele',
  'aquela',
  'aquilo',
  'ele',
  'ela',
  'dele',
  'dela',
  'disso',
  'nisso',
  'nela',
  'nele',
  'aqui',
  'ai',
]);
const COMPLEXITY_TERMS = Object.freeze([
  'porque',
  'por que',
  'motivo',
  'explica',
  'explicar',
  'detalha',
  'detalhar',
  'comparar',
  'comparacao',
  'diferenca',
  'mudou',
  'mudanca',
  'historico',
  'origem',
  'causa',
]);
const EVENT_STOCK_AMBIGUITY_TERMS = Object.freeze([
  'pagar',
  'pagamento',
  'dever',
  'devendo',
  'devia',
  'atrasado',
  'atrasada',
  'pendente',
  'pendentes',
  'vencido',
  'vencida',
  'vencidas',
  'vencidos',
]);
const TIME_TERMS = Object.freeze([
  'hoje',
  'ontem',
  'amanha',
  'agora',
  'semana',
  'mes',
  'ano',
  'data',
  'periodo',
  'intervalo',
]);
const MULTI_INTENT_TERMS = Object.freeze([' ou ', ' versus ', ' comparado ', ' diferenca ']);
const SEMANTIC_INTENTS = new Set([
  'evento',
  'estoque',
  'detalhe',
  'resumo',
  'busca_cliente',
  'fila_alertas',
  'ambiguous_event_vs_stock',
  'outro',
]);
const SEMANTIC_ENTITIES = new Set([
  'cliente',
  'emprestimo',
  'parcela',
  'pagamento',
  'notificacao',
  'caixa',
  'outro',
]);
const SEMANTIC_AGGREGATIONS = new Set([
  'soma',
  'contagem_parcelas',
  'clientes_unicos',
  'agrupamento_cliente',
  'agrupamento_periodo',
  'nenhuma',
]);
const ENTITY_SIGNAL_TERMS = Object.freeze({
  cliente: ['cliente', 'clientes', 'cpf'],
  emprestimo: ['emprestimo', 'contrato', 'divida', 'capital restante', 'capital_restante'],
  parcela: ['parcela', 'parcelas', 'vencimento', 'vencer', 'vencidas', 'vencendo'],
  pagamento: ['pagamento', 'pagamentos', 'pagou', 'pagaram', 'pago', 'recebi'],
  notificacao: ['notificacao', 'notificacoes', 'alerta', 'alertas', 'pendencia'],
  caixa: ['caixa', 'entrou', 'entrada', 'entradas', 'saldo', 'receita'],
});
const AGGREGATION_SIGNAL_TERMS = Object.freeze({
  soma: ['quanto', 'valor', 'total', 'soma', 'somar'],
  contagem_parcelas: ['quantas parcelas', 'qtd parcelas', 'numero de parcelas', 'contagem de parcelas'],
  clientes_unicos: ['quantos clientes', 'clientes unicos', 'clientes diferentes'],
  agrupamento_cliente: ['por cliente', 'agrupado por cliente', 'separado por cliente'],
  agrupamento_periodo: ['por periodo', 'por dia', 'por mes', 'por ano'],
});
const TOOL_INTENT_MAP = Object.freeze({
  evento: 'parcelas_por_periodo',
  estoque: 'parcelas_por_periodo',
  detalhe: 'emprestimo_detalhe',
  resumo: 'caixa_resumo',
  busca_cliente: 'cliente_busca',
  fila_alertas: 'notificacoes_pendentes',
});
const TOOL_ENTITY_HINTS = Object.freeze({
  caixa_resumo: 'caixa',
  parcelas_por_periodo: 'parcela',
  emprestimo_detalhe: 'emprestimo',
  notificacoes_pendentes: 'notificacao',
  cliente_busca: 'cliente',
});
const MANDATORY_AMBIGUITY_PATTERNS = Object.freeze([
  {
    id: 'quanto_recebi',
    terms: ['quanto recebi', 'quanto eu recebi', 'quanto recebeu', 'quanto recebemos'],
    options: ['total de entradas no caixa', 'total de parcelas/pagamentos recebidos'],
  },
  {
    id: 'quanto_entrou',
    terms: ['quanto entrou', 'quanto entrou hoje', 'quanto entrou ontem'],
    options: ['entradas financeiras no caixa', 'parcelas pagas por clientes'],
  },
  {
    id: 'quanto_devo',
    terms: ['quanto devo', 'quanto esta devendo', 'quanto falta pagar'],
    options: ['saldo total em aberto (estoque)', 'valor que vence em um periodo (evento)'],
  },
  {
    id: 'quantos_pagaram',
    terms: ['quantos pagaram', 'quem pagou', 'quantidade que pagou'],
    options: ['quantidade de clientes unicos que pagaram', 'quantidade de parcelas pagas'],
  },
  {
    id: 'total_da_parcela',
    terms: ['total da parcela', 'valor total da parcela', 'valor da parcela'],
    options: ['valor_total bruto da parcela', 'total_devido_calculado (com composicao de juros)'],
  },
]);
const UNSUPPORTED_QUERY_SIGNALS = Object.freeze([
  'data de pagamento',
  'data_pagamento',
  'quando pagou',
  'historico de pagamento',
  'historico de pagamentos',
  'pagamentos por data',
  'auditoria detalhada',
]);
const RECEIVED_SIGNAL_TERMS = Object.freeze([
  'recebi',
  'recebeu',
  'recebemos',
  'recebido',
  'recebida',
  'recebidas',
  'recebidos',
  'receber',
]);
const FORECAST_RECEIPT_TERMS = Object.freeze([
  'vou receber',
  'vou ganhar',
  'se pagar',
  'se pagarem',
  'se eles pagarem',
  'quando pagar',
  'quando pagarem',
  'pagarem certinho',
  'pagar certinho',
  'previsao',
  'previsto',
]);
const PAST_RECEIPT_TERMS = Object.freeze([
  'entrou',
  'entrou no caixa',
  'recebi',
  'recebeu',
  'recebemos',
  'foi pago',
  'foi paga',
  'ja pagaram',
  'já pagaram',
  'pagou',
  'pagaram',
]);
const CASH_SUMMARY_HINT_TERMS = Object.freeze([
  'caixa',
  'entrada',
  'entradas',
  'capital',
  'juros',
  'separa',
  'separar',
  'separado',
]);
const MONTH_NAME_TO_NUMBER = Object.freeze({
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
});
const KNOWLEDGE_SOURCE_STRATEGIES = new Set(['domain_only', 'repo_only', 'hybrid']);

function getOpenAIConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
  const modelPlanning = String(process.env.OPENAI_ASSISTANT_MODEL || 'gpt-4o-mini').trim();
  const modelAnswer = String(process.env.OPENAI_ASSISTANT_RESPONSE_MODEL || modelPlanning).trim();
  return { apiKey, baseUrl, modelPlanning, modelAnswer };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessageContent(completionPayload) {
  const choices = Array.isArray(completionPayload && completionPayload.choices)
    ? completionPayload.choices
    : [];
  if (!choices.length) return '';
  const message = choices[0] && choices[0].message ? choices[0].message : {};
  const content = message && message.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function sanitizeShortText(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeTextForAnalysis(value) {
  return sanitizeShortText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeForAnalysis(value) {
  const normalized = normalizeTextForAnalysis(value);
  if (!normalized) return [];
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

function hasAnyTermInText(text, terms) {
  const base = sanitizeShortText(text).toLowerCase();
  if (!base || !Array.isArray(terms) || !terms.length) return false;
  return terms.some((term) => {
    const t = sanitizeShortText(term).toLowerCase();
    return t && base.includes(t);
  });
}

function hasSelectedEntityContext(screenContext) {
  const ctx = isPlainObject(screenContext) ? screenContext : {};
  const selected = isPlainObject(ctx.selected_ids) ? ctx.selected_ids : {};
  const selectedKeys = Object.keys(selected).filter((key) => Number(selected[key]) > 0);
  if (selectedKeys.length) return true;

  const query = isPlainObject(ctx.query_params) ? ctx.query_params : {};
  const queryEntityKeys = ['cliente', 'cliente_id', 'emprestimo', 'emprestimo_id', 'parcela', 'parcela_id'];
  return queryEntityKeys.some((key) => sanitizeShortText(query[key]));
}

function normalizeQuestionType(rawType) {
  const normalized = sanitizeShortText(rawType).toLowerCase();
  if (!normalized) return 'outro';
  if (QUESTION_TYPES.has(normalized)) return normalized;
  if (normalized === 'ambigua_evento_estoque' || normalized === 'ambiguo_evento_estoque') {
    return 'ambiguous_event_vs_stock';
  }
  if (normalized === 'busca_cliente') return 'detalhe';
  if (normalized === 'fila_alertas') return 'estoque';
  return 'outro';
}

function normalizeSemanticIntent(rawValue, fallback = 'outro') {
  const normalized = sanitizeShortText(rawValue).toLowerCase();
  if (SEMANTIC_INTENTS.has(normalized)) return normalized;
  if (normalized === 'ambigua_evento_estoque' || normalized === 'ambiguo_evento_estoque') {
    return 'ambiguous_event_vs_stock';
  }
  return fallback;
}

function normalizeSemanticEntity(rawValue, fallback = 'outro') {
  const normalized = sanitizeShortText(rawValue).toLowerCase();
  if (SEMANTIC_ENTITIES.has(normalized)) return normalized;
  return fallback;
}

function normalizeSemanticAggregation(rawValue, fallback = 'nenhuma') {
  const normalized = sanitizeShortText(rawValue).toLowerCase();
  if (SEMANTIC_AGGREGATIONS.has(normalized)) return normalized;
  if (normalized === 'contagem' || normalized === 'count') return 'contagem_parcelas';
  if (normalized === 'soma_valores' || normalized === 'sum') return 'soma';
  return fallback;
}

function parseIsoDateFromBrDate(rawValue) {
  const text = sanitizeShortText(rawValue);
  const match = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!match) return '';
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return '';
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return '';
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDaysInMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 30;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildMonthRange(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const lastDay = getDaysInMonth(year, month);
  return {
    de: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
    ate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

function toIsoDateFromParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return '';
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return '';
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toIsoFromLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return toIsoDateFromParts(year, month, day);
}

function getYearMonthWithOffset(monthOffset = 0) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1 + Number(monthOffset || 0);
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return { year, month };
}

function resolveDayWithMonthOffset(dayRaw, monthOffset = 0) {
  const day = Number(dayRaw);
  if (!Number.isInteger(day) || day < 1 || day > 31) return '';
  const { year, month } = getYearMonthWithOffset(monthOffset);
  const direct = toIsoDateFromParts(year, month, day);
  if (direct) return direct;
  const lastDay = getDaysInMonth(year, month);
  return toIsoDateFromParts(year, month, Math.max(1, Math.min(day, lastDay)));
}

function collectDateReferencesFromSegment(segmentText) {
  const segment = normalizeTextForAnalysis(segmentText);
  if (!segment) return [];
  const refs = [];
  const pushRef = (index, iso, source) => {
    if (!isISODate(iso)) return;
    refs.push({
      index: Number.isFinite(index) ? index : 0,
      iso,
      source,
    });
  };

  for (const match of segment.matchAll(/\bdia\s+de\s+hoje\b/g)) {
    pushRef(match.index, todayISO(), 'dia_de_hoje');
  }
  for (const match of segment.matchAll(/\bhoje\b/g)) {
    pushRef(match.index, todayISO(), 'hoje');
  }
  for (const match of segment.matchAll(/\bdia\s+de\s+amanha\b/g)) {
    pushRef(match.index, shiftISODate(todayISO(), 1), 'dia_de_amanha');
  }
  for (const match of segment.matchAll(/\bamanha\b/g)) {
    pushRef(match.index, shiftISODate(todayISO(), 1), 'amanha');
  }
  for (const match of segment.matchAll(/\bdia\s+de\s+ontem\b/g)) {
    pushRef(match.index, shiftISODate(todayISO(), -1), 'dia_de_ontem');
  }
  for (const match of segment.matchAll(/\bontem\b/g)) {
    pushRef(match.index, shiftISODate(todayISO(), -1), 'ontem');
  }

  for (const match of segment.matchAll(/\bdia\s+(\d{1,2})\s+do\s+m(?:es|[\?\uFFFD]s)\s+que\s+vem\b/g)) {
    pushRef(match.index, resolveDayWithMonthOffset(match[1], 1), 'dia_mes_que_vem');
  }
  for (const match of segment.matchAll(/\bdia\s+(\d{1,2})\s+do\s+proximo\s+m(?:es|[\?\uFFFD]s)\b/g)) {
    pushRef(match.index, resolveDayWithMonthOffset(match[1], 1), 'dia_proximo_mes');
  }
  for (const match of segment.matchAll(/\bdia\s+(\d{1,2})\s+do\s+m(?:es|[\?\uFFFD]s)\s+passado\b/g)) {
    pushRef(match.index, resolveDayWithMonthOffset(match[1], -1), 'dia_mes_passado');
  }
  for (const match of segment.matchAll(/\bdia\s+(\d{1,2})\s+(?:deste|desse)\s+m(?:es|[\?\uFFFD]s)\b/g)) {
    pushRef(match.index, resolveDayWithMonthOffset(match[1], 0), 'dia_mes_atual');
  }
  for (const match of segment.matchAll(/\bdia\s+(\d{1,2})\s+do\s+m(?:es|[\?\uFFFD]s)\s+atual\b/g)) {
    pushRef(match.index, resolveDayWithMonthOffset(match[1], 0), 'dia_mes_atual');
  }

  refs.sort((a, b) => a.index - b.index);
  return refs;
}

function extractRelativeIntervalFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;
  const intervalMatch = base.match(/^(.*)\b(?:ate\b|at[\?\uFFFD])(.*)$/);
  if (!intervalMatch) return null;
  const left = sanitizeShortText(intervalMatch[1]);
  const right = sanitizeShortText(intervalMatch[2]);
  if (!left || !right) return null;
  const leftRefs = collectDateReferencesFromSegment(left);
  const rightRefs = collectDateReferencesFromSegment(right);
  if (!leftRefs.length || !rightRefs.length) return null;

  const leftDate = leftRefs[leftRefs.length - 1];
  const rightDate = rightRefs[0];
  if (!isISODate(leftDate.iso) || !isISODate(rightDate.iso)) return null;

  let de = leftDate.iso;
  let ate = rightDate.iso;
  if (de > ate) {
    const temp = de;
    de = ate;
    ate = temp;
  }

  return {
    reference: 'intervalo_relativo',
    de,
    ate,
    source: 'relative_dual_reference',
  };
}

function detectReceiptTemporalMode(text) {
  const normalized = normalizeTextForAnalysis(text);
  if (!normalized) return 'unknown';
  const hasForecastSignal = hasAnyTermInText(normalized, FORECAST_RECEIPT_TERMS);
  const hasPastSignal = hasAnyTermInText(normalized, PAST_RECEIPT_TERMS);

  if (
    normalized.includes('vou receber') ||
    normalized.includes('vou ganhar') ||
    normalized.includes('se pagarem') ||
    normalized.includes('se pagar')
  ) {
    return 'forecast';
  }
  if (
    normalized.includes('recebi') ||
    normalized.includes('entrou') ||
    normalized.includes('foi pago')
  ) {
    return 'past';
  }

  if (hasForecastSignal && !hasPastSignal) return 'forecast';
  if (hasPastSignal && !hasForecastSignal) return 'past';
  if (hasForecastSignal && hasPastSignal) return 'forecast';
  return 'unknown';
}

function extractNaturalSingleDateFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const monthNamesRegex = Object.keys(MONTH_NAME_TO_NUMBER).join('|');
  const dayMonthRegex = new RegExp(
    `\\b(?:dia\\s+)?(\\d{1,2})\\s*(?:de\\s+)?(${monthNamesRegex})(?:\\s+de\\s+(20\\d{2}))?\\b`
  );
  const dayMonthMatch = base.match(dayMonthRegex);
  if (dayMonthMatch) {
    const day = Number(dayMonthMatch[1]);
    const month = MONTH_NAME_TO_NUMBER[dayMonthMatch[2]];
    const year = dayMonthMatch[3] ? Number(dayMonthMatch[3]) : currentYear;
    const iso = toIsoDateFromParts(year, month, day);
    if (iso) {
      return {
        reference: 'data_explicita',
        de: iso,
        ate: iso,
        source: 'natural_day_month',
      };
    }
  }

  const dayOnlyMatch = base.match(/\bdia\s+(\d{1,2})\b/);
  if (dayOnlyMatch) {
    const day = Number(dayOnlyMatch[1]);
    const iso = toIsoDateFromParts(currentYear, currentMonth, day);
    if (iso) {
      return {
        reference: 'data_explicita',
        de: iso,
        ate: iso,
        source: 'natural_day_only',
      };
    }
  }

  return null;
}

function getWeekRange(offsetWeeks = 0) {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = base.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(base);
  monday.setDate(base.getDate() + diffToMonday + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const de = toIsoFromLocalDate(monday);
  const ate = toIsoFromLocalDate(sunday);
  if (!de || !ate) return null;
  return { de, ate };
}

function extractRelativeRangeFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;

  if (base.includes('semana que vem') || base.includes('proxima semana')) {
    const range = getWeekRange(1);
    if (range) {
      return {
        reference: 'semana_que_vem',
        de: range.de,
        ate: range.ate,
        source: 'relative_phrase',
      };
    }
  }

  if (base.includes('semana passada')) {
    const range = getWeekRange(-1);
    if (range) {
      return {
        reference: 'semana_passada',
        de: range.de,
        ate: range.ate,
        source: 'relative_phrase',
      };
    }
  }

  if (base.includes('esta semana') || base.includes('essa semana')) {
    const range = getWeekRange(0);
    if (range) {
      return {
        reference: 'semana_atual',
        de: range.de,
        ate: range.ate,
        source: 'relative_phrase',
      };
    }
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (base.includes('mes passado')) {
    let month = currentMonth - 1;
    let year = currentYear;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    const range = buildMonthRange(year, month);
    if (range) {
      return {
        reference: 'mes_passado',
        de: range.de,
        ate: range.ate,
        source: 'relative_phrase',
      };
    }
  }

  if (base.includes('mes que vem') || base.includes('proximo mes')) {
    let month = currentMonth + 1;
    let year = currentYear;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    const range = buildMonthRange(year, month);
    if (range) {
      return {
        reference: 'mes_que_vem',
        de: range.de,
        ate: range.ate,
        source: 'relative_phrase',
      };
    }
  }

  return null;
}

function extractExplicitRangeFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;
  const isoMatches = Array.from(base.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)).map((m) => m[1]);
  if (isoMatches.length >= 2) {
    const sorted = isoMatches.slice(0, 2).sort();
    return { de: sorted[0], ate: sorted[1], source: 'iso' };
  }
  if (isoMatches.length === 1) {
    return { de: isoMatches[0], ate: isoMatches[0], source: 'iso_single' };
  }

  const brMatches = Array.from(base.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g))
    .map((m) => parseIsoDateFromBrDate(m[1]))
    .filter((v) => isISODate(v));
  if (brMatches.length >= 2) {
    const sorted = brMatches.slice(0, 2).sort();
    return { de: sorted[0], ate: sorted[1], source: 'br' };
  }
  if (brMatches.length === 1) {
    return { de: brMatches[0], ate: brMatches[0], source: 'br_single' };
  }
  return null;
}

function extractMonthYearRangeFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;

  const monthRegex = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(?:de)?\s*(20\d{2})\b/;
  const monthMatch = base.match(monthRegex);
  if (monthMatch) {
    const month = MONTH_NAME_TO_NUMBER[monthMatch[1]];
    const year = Number(monthMatch[2]);
    const range = buildMonthRange(year, month);
    if (range) {
      return {
        reference: 'mes',
        de: range.de,
        ate: range.ate,
        source: 'month_year_text',
      };
    }
  }

  const yearMatch = base.match(/\b(20\d{2})\b/);
  if (yearMatch && base.includes('ano')) {
    const year = Number(yearMatch[1]);
    return {
      reference: 'ano',
      de: `${String(year)}-01-01`,
      ate: `${String(year)}-12-31`,
      source: 'year_text',
    };
  }
  return null;
}

function extractYearRangeFromText(text) {
  const base = normalizeTextForAnalysis(text);
  if (!base) return null;
  const years = Array.from(base.matchAll(/\b(20\d{2})\b/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n));
  if (years.length < 2) return null;
  const sorted = years.slice().sort((a, b) => a - b);
  const startYear = sorted[0];
  const endYear = sorted[sorted.length - 1];
  if (endYear < startYear) return null;
  return {
    reference: 'intervalo_explicito',
    de: `${startYear}-01-01`,
    ate: `${endYear}-12-31`,
    source: 'year_range_text',
  };
}

function inferTemporalScope({ userText, planning, screenContext }) {
  const text = normalizeTextForAnalysis(userText);
  const p = isPlainObject(planning) ? planning : {};
  const args = isPlainObject(p.tool_args) ? p.tool_args : {};
  const entities = isPlainObject(p.entities) ? p.entities : {};
  const ctx = isPlainObject(screenContext) ? screenContext : {};
  const filters = isPlainObject(ctx.active_filters) ? ctx.active_filters : {};

  const explicitRange = extractExplicitRangeFromText(text);
  if (explicitRange) {
    return {
      reference: 'intervalo_explicito',
      de: explicitRange.de,
      ate: explicitRange.ate,
      source: explicitRange.source,
    };
  }

  const relativeInterval = extractRelativeIntervalFromText(text);
  if (relativeInterval) return relativeInterval;

  const naturalSingleDate = extractNaturalSingleDateFromText(text);
  if (naturalSingleDate) return naturalSingleDate;

  const relativeRange = extractRelativeRangeFromText(text);
  if (relativeRange) return relativeRange;

  const monthOrYearRange = extractMonthYearRangeFromText(text);
  if (monthOrYearRange) return monthOrYearRange;
  const yearRange = extractYearRangeFromText(text);
  if (yearRange) return yearRange;

  const candidatesDe = [
    sanitizeShortText(args.de),
    sanitizeShortText(entities.de),
    sanitizeShortText(filters.de),
    sanitizeShortText(filters.data_de),
  ].filter((value) => isISODate(value));
  const candidatesAte = [
    sanitizeShortText(args.ate),
    sanitizeShortText(entities.ate),
    sanitizeShortText(filters.ate),
    sanitizeShortText(filters.data_ate),
  ].filter((value) => isISODate(value));
  if (candidatesDe.length || candidatesAte.length) {
    const de = candidatesDe[0] || candidatesAte[0];
    const ate = candidatesAte[0] || candidatesDe[0];
    return {
      reference: 'intervalo_explicito',
      de,
      ate,
      source: 'args_or_context',
    };
  }

  if (text.includes('hoje')) {
    const date = todayISO();
    return { reference: 'hoje', de: date, ate: date, source: 'relative' };
  }
  if (text.includes('ontem')) {
    const date = shiftISODate(todayISO(), -1);
    return { reference: 'ontem', de: date, ate: date, source: 'relative' };
  }
  if (text.includes('amanha')) {
    const date = shiftISODate(todayISO(), 1);
    return { reference: 'amanha', de: date, ate: date, source: 'relative' };
  }

  if (text.includes('mes')) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const range = buildMonthRange(year, month);
    if (range) {
      return {
        reference: 'mes',
        de: range.de,
        ate: range.ate,
        source: 'relative',
      };
    }
  }

  if (text.includes('ano')) {
    const year = new Date().getUTCFullYear();
    return {
      reference: 'ano',
      de: `${year}-01-01`,
      ate: `${year}-12-31`,
      source: 'relative',
    };
  }

  const periodReference = sanitizeShortText(
    p.temporal_scope || p.period_reference || p.periodo || p.data
  ).toLowerCase();
  if (periodReference) {
    return {
      reference: periodReference,
      de: isISODate(args.de) ? args.de : null,
      ate: isISODate(args.ate) ? args.ate : null,
      source: 'planning',
    };
  }

  return {
    reference: 'indefinido',
    de: null,
    ate: null,
    source: 'none',
  };
}

function buildCaixaResumoArgsFromTemporalScope(temporalScope) {
  const t = isPlainObject(temporalScope) ? temporalScope : {};
  const de = sanitizeShortText(t.de);
  const ate = sanitizeShortText(t.ate);
  if (isISODate(de) && isISODate(ate)) {
    if (de === ate) {
      return { periodo: 'dia', de, ate };
    }
    return { periodo: 'custom', de, ate };
  }
  return null;
}

function detectCompositeAggregationsFromText(text) {
  const normalized = normalizeTextForAnalysis(text);
  if (!normalized) {
    return {
      count: false,
      list: false,
      sum: false,
    };
  }

  return {
    count:
      normalized.includes('quantos') ||
      normalized.includes('quantas') ||
      normalized.includes('qtd'),
    list:
      normalized.includes('quais') ||
      normalized.includes('quem') ||
      normalized.includes('lista'),
    sum:
      normalized.includes('quanto') ||
      normalized.includes('valor') ||
      normalized.includes('receber') ||
      normalized.includes('receb'),
  };
}

function detectDeterministicRoute({ userText, screenContext }) {
  const text = normalizeTextForAnalysis(userText);
  if (!text) {
    return {
      matched: false,
      reason: 'empty',
    };
  }

  const temporalScope = inferTemporalScope({
    userText,
    planning: {},
    screenContext,
  });
  const hasExplicitPeriod =
    sanitizeShortText(temporalScope.reference, 'indefinido') !== 'indefinido' &&
    isISODate(sanitizeShortText(temporalScope.de)) &&
    isISODate(sanitizeShortText(temporalScope.ate));
  const isIntervalPeriod =
    hasExplicitPeriod &&
    sanitizeShortText(temporalScope.de) !== sanitizeShortText(temporalScope.ate);

  const hasReceivedSignal =
    hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS) ||
    text.includes('quanto entrou') ||
    text.includes('quanto entrou no caixa');
  const receiptMode = detectReceiptTemporalMode(text);
  const isForecastReceipt = receiptMode === 'forecast';
  const aggregationFlags = detectCompositeAggregationsFromText(text);
  const hasVencerSignal =
    text.includes('vencer') ||
    text.includes('vencem') ||
    text.includes('vencendo') ||
    text.includes('vai vencer') ||
    text.includes('vao vencer');
  const asksCountOrListOrSum =
    Boolean(aggregationFlags.count || aggregationFlags.list || aggregationFlags.sum);

  if (hasExplicitPeriod && hasVencerSignal && asksCountOrListOrSum) {
    return {
      matched: true,
      reason: 'deterministic_event_multi_intent',
      intent: 'evento_parcelas_multi_intent',
      semantic_intent: 'evento',
      question_type: 'evento',
      primary_entity: 'parcela',
      aggregation: aggregationFlags.sum
        ? 'soma'
        : aggregationFlags.count && aggregationFlags.list
          ? 'agrupamento_cliente'
          : 'contagem_parcelas',
      temporal_scope: temporalScope,
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: 'vencendo',
        de: sanitizeShortText(temporalScope.de),
        ate: sanitizeShortText(temporalScope.ate),
        incluirPagas: false,
      },
      multi_intent: aggregationFlags,
      confidence: 0.99,
    };
  }

  if (hasExplicitPeriod && isForecastReceipt && (hasReceivedSignal || text.includes('ganhar'))) {
    return {
      matched: true,
      reason: 'deterministic_forecast_receivable_summary',
      intent: 'previsao_recebimento_parcelas',
      semantic_intent: 'evento',
      question_type: 'evento',
      primary_entity: 'parcela',
      aggregation: 'soma',
      temporal_scope: temporalScope,
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: 'vencendo',
        de: sanitizeShortText(temporalScope.de),
        ate: sanitizeShortText(temporalScope.ate),
        incluirPagas: false,
      },
      forecast_mode: true,
      confidence: isIntervalPeriod ? 0.99 : 0.95,
    };
  }

  const hasCashSummaryHint =
    hasAnyTermInText(text, CASH_SUMMARY_HINT_TERMS) ||
    text.includes('total recebido') ||
    text.includes('resumo de recebimento');
  const hasConflictingOperationalSignal =
    hasAnyTermInText(text, ['vencid', 'vencendo', 'atrasad', 'parcela', 'parcelas']) &&
    !hasCashSummaryHint;

  if (
    !hasExplicitPeriod ||
    !hasReceivedSignal ||
    hasConflictingOperationalSignal ||
    isForecastReceipt
  ) {
    return {
      matched: false,
      reason: 'not_applicable',
      temporal_scope: temporalScope,
    };
  }

  const toolArgs = buildCaixaResumoArgsFromTemporalScope(temporalScope);
  if (!toolArgs) {
    return {
      matched: false,
      reason: 'invalid_period',
      temporal_scope: temporalScope,
    };
  }

  return {
    matched: true,
    reason: 'deterministic_cash_receipt_summary',
    intent: 'resumo_caixa_recebimento',
    semantic_intent: 'resumo',
    question_type: 'resumo',
    primary_entity: 'caixa',
    aggregation: 'soma',
    temporal_scope: temporalScope,
    tool_name: 'caixa_resumo',
    tool_args: toolArgs,
    confidence: 0.99,
  };
}

function scoreEntitiesByText(userText) {
  const text = normalizeTextForAnalysis(userText);
  const score = {
    cliente: 0,
    emprestimo: 0,
    parcela: 0,
    pagamento: 0,
    notificacao: 0,
    caixa: 0,
  };
  for (const [entity, terms] of Object.entries(ENTITY_SIGNAL_TERMS)) {
    for (const term of terms) {
      if (text.includes(term)) score[entity] += 1;
    }
  }
  return score;
}

function inferPrimaryEntity({ userText, planning }) {
  const p = isPlainObject(planning) ? planning : {};
  const entities = isPlainObject(p.entities) ? p.entities : {};
  const text = normalizeTextForAnalysis(userText);
  const hasReceivedSignal = hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS);
  const hasCapitalSignal = text.includes('capital');
  const hasInterestSignal = text.includes('juros');
  const compositeAggregations = detectCompositeAggregationsFromText(text);
  const compositeAggregationCount =
    (compositeAggregations.count ? 1 : 0) +
    (compositeAggregations.list ? 1 : 0) +
    (compositeAggregations.sum ? 1 : 0);
  const isMultiIntent = compositeAggregationCount >= 2;
  const declared = normalizeSemanticEntity(p.primary_entity, '');
  if (declared) return declared;

  if (p.tool_name && TOOL_ENTITY_HINTS[p.tool_name]) {
    return TOOL_ENTITY_HINTS[p.tool_name];
  }

  if (entities.emprestimo_id || entities.emprestimo) return 'emprestimo';
  if (entities.cliente_id || entities.cliente || entities.nome) return 'cliente';
  if (entities.parcela_id || entities.parcela || entities.vencimento) return 'parcela';
  if (hasReceivedSignal && (hasCapitalSignal || hasInterestSignal)) return 'caixa';

  const score = scoreEntitiesByText(userText);
  let bestEntity = 'outro';
  let bestScore = 0;
  for (const [entity, value] of Object.entries(score)) {
    if (value > bestScore) {
      bestScore = value;
      bestEntity = entity;
    }
  }
  return bestScore > 0 ? bestEntity : 'outro';
}

function inferSecondaryEntities({ userText, primaryEntity }) {
  const score = scoreEntitiesByText(userText);
  const out = [];
  for (const [entity, value] of Object.entries(score)) {
    if (entity === primaryEntity) continue;
    if (value <= 0) continue;
    out.push(entity);
  }
  return out.slice(0, 3);
}

function inferAggregation({ userText, planning }) {
  const p = isPlainObject(planning) ? planning : {};
  const declared = normalizeSemanticAggregation(p.aggregation, '');
  if (declared) return declared;

  const text = normalizeTextForAnalysis(userText);
  for (const [aggregation, terms] of Object.entries(AGGREGATION_SIGNAL_TERMS)) {
    if (terms.some((term) => text.includes(term))) return aggregation;
  }
  return 'nenhuma';
}

function mapSemanticIntentToQuestionType(intent) {
  const normalizedIntent = normalizeSemanticIntent(intent, 'outro');
  if (normalizedIntent === 'evento') return 'evento';
  if (normalizedIntent === 'estoque') return 'estoque';
  if (normalizedIntent === 'detalhe') return 'detalhe';
  if (normalizedIntent === 'resumo') return 'resumo';
  if (normalizedIntent === 'ambiguous_event_vs_stock') return 'ambiguous_event_vs_stock';
  if (normalizedIntent === 'busca_cliente') return 'detalhe';
  if (normalizedIntent === 'fila_alertas') return 'estoque';
  return 'outro';
}

function inferSemanticIntent({
  userText,
  planning,
  requestClassification,
  primaryEntity,
  temporalScope,
}) {
  const p = isPlainObject(planning) ? planning : {};
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const text = normalizeTextForAnalysis(userText);
  const hasReceivedSignal = hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS);
  const hasCapitalSignal = text.includes('capital');
  const hasInterestSignal = text.includes('juros');
  const receiptMode = detectReceiptTemporalMode(text);

  const declaredIntent = normalizeSemanticIntent(
    p.semantic_intent || p.intent || p.question_type,
    ''
  );
  if (declaredIntent === 'ambiguous_event_vs_stock' && hasReceivedSignal && !hasAnyTermInText(text, EVENT_STOCK_AMBIGUITY_TERMS)) {
    // Corrige falso-positivo comum em perguntas de recebimento.
    return 'resumo';
  }
  if (declaredIntent) return declaredIntent;

  if (primaryEntity === 'cliente') {
    const hasSearchVerb =
      text.includes('buscar') ||
      text.includes('procura') ||
      text.includes('encontrar') ||
      text.includes('localizar');
    const hasOperationalSignal =
      hasAnyTermInText(text, EVENT_STOCK_AMBIGUITY_TERMS) ||
      hasAnyTermInText(text, ['quanto', 'total', 'resumo', 'atrasad', 'vencid', 'pagou', 'pagaram']);
    if (hasSearchVerb || (text.includes('cliente') && !hasOperationalSignal)) {
      return 'busca_cliente';
    }
  }

  if (primaryEntity === 'notificacao') return 'fila_alertas';

  if (Boolean(rc.possible_event_vs_stock)) return 'ambiguous_event_vs_stock';

  if (text.includes('detalhe') || text.includes('detalhar') || text.includes('contrato') || text.includes('emprestimo #')) {
    return 'detalhe';
  }

  if (receiptMode === 'forecast') return 'evento';
  if (primaryEntity === 'caixa') return 'resumo';
  if (hasReceivedSignal && (hasCapitalSignal || hasInterestSignal)) return 'resumo';

  if (text.includes('vencendo') || text.includes('vence hoje') || text.includes('vencer')) {
    return 'evento';
  }
  if (text.includes('vencida') || text.includes('vencidas') || text.includes('atrasad')) {
    return 'estoque';
  }
  if (text.includes('resumo') || text.includes('quanto') || text.includes('total')) {
    if (temporalScope.reference && temporalScope.reference !== 'indefinido') return 'resumo';
  }

  return 'outro';
}

function detectMandatoryAmbiguity({
  userText,
  semanticIntent,
  temporalScope,
  requestClassification,
}) {
  const text = normalizeTextForAnalysis(userText);
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const hasReceivedSignal = hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS);
  const hasEventStockLexeme = hasAnyTermInText(text, EVENT_STOCK_AMBIGUITY_TERMS);
  const explicitCapitalJurosBreakdown = text.includes('capital') && text.includes('juros');
  const explicitCashContext =
    explicitCapitalJurosBreakdown ||
    text.includes('caixa') ||
    text.includes('entrada') ||
    text.includes('entradas');
  const hasExplicitPeriod =
    isPlainObject(temporalScope) &&
    sanitizeShortText(temporalScope.reference, 'indefinido') !== 'indefinido';
  const options = [];
  const reasons = [];

  for (const pattern of MANDATORY_AMBIGUITY_PATTERNS) {
    const matched = Array.isArray(pattern.terms)
      ? pattern.terms.some((term) => text.includes(term))
      : false;
    if (!matched) continue;
    if (
      (pattern.id === 'quanto_recebi' || pattern.id === 'quanto_entrou') &&
      explicitCashContext &&
      hasExplicitPeriod
    ) {
      // Ja esta semanticamente desambiguado para resumo de caixa.
      continue;
    }
    reasons.push(pattern.id);
    if (Array.isArray(pattern.options)) {
      options.push(...pattern.options);
    }
  }

  const eventStockAmbiguityRaw =
    semanticIntent === 'ambiguous_event_vs_stock' ||
    Boolean(rc.possible_event_vs_stock) ||
    (hasAnyTermInText(text, EVENT_STOCK_AMBIGUITY_TERMS) &&
      hasAnyTermInText(text, ['hoje', 'ontem', 'amanha', 'data', 'periodo', 'mes', 'ano']));
  const eventStockAmbiguity =
    eventStockAmbiguityRaw &&
    !(hasReceivedSignal && explicitCapitalJurosBreakdown && !hasEventStockLexeme);

  if (eventStockAmbiguity) {
    reasons.push('evento_vs_estoque');
    const periodLabel = sanitizeShortText(temporalScope && temporalScope.reference, 'o periodo informado');
    options.push(`parcelas que vencem em ${periodLabel} (evento)`);
    options.push('parcelas ja vencidas/em aberto (estoque)');
  }

  const uniqueOptions = uniqueOptionList(options).slice(0, 4);
  if (!uniqueOptions.length) {
    return {
      mandatory: false,
      reasons: [],
      options: [],
      question: '',
    };
  }
  return {
    mandatory: true,
    reasons: uniqueOptionList(reasons),
    options: uniqueOptions,
    question: buildForcedAmbiguityQuestion(uniqueOptions),
  };
}

function detectCoverageLimitation({ userText, semanticIntent, primaryEntity }) {
  const text = normalizeTextForAnalysis(userText);
  if (UNSUPPORTED_QUERY_SIGNALS.some((term) => text.includes(term))) {
    return 'Consigo consultar vencimento de parcelas e resumo de caixa, mas as tools atuais nao expoem consulta confiavel por data_pagamento.';
  }

  if (semanticIntent === 'outro' && primaryEntity === 'outro') {
    return 'Nao encontrei correspondencia segura com as tools disponiveis para essa pergunta.';
  }
  return '';
}

function inferRecommendedTool({ semanticIntent, primaryEntity, currentTool }) {
  const normalizedIntent = normalizeSemanticIntent(semanticIntent, 'outro');
  if (normalizedIntent === 'detalhe') {
    if (primaryEntity === 'cliente') return 'cliente_busca';
    if (primaryEntity === 'parcela' || primaryEntity === 'pagamento') return 'parcelas_por_periodo';
    if (primaryEntity === 'notificacao') return 'notificacoes_pendentes';
    return 'emprestimo_detalhe';
  }
  if (normalizedIntent === 'resumo') {
    if (primaryEntity === 'parcela' || primaryEntity === 'pagamento') return 'parcelas_por_periodo';
    if (primaryEntity === 'notificacao') return 'notificacoes_pendentes';
    if (primaryEntity === 'cliente') return 'cliente_busca';
    return 'caixa_resumo';
  }
  const preferredByIntent = TOOL_INTENT_MAP[normalizedIntent] || '';
  if (preferredByIntent) return preferredByIntent;

  if (primaryEntity === 'cliente') return 'cliente_busca';
  if (primaryEntity === 'emprestimo') return 'emprestimo_detalhe';
  if (primaryEntity === 'notificacao') return 'notificacoes_pendentes';
  if (primaryEntity === 'caixa') return 'caixa_resumo';
  if (primaryEntity === 'parcela' || primaryEntity === 'pagamento') return 'parcelas_por_periodo';
  return sanitizeShortText(currentTool);
}

function isToolCompatibleWithSemantic({ toolName, semanticIntent, primaryEntity }) {
  const tool = sanitizeShortText(toolName);
  const intent = normalizeSemanticIntent(semanticIntent, 'outro');
  const entity = normalizeSemanticEntity(primaryEntity, 'outro');

  if (!tool) return false;
  if (intent === 'busca_cliente') return tool === 'cliente_busca';
  if (intent === 'fila_alertas') return tool === 'notificacoes_pendentes';
  if (intent === 'detalhe' && entity === 'emprestimo') return tool === 'emprestimo_detalhe';
  if (intent === 'evento' || intent === 'estoque' || intent === 'ambiguous_event_vs_stock') {
    if (entity === 'notificacao') return tool === 'notificacoes_pendentes' || tool === 'parcelas_por_periodo';
    return tool === 'parcelas_por_periodo';
  }
  if (intent === 'resumo' && entity === 'caixa') return tool === 'caixa_resumo';
  if (intent === 'resumo' && entity === 'parcela') return tool === 'parcelas_por_periodo';

  if (entity === 'cliente') return tool === 'cliente_busca';
  if (entity === 'emprestimo') return tool === 'emprestimo_detalhe';
  if (entity === 'notificacao') return tool === 'notificacoes_pendentes';
  if (entity === 'caixa') return tool === 'caixa_resumo';
  if (entity === 'parcela' || entity === 'pagamento') return tool === 'parcelas_por_periodo';
  return true;
}

function applySemanticToolDefaults({ toolName, toolArgs, semanticIntent, temporalScope }) {
  const out = isPlainObject(toolArgs) ? { ...toolArgs } : {};
  const intent = normalizeSemanticIntent(semanticIntent, 'outro');
  const time = isPlainObject(temporalScope) ? temporalScope : { reference: 'indefinido', de: null, ate: null };
  const tool = sanitizeShortText(toolName);

  if (tool === 'parcelas_por_periodo') {
    const tipo = sanitizeShortText(out.tipo).toLowerCase();
    if (!tipo || !['vencidas', 'vencendo', 'todas'].includes(tipo)) {
      if (intent === 'evento') out.tipo = 'vencendo';
      else if (intent === 'estoque') out.tipo = 'vencidas';
      else out.tipo = 'todas';
    }
    if (time.de && !sanitizeShortText(out.de)) out.de = time.de;
    if (time.ate && !sanitizeShortText(out.ate)) out.ate = time.ate;
    if (out.incluirPagas == null) out.incluirPagas = false;
  }

  if (tool === 'caixa_resumo') {
    const periodo = sanitizeShortText(out.periodo).toLowerCase();
    if (!periodo) {
      if (time.reference === 'intervalo_explicito' && time.de && time.ate) out.periodo = 'custom';
      else if (time.reference === 'mes') out.periodo = 'mes';
      else if (time.reference === 'ano') out.periodo = 'ano';
      else out.periodo = 'dia';
    }
    if (out.periodo === 'custom') {
      if (time.de && !sanitizeShortText(out.de)) out.de = time.de;
      if (time.ate && !sanitizeShortText(out.ate)) out.ate = time.ate;
    }
  }

  return out;
}

function buildSemanticDecisionProfile({
  userText,
  planning,
  requestClassification,
  screenContext,
}) {
  const p = isPlainObject(planning) ? planning : {};
  const text = normalizeTextForAnalysis(userText);
  const hasReceivedSignal = hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS);
  const hasCapitalSignal = text.includes('capital');
  const hasInterestSignal = text.includes('juros');
  const compositeAggregations = detectCompositeAggregationsFromText(text);
  const compositeAggregationCount =
    (compositeAggregations.count ? 1 : 0) +
    (compositeAggregations.list ? 1 : 0) +
    (compositeAggregations.sum ? 1 : 0);
  const isMultiIntent = compositeAggregationCount >= 2;
  const primaryEntity = inferPrimaryEntity({ userText, planning: p });
  const secondaryEntities = inferSecondaryEntities({ userText, primaryEntity });
  const temporalScope = inferTemporalScope({ userText, planning: p, screenContext });
  const aggregation = hasCapitalSignal && hasInterestSignal
    ? 'soma'
    : inferAggregation({ userText, planning: p });
  const semanticIntent = inferSemanticIntent({
    userText,
    planning: p,
    requestClassification,
    primaryEntity,
    temporalScope,
  });
  const forcedSummaryContext = hasReceivedSignal && (hasCapitalSignal || hasInterestSignal);
  const effectiveIntent = forcedSummaryContext ? 'resumo' : semanticIntent;
  const effectivePrimaryEntity = forcedSummaryContext ? 'caixa' : primaryEntity;
  const ambiguity = detectMandatoryAmbiguity({
    userText,
    semanticIntent: effectiveIntent,
    temporalScope,
    requestClassification,
  });
  const normalizedText = normalizeTextForAnalysis(userText);
  const periodCanBeImplicitNow =
    normalizedText.includes('agora') ||
    normalizedText.includes('atual') ||
    normalizedText.includes('nesse momento') ||
    normalizedText.includes('neste momento');
  const needsPeriodClarification =
    (effectiveIntent === 'evento' || effectiveIntent === 'estoque' || effectiveIntent === 'resumo') &&
    (!temporalScope || temporalScope.reference === 'indefinido') &&
    !periodCanBeImplicitNow;
  const periodAmbiguityOptions = needsPeriodClarification
    ? ['hoje', 'ontem', 'este mes']
    : [];
  const mergedAmbiguityOptions = uniqueOptionList([
    ...(Array.isArray(ambiguity.options) ? ambiguity.options : []),
    ...periodAmbiguityOptions,
  ]).slice(0, 4);
  const ambiguityQuestion = needsPeriodClarification
    ? 'Qual periodo voce quer consultar? 1) hoje 2) ontem 3) este mes'
    : ambiguity.question;
  const recommendedTool = inferRecommendedTool({
    semanticIntent: effectiveIntent,
    primaryEntity: effectivePrimaryEntity,
    currentTool: p.tool_name,
  });
  const coverageLimitation = detectCoverageLimitation({
    userText,
    semanticIntent: effectiveIntent,
    primaryEntity: effectivePrimaryEntity,
  });

  return {
    semantic_intent: effectiveIntent,
    question_type: mapSemanticIntentToQuestionType(effectiveIntent),
    primary_entity: effectivePrimaryEntity,
    secondary_entities: secondaryEntities,
    aggregation,
    temporal_scope: temporalScope,
    mandatory_ambiguity: Boolean(ambiguity.mandatory || needsPeriodClarification),
    ambiguity_reasons: uniqueOptionList([
      ...(Array.isArray(ambiguity.reasons) ? ambiguity.reasons : []),
      ...(needsPeriodClarification ? ['missing_period'] : []),
    ]),
    ambiguity_options: mergedAmbiguityOptions,
    ambiguity_question: ambiguityQuestion,
    recommended_tool: recommendedTool,
    tool_compatible: isToolCompatibleWithSemantic({
      toolName: p.tool_name || recommendedTool,
      semanticIntent,
      primaryEntity,
    }),
    multi_intent: compositeAggregations,
    is_multi_intent: isMultiIntent,
    coverage_limitation: coverageLimitation,
  };
}

function applySemanticProfileToPlanning({ planning, semanticProfile }) {
  const p = isPlainObject(planning) ? planning : {};
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  const next = {
    ...p,
    entities: isPlainObject(p.entities) ? { ...p.entities } : {},
    tool_args: isPlainObject(p.tool_args) ? { ...p.tool_args } : {},
    semantic_intent: normalizeSemanticIntent(
      semantic.semantic_intent || p.semantic_intent || p.intent,
      'outro'
    ),
    question_type: normalizeQuestionType(
      semantic.question_type || p.question_type || mapSemanticIntentToQuestionType(semantic.semantic_intent)
    ),
    primary_entity: normalizeSemanticEntity(semantic.primary_entity || p.primary_entity, 'outro'),
    secondary_entities: Array.isArray(semantic.secondary_entities)
      ? semantic.secondary_entities
      : Array.isArray(p.secondary_entities)
        ? p.secondary_entities
        : [],
    aggregation: normalizeSemanticAggregation(
      semantic.aggregation || p.aggregation,
      'nenhuma'
    ),
    temporal_scope: sanitizeShortText(
      (semantic.temporal_scope && semantic.temporal_scope.reference) ||
        semantic.temporal_scope ||
        p.temporal_scope ||
        p.period_reference
    ),
    ambiguity_flags: Array.isArray(p.ambiguity_flags) ? p.ambiguity_flags.slice(0, 5) : [],
    strategy: sanitizeShortText(p.strategy),
  };

  const preferredTool = sanitizeShortText(semantic.recommended_tool);
  if (!sanitizeShortText(next.tool_name) && preferredTool) {
    next.tool_name = preferredTool;
  } else if (sanitizeShortText(next.tool_name) && preferredTool) {
    const compatible = isToolCompatibleWithSemantic({
      toolName: next.tool_name,
      semanticIntent: next.semantic_intent,
      primaryEntity: next.primary_entity,
    });
    if (!compatible) {
      next.tool_name = preferredTool;
    }
  }

  next.tool_args = applySemanticToolDefaults({
    toolName: next.tool_name,
    toolArgs: next.tool_args,
    semanticIntent: next.semantic_intent,
    temporalScope: semantic.temporal_scope,
  });

  if (!sanitizeShortText(next.intent)) {
    next.intent = next.semantic_intent;
  }
  if (!sanitizeShortText(next.period_reference) && isPlainObject(semantic.temporal_scope)) {
    next.period_reference = sanitizeShortText(semantic.temporal_scope.reference);
  }
  return next;
}

function enrichRequestClassificationWithSemantic(requestClassification, semanticProfile) {
  const base = isPlainObject(requestClassification) ? { ...requestClassification } : {};
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  return {
    ...base,
    semantic: {
      intent: semantic.semantic_intent || 'outro',
      primary_entity: semantic.primary_entity || 'outro',
      secondary_entities: Array.isArray(semantic.secondary_entities)
        ? semantic.secondary_entities
        : [],
      aggregation: semantic.aggregation || 'nenhuma',
      temporal_scope: semantic.temporal_scope || { reference: 'indefinido' },
      recommended_tool: semantic.recommended_tool || '',
      multi_intent: isPlainObject(semantic.multi_intent) ? semantic.multi_intent : {},
      is_multi_intent: Boolean(semantic.is_multi_intent),
      mandatory_ambiguity: Boolean(semantic.mandatory_ambiguity),
      ambiguity_reasons: Array.isArray(semantic.ambiguity_reasons)
        ? semantic.ambiguity_reasons
        : [],
      coverage_limitation: sanitizeShortText(semantic.coverage_limitation),
    },
  };
}

function applySemanticSafetyGuard({ userText, planning, semanticProfile }) {
  const p = isPlainObject(planning) ? { ...planning } : {};
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  const text = normalizeTextForAnalysis(userText);
  const receiptMode = detectReceiptTemporalMode(text);
  const hasReceivedSignal =
    hasAnyTermInText(text, RECEIVED_SIGNAL_TERMS) ||
    text.includes('quanto entrou');
  const hasCashSummaryHint = hasAnyTermInText(text, CASH_SUMMARY_HINT_TERMS);
  const hasVencerSignal =
    text.includes('vencer') ||
    text.includes('vencem') ||
    text.includes('vencendo') ||
    text.includes('vai vencer') ||
    text.includes('vao vencer');
  const semanticIntent = normalizeSemanticIntent(
    semantic.semantic_intent || p.semantic_intent || p.intent || p.question_type,
    'outro'
  );

  if (hasVencerSignal || semanticIntent === 'evento') {
    return {
      blocked: false,
      corrected: false,
      planning: p,
      reason: '',
      message: '',
    };
  }

  if (receiptMode === 'forecast') {
    return {
      blocked: false,
      corrected: false,
      planning: p,
      reason: '',
      message: '',
    };
  }

  if (!hasReceivedSignal && !hasCashSummaryHint) {
    return {
      blocked: false,
      corrected: false,
      planning: p,
      reason: '',
      message: '',
    };
  }

  const temporalScope = isPlainObject(semantic.temporal_scope) ? semantic.temporal_scope : {};
  const toolArgsFromScope = buildCaixaResumoArgsFromTemporalScope(temporalScope);
  if (!toolArgsFromScope) {
    return {
      blocked: true,
      corrected: false,
      planning: p,
      reason: 'missing_period_for_cash_summary',
      message: 'Para essa consulta de recebimento, preciso do periodo exato.',
    };
  }

  const currentTool = sanitizeShortText(p.tool_name);
  if (currentTool === 'caixa_resumo') {
    return {
      blocked: false,
      corrected: false,
      planning: {
        ...p,
        tool_args: {
          ...(isPlainObject(p.tool_args) ? p.tool_args : {}),
          ...toolArgsFromScope,
        },
      },
      reason: '',
      message: '',
    };
  }

  const correctedPlanning = {
    ...p,
    tool_name: 'caixa_resumo',
    tool_args: toolArgsFromScope,
    semantic_intent: 'resumo',
    question_type: 'resumo',
    primary_entity: 'caixa',
    aggregation: 'soma',
    intent: sanitizeShortText(p.intent, 'resumo_caixa_recebimento'),
    needs_clarification: false,
    clarification_question: '',
    strategy: sanitizeShortText(
      p.strategy,
      'semantic_safety_guard_forced_caixa_resumo'
    ),
  };

  return {
    blocked: false,
    corrected: true,
    planning: correctedPlanning,
    reason: 'tool_mismatch_guard_corrected_to_caixa_resumo',
    message: '',
  };
}

function normalizeAmbiguityLevel(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    if (rawValue >= 0.66) return 'alto';
    if (rawValue >= 0.33) return 'medio';
    return 'baixo';
  }
  const normalized = sanitizeShortText(rawValue).toLowerCase();
  if (!normalized) return 'medio';
  if (AMBIGUITY_LEVELS.has(normalized)) return normalized;
  if (normalized === 'high') return 'alto';
  if (normalized === 'low') return 'baixo';
  return 'medio';
}

function sanitizeDomainTranslation(rawValue) {
  if (!isPlainObject(rawValue)) return {};
  const out = {};
  for (const [key, value] of Object.entries(rawValue)) {
    const cleanKey = sanitizeShortText(key);
    const cleanValue = sanitizeShortText(value);
    if (!cleanKey || !cleanValue) continue;
    out[cleanKey] = cleanValue;
  }
  return out;
}

function normalizeInterpretationPeriod(rawPlanning) {
  if (!isPlainObject(rawPlanning)) return '';
  return sanitizeShortText(
    rawPlanning.period_reference || rawPlanning.periodo || rawPlanning.data || rawPlanning.period
  );
}

function todayISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function shiftISODate(baseIso, deltaDays) {
  if (!isISODate(baseIso)) return todayISO();
  const [year, month, day] = String(baseIso).split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  return date.toISOString().slice(0, 10);
}

function inferPeriodDate(rawValue) {
  const normalized = normalizeTextForAnalysis(rawValue);
  if (!normalized) return null;
  if (normalized === 'hoje') return todayISO();
  if (normalized === 'ontem') return shiftISODate(todayISO(), -1);
  if (normalized === 'amanha') return shiftISODate(todayISO(), 1);
  return null;
}

function resolveEventStockRange({ planning, screenContext }) {
  const p = isPlainObject(planning) ? planning : {};
  const args = isPlainObject(p.tool_args) ? p.tool_args : {};
  const entities = isPlainObject(p.entities) ? p.entities : {};
  const ctx = isPlainObject(screenContext) ? screenContext : {};
  const filters = isPlainObject(ctx.active_filters) ? ctx.active_filters : {};

  const candidatesDe = [
    sanitizeShortText(args.de),
    sanitizeShortText(entities.de),
    sanitizeShortText(filters.de),
    sanitizeShortText(filters.data_de),
  ];
  const candidatesAte = [
    sanitizeShortText(args.ate),
    sanitizeShortText(entities.ate),
    sanitizeShortText(filters.ate),
    sanitizeShortText(filters.data_ate),
  ];

  let de = candidatesDe.find((value) => isISODate(value)) || '';
  let ate = candidatesAte.find((value) => isISODate(value)) || '';
  const periodRefText = sanitizeShortText(p.period_reference || p.periodo || p.data);
  const explicitFromPeriodRef =
    extractExplicitRangeFromText(periodRefText) ||
    extractNaturalSingleDateFromText(periodRefText) ||
    extractRelativeRangeFromText(periodRefText) ||
    extractMonthYearRangeFromText(periodRefText) ||
    extractYearRangeFromText(periodRefText);
  if (!de && explicitFromPeriodRef && isISODate(explicitFromPeriodRef.de)) {
    de = explicitFromPeriodRef.de;
  }
  if (!ate && explicitFromPeriodRef && isISODate(explicitFromPeriodRef.ate)) {
    ate = explicitFromPeriodRef.ate;
  }
  const periodDate =
    inferPeriodDate(p.period_reference) ||
    inferPeriodDate(p.periodo) ||
    inferPeriodDate(p.data);

  if (!de && periodDate) de = periodDate;
  if (!ate && periodDate) ate = periodDate;
  if (!de && ate) de = ate;
  if (!ate && de) ate = de;
  if (!de || !ate) {
    return {
      de: '',
      ate: '',
      has_range: false,
    };
  }
  if (de > ate) {
    const tmp = de;
    de = ate;
    ate = tmp;
  }

  return {
    de,
    ate,
    has_range: true,
  };
}

function buildPendingClarificationCandidates({
  planning,
  decision,
  requestClassification,
  screenContext,
  resolvedContext,
}) {
  const p = isPlainObject(planning) ? planning : {};
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const options = Array.isArray(decision && decision.ambiguity_options)
    ? decision.ambiguity_options.slice(0, 5)
    : [];
  if (options.length < 2) return [];

  const range = resolveEventStockRange({ planning: p, screenContext });
  const baseContext = isPlainObject(resolvedContext) ? resolvedContext : {};
  const hasRange =
    Boolean(range && range.has_range) &&
    isISODate(sanitizeShortText(range.de)) &&
    isISODate(sanitizeShortText(range.ate));
  const preferredTool = sanitizeShortText(p.tool_name, 'parcelas_por_periodo');
  const candidates = [];
  for (let index = 0; index < options.length; index += 1) {
    const label = sanitizeShortText(options[index], `opcao ${index + 1}`);
    const normalized = normalizeTextForAnalysis(label);
    if (!normalized) continue;

    if (
      normalized === 'hoje' ||
      normalized === 'ontem' ||
      normalized.includes('este mes') ||
      normalized === 'mes'
    ) {
      const reference = normalized === 'ontem'
        ? 'ontem'
        : normalized.includes('mes')
          ? 'mes'
          : 'hoje';
      const today = todayISO();
      const date = reference === 'ontem' ? shiftISODate(today, -1) : today;
      const monthRange = buildMonthRange(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1);
      if (preferredTool === 'caixa_resumo') {
        candidates.push({
          label,
          tool_name: 'caixa_resumo',
          tool_args: reference === 'mes'
            ? { periodo: 'mes', de: monthRange.de, ate: monthRange.ate }
            : { periodo: 'dia', de: date, ate: date },
          intent: sanitizeShortText(p.intent, 'resumo_caixa'),
          resolved_context: baseContext,
        });
      } else if (preferredTool === 'parcelas_por_periodo') {
        const tipo = sanitizeShortText(p.tool_args && p.tool_args.tipo, '')
          || (normalizeQuestionType(p.question_type) === 'estoque' ? 'vencidas' : 'vencendo');
        candidates.push({
          label,
          tool_name: 'parcelas_por_periodo',
          tool_args: reference === 'mes'
            ? {
              tipo,
              de: monthRange.de,
              ate: monthRange.ate,
              incluirPagas: false,
            }
            : {
              tipo,
              de: date,
              ate: date,
              incluirPagas: false,
            },
          intent: sanitizeShortText(p.intent, 'parcelas_periodo'),
          resolved_context: baseContext,
        });
      } else if (preferredTool === 'notificacoes_pendentes') {
        candidates.push({
          label,
          tool_name: 'notificacoes_pendentes',
          tool_args: {},
          intent: 'fila_alertas',
          resolved_context: baseContext,
        });
      }
      continue;
    }

    if (normalized.includes('evento') || normalized.includes('vencem') || normalized.includes('vencendo')) {
      if (!hasRange) continue;
      candidates.push({
        label,
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'vencendo',
          de: range.de,
          ate: range.ate,
          incluirPagas: false,
        },
        intent: sanitizeShortText(p.intent, 'parcelas_evento'),
        resolved_context: baseContext,
      });
      continue;
    }

    if (normalized.includes('estoque') || normalized.includes('vencidas') || normalized.includes('aberto')) {
      if (!hasRange) continue;
      candidates.push({
        label,
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'vencidas',
          de: range.ate,
          ate: range.ate,
          incluirPagas: false,
        },
        intent: sanitizeShortText(p.intent, 'parcelas_estoque'),
        resolved_context: baseContext,
      });
      continue;
    }

    if (normalized.includes('caixa') || normalized.includes('entrada')) {
      if (!hasRange) continue;
      const periodo = range.de && range.ate && range.de !== range.ate ? 'custom' : 'dia';
      candidates.push({
        label,
        tool_name: 'caixa_resumo',
        tool_args: {
          periodo,
          ...(periodo === 'custom' ? { de: range.de, ate: range.ate } : { de: range.de, ate: range.ate }),
        },
        intent: 'resumo_caixa',
        resolved_context: baseContext,
      });
      continue;
    }

    if (normalized.includes('parcela') || normalized.includes('pagas') || normalized.includes('pagamentos')) {
      if (!hasRange) continue;
      candidates.push({
        label,
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'todas',
          de: range.de,
          ate: range.ate,
          incluirPagas: true,
        },
        intent: 'parcelas_pagamento',
        resolved_context: baseContext,
      });
      continue;
    }

    if (normalized.includes('notificacao') || normalized.includes('alerta')) {
      candidates.push({
        label,
        tool_name: 'notificacoes_pendentes',
        tool_args: {},
        intent: 'fila_alertas',
        resolved_context: baseContext,
      });
      continue;
    }
  }

  const eventStockAmbiguity =
    isAmbiguousEventVsStock(p) ||
    Boolean(rc.possible_event_vs_stock) ||
    options.some((item) => normalizeTextForAnalysis(item).includes('evento')) ||
    options.some((item) => normalizeTextForAnalysis(item).includes('estoque'));

  if (eventStockAmbiguity && hasRange && candidates.length < 2) {
    candidates.push(
      {
        label: sanitizeShortText(options[0], 'parcelas que vencem na data'),
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'vencendo',
          de: range.de,
          ate: range.ate,
          incluirPagas: false,
        },
        intent: sanitizeShortText(p.intent, 'parcelas_evento'),
        resolved_context: baseContext,
      },
      {
        label: sanitizeShortText(options[1], 'parcelas ja vencidas/em aberto'),
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'vencidas',
          de: range.ate,
          ate: range.ate,
          incluirPagas: false,
        },
        intent: sanitizeShortText(p.intent, 'parcelas_estoque'),
        resolved_context: baseContext,
      }
    );
  }

  return candidates.slice(0, 5);
}

function buildPendingClarificationReminder(pending) {
  const options = pending && Array.isArray(pending.options) ? pending.options : [];
  if (options.length < 2) {
    return 'Preciso confirmar a interpretacao antes de continuar. Pode detalhar melhor?';
  }
  const lines = ['Para continuar, escolha uma opcao:'];
  for (let i = 0; i < options.length; i += 1) {
    lines.push(`${i + 1}) ${sanitizeShortText(options[i])}`);
  }
  lines.push('Responda apenas com o numero da opcao (ex: 1).');
  return lines.join('\n');
}

async function callOpenAIChat({
  model,
  messages,
  temperature = 0.2,
  responseFormat = null,
}) {
  const { apiKey, baseUrl } = getOpenAIConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada no backend.');
  }

  const payload = {
    model,
    messages,
    temperature,
  };
  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(
      `Falha no modelo de IA (${resp.status}). ${errText || 'Resposta sem detalhes do provedor.'}`
    );
  }

  const data = await resp.json();
  return {
    content: extractMessageContent(data),
    usage: data && isPlainObject(data.usage) ? data.usage : null,
    model: data && typeof data.model === 'string' ? data.model : model,
  };
}

function normalizePlanningOutput(rawPlanning) {
  const raw = isPlainObject(rawPlanning) ? rawPlanning : {};
  const toolArgs = isPlainObject(raw.tool_args) ? raw.tool_args : {};
  const entities = isPlainObject(raw.entities) ? raw.entities : {};
  const questionType = normalizeQuestionType(raw.question_type || raw.tipo);
  const periodReference = normalizeInterpretationPeriod(raw);
  const ambiguityLevel = normalizeAmbiguityLevel(raw.ambiguity_level);
  const domainTranslation = sanitizeDomainTranslation(raw.domain_translation);

  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : null;

  return {
    intent: typeof raw.intent === 'string' ? raw.intent.trim() : '',
    semantic_intent: normalizeSemanticIntent(raw.semantic_intent || raw.intent || raw.question_type, 'outro'),
    tool_name: typeof raw.tool_name === 'string' ? raw.tool_name.trim() : '',
    tool_args: toolArgs,
    entities,
    question_type: questionType,
    primary_entity: normalizeSemanticEntity(raw.primary_entity, 'outro'),
    secondary_entities: Array.isArray(raw.secondary_entities)
      ? raw.secondary_entities
          .map((item) => normalizeSemanticEntity(item, ''))
          .filter(Boolean)
          .slice(0, 5)
      : [],
    aggregation: normalizeSemanticAggregation(raw.aggregation, 'nenhuma'),
    temporal_scope: sanitizeShortText(raw.temporal_scope),
    ambiguity_flags: Array.isArray(raw.ambiguity_flags)
      ? raw.ambiguity_flags
          .map((item) => sanitizeShortText(item))
          .filter(Boolean)
          .slice(0, 6)
      : [],
    strategy: sanitizeShortText(raw.strategy),
    period_reference: periodReference,
    ambiguity_level: ambiguityLevel,
    domain_translation: domainTranslation,
    needs_clarification: Boolean(raw.needs_clarification),
    clarification_question:
      typeof raw.clarification_question === 'string'
        ? raw.clarification_question.trim()
        : '',
    confidence,
    out_of_scope: Boolean(raw.out_of_scope),
    scope_reason:
      typeof raw.scope_reason === 'string' ? raw.scope_reason.trim() : '',
  };
}

function buildInterpretationSnapshot(planning) {
  const p = isPlainObject(planning) ? planning : {};
  const intent = sanitizeShortText(p.intent, 'desconhecido');
  const semanticIntent = normalizeSemanticIntent(p.semantic_intent || p.intent || p.question_type, 'outro');
  const questionType = normalizeQuestionType(p.question_type || p.tipo);
  const periodReference = sanitizeShortText(p.period_reference || p.data || p.periodo);
  const entities = isPlainObject(p.entities) ? p.entities : {};
  const ambiguityLevel = normalizeAmbiguityLevel(p.ambiguity_level);
  const confidenceRaw = Number(p.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  return {
    intent,
    semantic_intent: semanticIntent,
    tipo: questionType,
    data: periodReference || null,
    entidades: entities,
    primary_entity: normalizeSemanticEntity(p.primary_entity, 'outro'),
    aggregation: normalizeSemanticAggregation(p.aggregation, 'nenhuma'),
    temporal_scope: sanitizeShortText(p.temporal_scope || p.period_reference),
    ambiguidade: ambiguityLevel,
    confidence,
    domain_translation: sanitizeDomainTranslation(p.domain_translation),
  };
}

function isLowConfidence(confidence) {
  const n = Number(confidence);
  if (!Number.isFinite(n)) return true;
  return n < EXECUTION_CONFIDENCE_THRESHOLD;
}

function isAmbiguousEventVsStock(planning) {
  const p = isPlainObject(planning) ? planning : {};
  if (normalizeQuestionType(p.question_type || p.tipo) === 'ambiguous_event_vs_stock') {
    return true;
  }
  if (normalizeAmbiguityLevel(p.ambiguity_level) === 'alto') return true;
  return false;
}

function buildClarificationQuestionFromPlanning(planning) {
  const p = isPlainObject(planning) ? planning : {};
  if (sanitizeShortText(p.clarification_question)) {
    return sanitizeShortText(p.clarification_question);
  }
  if (isAmbiguousEventVsStock(p)) {
    return 'Voce quer parcelas que vencem na data (evento) ou parcelas ja vencidas/em aberto (estoque)?';
  }
  return 'Quero confirmar o entendimento antes de consultar. Pode detalhar periodo, cliente ou emprestimo?';
}

function uniqueOptionList(options) {
  const seen = new Set();
  const out = [];
  for (const option of options || []) {
    const text = sanitizeShortText(option);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function inferAmbiguityOptions({ userText, requestClassification, planning, interpretationSnapshot }) {
  const text = normalizeTextForAnalysis(userText);
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const p = isPlainObject(planning) ? planning : {};
  const interpretation = isPlainObject(interpretationSnapshot) ? interpretationSnapshot : {};

  const questionType = normalizeQuestionType(p.question_type || interpretation.tipo);
  const periodLabel = sanitizeShortText(
    interpretation.data || p.period_reference || p.data,
    'o periodo informado'
  );
  const hasTimeSignal = hasAnyTermInText(text, TIME_TERMS) || sanitizeShortText(interpretation.data);
  const hasPagarSignal = hasAnyTermInText(text, ['pagar', 'pagamento', 'pagou', 'pagaram']);
  const hasDeverSignal = hasAnyTermInText(text, ['dever', 'deve', 'devendo', 'devia', 'devedor']);
  const hasAtrasoSignal = hasAnyTermInText(text, ['atrasado', 'atrasada', 'atraso', 'inadimplente']);
  const options = [];

  const eventStockAmbiguity =
    Boolean(rc.possible_event_vs_stock) ||
    questionType === 'ambiguous_event_vs_stock' ||
    (hasTimeSignal && (hasPagarSignal || hasDeverSignal || hasAtrasoSignal));

  if (eventStockAmbiguity) {
    options.push(`parcelas que vencem em ${periodLabel} (evento)`);
    options.push('parcelas que ja estao vencidas/em aberto (estoque)');
  }

  if (hasDeverSignal) {
    options.push('saldo total em aberto (capital e juros pendentes)');
    options.push('quantidade/lista de parcelas em aberto');
  }

  if (hasAtrasoSignal) {
    options.push('parcelas vencidas sem quitacao');
    options.push('clientes inadimplentes (status de atraso do cliente)');
  }

  const normalizedPlanningClarification = buildClarificationQuestionFromPlanning(p);
  if (!options.length && sanitizeShortText(normalizedPlanningClarification)) {
    if (normalizeQuestionType(interpretation.tipo) === 'evento') {
      options.push(`eventos de vencimento em ${periodLabel}`);
      options.push('estoque atual de parcelas em atraso');
    } else if (normalizeQuestionType(interpretation.tipo) === 'estoque') {
      options.push('estoque atual de parcelas em aberto');
      options.push(`eventos de vencimento em ${periodLabel}`);
    }
  }

  if (!options.length) {
    options.push('consulta de eventos por data/periodo');
    options.push('consulta de estoque atual (parcelas em aberto/atrasadas)');
  }

  return uniqueOptionList(options).slice(0, 3);
}

function buildForcedAmbiguityQuestion(options) {
  const normalized = uniqueOptionList(options).slice(0, 3);
  if (normalized.length < 2) {
    return 'Pode esclarecer melhor o que voce quer consultar no sistema?';
  }
  const lines = ['Voce quer saber:'];
  for (let index = 0; index < normalized.length; index += 1) {
    lines.push(`${index + 1}) ${normalized[index]}`);
  }
  lines.push('Me diga o numero da opcao correta.');
  return lines.join('\n');
}

function decideExecutionPath({
  planning,
  interpretationSnapshot,
  requestClassification,
  userText,
  semanticProfile = null,
}) {
  const p = isPlainObject(planning) ? planning : {};
  const interpretation = isPlainObject(interpretationSnapshot) ? interpretationSnapshot : {};
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  const ambiguousByInterpretation =
    normalizeQuestionType(interpretation.tipo) === 'ambiguous_event_vs_stock' ||
    normalizeAmbiguityLevel(interpretation.ambiguidade) === 'alto';
  const ambiguousByClassification = sanitizeShortText(rc.category).toLowerCase() === 'ambigua';
  const mandatoryAmbiguity = Boolean(semantic.mandatory_ambiguity);
  const ambiguous =
    Boolean(p.needs_clarification) ||
    isAmbiguousEventVsStock(p) ||
    ambiguousByInterpretation ||
    ambiguousByClassification ||
    mandatoryAmbiguity;
  const lowConfidence = isLowConfidence(
    interpretation.confidence != null ? interpretation.confidence : p.confidence
  );
  const needsClarification = ambiguous || lowConfidence;
  const forcedAmbiguity = ambiguous || (lowConfidence && sanitizeShortText(rc.category) !== 'sem_contexto_suficiente');
  const inferredOptions = forcedAmbiguity
    ? inferAmbiguityOptions({
      userText,
      requestClassification: rc,
      planning: p,
      interpretationSnapshot: interpretation,
    })
    : [];
  const semanticOptions = Array.isArray(semantic.ambiguity_options)
    ? semantic.ambiguity_options
    : [];
  const ambiguityOptions = uniqueOptionList([...semanticOptions, ...inferredOptions]).slice(0, 4);
  const clarificationQuestion = needsClarification
    ? mandatoryAmbiguity && sanitizeShortText(semantic.ambiguity_question)
      ? sanitizeShortText(semantic.ambiguity_question)
      : forcedAmbiguity
        ? buildForcedAmbiguityQuestion(ambiguityOptions)
        : buildClarificationQuestionFromPlanning(p)
    : '';

  return {
    needs_clarification: needsClarification,
    forced_ambiguity: forcedAmbiguity,
    mandatory_ambiguity: mandatoryAmbiguity,
    ambiguity_options: ambiguityOptions,
    reason: needsClarification
      ? mandatoryAmbiguity
        ? 'mandatory_ambiguity'
        : forcedAmbiguity
          ? 'forced_ambiguity'
          : 'low_confidence'
      : 'ready',
    clarification_question: clarificationQuestion,
  };
}

function normalizeConversationContext(rawContext) {
  if (!Array.isArray(rawContext)) return [];
  const cleaned = [];

  for (const item of rawContext) {
    if (!item || typeof item !== 'object') continue;
    const role = String(item.role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const text = String(item.text || '').trim();
    if (!text) continue;

    const quality = String(item.quality || 'unknown').trim().toLowerCase();
    if (quality === 'rejected') continue;

    cleaned.push({
      role,
      text: text.slice(0, 1000),
      quality: quality === 'approved' ? 'approved' : 'unknown',
      turn_id: item.turn_id ? String(item.turn_id).trim() : null,
      mode: sanitizeShortText(item.mode, 'answer').toLowerCase(),
    });
  }

  if (cleaned.length <= MAX_CONTEXT_TURNS) return cleaned;
  return cleaned.slice(cleaned.length - MAX_CONTEXT_TURNS);
}

function classifyRequest({ userText, screenContext, conversationContext }) {
  const normalizedText = normalizeTextForAnalysis(userText);
  const tokens = tokenizeForAnalysis(userText);
  const normalizedConversation = normalizeConversationContext(conversationContext);
  const hasScreenEntityContext = hasSelectedEntityContext(screenContext);
  const hasConversationContext = normalizedConversation.length > 0;
  const hasReferenceContext = hasScreenEntityContext || hasConversationContext;

  const hasIndirectReference = hasAnyTermInText(normalizedText, INDIRECT_REFERENCE_TERMS);
  const hasComplexitySignal = hasAnyTermInText(normalizedText, COMPLEXITY_TERMS);
  const hasEventStockSignal = hasAnyTermInText(normalizedText, EVENT_STOCK_AMBIGUITY_TERMS);
  const hasPagarSignal = hasAnyTermInText(normalizedText, ['pagar', 'pagamento', 'pagou', 'pagaram']);
  const hasDeverSignal = hasAnyTermInText(normalizedText, ['dever', 'deve', 'devendo', 'devia', 'devedor']);
  const hasAtrasoSignal = hasAnyTermInText(normalizedText, ['atrasado', 'atrasada', 'atraso', 'inadimplente']);
  const hasTimeSignal = hasAnyTermInText(normalizedText, TIME_TERMS);
  const hasMultiIntentSignal = hasAnyTermInText(` ${normalizedText} `, MULTI_INTENT_TERMS);

  const longQuestion = tokens.length >= 18;
  const veryLongQuestion = tokens.length >= 28;
  const possibleEventVsStock = hasEventStockSignal && hasTimeSignal;

  let complexityScore = 0;
  if (hasComplexitySignal) complexityScore += 2;
  if (longQuestion) complexityScore += 1;
  if (veryLongQuestion) complexityScore += 1;
  if (hasMultiIntentSignal) complexityScore += 1;

  let ambiguityScore = 0;
  if (possibleEventVsStock) ambiguityScore += 2;
  if (hasDeverSignal) ambiguityScore += 1;
  if (hasAtrasoSignal) ambiguityScore += 1;
  if (hasPagarSignal && !hasTimeSignal) ambiguityScore += 1;
  if (hasMultiIntentSignal) ambiguityScore += 1;
  if (hasIndirectReference && !hasScreenEntityContext) ambiguityScore += 1;

  let category = 'simples';
  if (hasIndirectReference && !hasReferenceContext) {
    category = 'sem_contexto_suficiente';
  } else if (ambiguityScore >= 2) {
    category = 'ambigua';
  } else if (complexityScore >= 2) {
    category = 'complexa';
  }

  return {
    category,
    has_indirect_reference: hasIndirectReference,
    has_reference_context: hasReferenceContext,
    has_screen_entity_context: hasScreenEntityContext,
    has_conversation_context: hasConversationContext,
    has_pagar_signal: hasPagarSignal,
    has_dever_signal: hasDeverSignal,
    has_atraso_signal: hasAtrasoSignal,
    possible_event_vs_stock: possibleEventVsStock,
    complexity_score: complexityScore,
    ambiguity_score: ambiguityScore,
    token_count: tokens.length,
  };
}

function shouldUseAdvancedReasoning(requestClassification) {
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const category = sanitizeShortText(rc.category).toLowerCase();
  return category === 'ambigua' || category === 'complexa';
}

function buildClassificationClarificationQuestion(requestClassification) {
  const rc = isPlainObject(requestClassification) ? requestClassification : {};
  const category = sanitizeShortText(rc.category).toLowerCase();
  if (category === 'sem_contexto_suficiente') {
    return 'Preciso de mais contexto para interpretar com seguranca. Informe cliente, emprestimo ou parcela.';
  }
  if (rc.possible_event_vs_stock) {
    return 'Voce quer quem vencia na data informada (evento) ou quem ficou em aberto/atrasado (estoque)?';
  }
  return 'Pode detalhar melhor o pedido para eu consultar corretamente?';
}

async function interpretRequestSemantically({
  userText,
  screenContext,
  conversationContext,
  memoryContext = null,
  retryHint = null,
}) {
  const planningStartedAt = Date.now();
  const { modelPlanning } = getOpenAIConfig();
  const toolCatalog = getToolCatalog();

  const systemPrompt = buildPlanningSystemPrompt();

  const userPayload = {
    user_text: userText,
    screen_context: screenContext,
    conversation_context: normalizeConversationContext(conversationContext),
    memory_context: isPlainObject(memoryContext) ? memoryContext : null,
    semantic_taxonomy: {
      intents: Array.from(SEMANTIC_INTENTS),
      entities: Array.from(SEMANTIC_ENTITIES),
      aggregations: Array.from(SEMANTIC_AGGREGATIONS),
    },
    allowed_tools: toolCatalog,
    previous_attempt: retryHint && isPlainObject(retryHint) ? retryHint : null,
  };

  const planningCall = await callOpenAIChat({
    model: modelPlanning,
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  const planningRaw = safeJsonParse(planningCall.content);
  if (!planningRaw) {
    throw new Error('A IA nao retornou JSON valido na etapa de planejamento.');
  }
  return {
    planning: normalizePlanningOutput(planningRaw),
    usage: planningCall.usage,
    model: planningCall.model || modelPlanning,
    latency_ms: Date.now() - planningStartedAt,
  };
}

function summarizeToolResultForPrompt(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  const text = JSON.stringify(value);
  if (text.length <= 10000) return value;
  return { resumo_truncado: text.slice(0, 10000) };
}

const MONTHS_PT = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

function toValidDateParts(dayRaw, monthRaw, yearRaw) {
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return null;
  }
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const test = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(test.getTime())) return null;
  if (test.getUTCFullYear() !== year) return null;
  if (test.getUTCMonth() + 1 !== month) return null;
  if (test.getUTCDate() !== day) return null;
  return { day, month, year };
}

function formatDatePtExtenso(day, month, year) {
  const dayText = String(day).padStart(2, '0');
  const monthName = MONTHS_PT[month - 1] || '';
  if (!monthName) return `${dayText}/${String(month).padStart(2, '0')}/${year}`;
  return `${dayText} de ${monthName} de ${year}`;
}

function humanizeDatesInText(text) {
  const input = String(text || '');
  if (!input) return input;

  const withIso = input.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (full, y, m, d) => {
    const parts = toValidDateParts(d, m, y);
    if (!parts) return full;
    return formatDatePtExtenso(parts.day, parts.month, parts.year);
  });

  return withIso.replace(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g, (full, d, m, y) => {
    const parts = toValidDateParts(d, m, y);
    if (!parts) return full;
    return formatDatePtExtenso(parts.day, parts.month, parts.year);
  });
}

function formatCurrencyBRL(value) {
  const n = Number(value || 0);
  const safeNumber = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(safeNumber);
}

function humanizeDateValue(value) {
  const text = sanitizeShortText(value);
  if (!text) return '-';
  const iso = text.slice(0, 10);
  const isoParts = iso.split('-');
  if (isoParts.length === 3) {
    const parsed = toValidDateParts(isoParts[2], isoParts[1], isoParts[0]);
    if (parsed) return formatDatePtExtenso(parsed.day, parsed.month, parsed.year);
  }

  const br = text.slice(0, 10);
  const brParts = br.split('/');
  if (brParts.length === 3) {
    const parsed = toValidDateParts(brParts[0], brParts[1], brParts[2]);
    if (parsed) return formatDatePtExtenso(parsed.day, parsed.month, parsed.year);
  }
  return text;
}

function normalizeKnowledgeSourceDecision(rawDecision) {
  const raw = isPlainObject(rawDecision) ? rawDecision : {};
  const strategy = sanitizeShortText(raw.strategy, 'domain_only').toLowerCase();
  const safeStrategy = KNOWLEDGE_SOURCE_STRATEGIES.has(strategy)
    ? strategy
    : 'domain_only';
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : safeStrategy === 'domain_only'
      ? 0.7
      : 0.6;

  const normalizedBudget = isPlainObject(raw.repo_budget)
    ? {
        search_calls: Math.max(1, Math.min(4, Number(raw.repo_budget.search_calls || 0) || 2)),
        open_calls: Math.max(1, Math.min(6, Number(raw.repo_budget.open_calls || 0) || 3)),
        max_snippets: Math.max(1, Math.min(8, Number(raw.repo_budget.max_snippets || 0) || 3)),
        max_chars_total: Math.max(
          800,
          Math.min(12000, Number(raw.repo_budget.max_chars_total || 0) || 2800)
        ),
      }
    : {
        search_calls: safeStrategy === 'hybrid' ? 1 : 2,
        open_calls: safeStrategy === 'hybrid' ? 2 : 3,
        max_snippets: safeStrategy === 'hybrid' ? 2 : 3,
        max_chars_total: safeStrategy === 'hybrid' ? 1800 : 3200,
      };

  return {
    strategy: safeStrategy,
    reason: sanitizeShortText(raw.reason),
    confidence,
    repo_goal: sanitizeShortText(raw.repo_goal, safeStrategy === 'repo_only' ? 'origin_rule' : 'none'),
    should_use_repo_read: Boolean(raw.should_use_repo_read || safeStrategy !== 'domain_only'),
    repo_scope: sanitizeShortText(raw.repo_scope, 'project'),
    repo_budget: normalizedBudget,
  };
}

function chooseRepoScopeFromDecision(sourceDecision, semanticProfile = null, factualContext = null) {
  const normalized = normalizeKnowledgeSourceDecision(sourceDecision);
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  const factual = isPlainObject(factualContext) ? factualContext : {};
  const requestedScope = sanitizeShortText(normalized.repo_scope, 'project').toLowerCase();
  if (requestedScope === 'backend' || requestedScope === 'frontend' || requestedScope === 'project') {
    return requestedScope;
  }
  const toolName = sanitizeShortText(factual.tool_name).toLowerCase();
  if (toolName) {
    if (toolName === 'caixa_resumo' || toolName === 'parcelas_por_periodo' || toolName === 'emprestimo_detalhe') {
      return 'backend';
    }
  }
  const primaryEntity = sanitizeShortText(semantic.primary_entity).toLowerCase();
  if (primaryEntity === 'caixa' || primaryEntity === 'emprestimo' || primaryEntity === 'parcela') {
    return 'backend';
  }
  return 'project';
}

const SEARCH_STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'a',
  'o',
  'e',
  'ou',
  'que',
  'como',
  'qual',
  'quais',
  'quando',
  'onde',
  'para',
  'com',
  'sem',
  'por',
  'um',
  'uma',
  'os',
  'as',
  'no',
  'na',
  'nos',
  'nas',
  'isso',
  'essa',
  'esse',
  'sobre',
  'me',
  'eu',
  'voce',
  'voces',
]);

function buildRepoSearchQueries({ userText, semanticProfile = null, sourceDecision = null, factualContext = null }) {
  const normalized = normalizeTextForAnalysis(userText);
  const tokens = tokenizeForAnalysis(userText).filter(
    (token) => token.length >= 4 && !SEARCH_STOPWORDS.has(token)
  );
  const semantic = isPlainObject(semanticProfile) ? semanticProfile : {};
  const factual = isPlainObject(factualContext) ? factualContext : {};
  const source = normalizeKnowledgeSourceDecision(sourceDecision);

  const candidates = [];
  const pushCandidate = (value) => {
    const text = sanitizeShortText(value);
    if (!text) return;
    const normalizedText = normalizeTextForAnalysis(text);
    if (!normalizedText) return;
    if (candidates.some((item) => normalizeTextForAnalysis(item) === normalizedText)) return;
    candidates.push(text);
  };

  const quoted = Array.from(String(userText || '').matchAll(/"([^"]{3,})"/g)).map((m) => m[1]);
  for (const item of quoted) pushCandidate(item);
  if (tokens.length) {
    pushCandidate(tokens.slice(0, 3).join(' '));
    for (const token of tokens.slice(0, 6)) pushCandidate(token);
  }

  pushCandidate(semantic.primary_entity);
  pushCandidate(semantic.semantic_intent);
  pushCandidate(source.repo_goal);
  pushCandidate(factual.tool_name);
  pushCandidate(factual.intent);

  if (normalized.includes('atraso') || normalized.includes('atrasad')) {
    pushCandidate('recalculoAtrasoController');
    pushCandidate('valor_em_atraso');
    pushCandidate('vencidas');
  }
  if (normalized.includes('caixa') || normalized.includes('recebi') || normalized.includes('juros')) {
    pushCandidate('caixa_resumo');
    pushCandidate('caixaService');
  }
  if (normalized.includes('vencer') || normalized.includes('vencimento')) {
    pushCandidate('parcelas_por_periodo');
    pushCandidate('vencimento');
  }

  if (!candidates.length) {
    pushCandidate('orchestrator');
  }

  return candidates.slice(0, 8);
}

function dedupeRepoMatches(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const path = sanitizeShortText(item && item.path);
    const line = Number(item && item.line);
    if (!path || !Number.isFinite(line) || line < 1) continue;
    const key = `${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path,
      line,
      column: Number(item && item.column) > 0 ? Number(item.column) : 1,
      text: sanitizeShortText(item && item.text),
    });
  }
  return out;
}

function buildRepoEvidenceAnswerText({
  userText,
  sourceDecision,
  repoEvidence,
  repoScope,
  noMatches = false,
}) {
  const evidence = Array.isArray(repoEvidence) ? repoEvidence : [];
  const source = normalizeKnowledgeSourceDecision(sourceDecision);
  if (!evidence.length) {
    const fallback = noMatches
      ? 'Nao encontrei evidencias relevantes no repositório com os limites atuais de leitura.'
      : 'Nao consegui reunir evidencias de repositório suficientes.';
    if (source.strategy === 'hybrid') {
      return `Origem no sistema (read-only): ${fallback} Escopo consultado: ${repoScope}.`;
    }
    return `${fallback} Escopo consultado: ${repoScope}.`;
  }

  const header =
    source.strategy === 'hybrid'
      ? 'Origem no sistema (read-only):'
      : 'Evidencias no repositório (read-only):';
  const lines = [header];
  for (let index = 0; index < Math.min(3, evidence.length); index += 1) {
    const item = evidence[index] || {};
    const path = sanitizeShortText(item.path, 'arquivo_desconhecido');
    const startLine = Number(item.start_line);
    const lineRef = Number.isFinite(startLine) && startLine > 0 ? `:${startLine}` : '';
    const snippet = sanitizeShortText(item.snippet).replace(/\s+/g, ' ').slice(0, 180);
    const reason = sanitizeShortText(item.reason);
    lines.push(
      `${index + 1}) ${path}${lineRef} - ${snippet}${reason ? ` [${reason}]` : ''}`
    );
  }
  return lines.join('\n');
}

function mergeFactualAndRepoAnswer({ factualAnswer, repoExplanation }) {
  const factual = sanitizeShortText(factualAnswer);
  const repo = sanitizeShortText(repoExplanation);
  if (!factual && !repo) return 'Sem resposta disponivel.';
  if (!factual) return repo;
  if (!repo) return factual;
  return `${factual}\n\n${repo}`;
}

function buildSimpleNaturalAnswerFromTool({
  toolName,
  toolArgs,
  toolResult,
  intent = '',
  requestClassification = null,
}) {
  const result = isPlainObject(toolResult) ? toolResult : {};
  const args = isPlainObject(toolArgs) ? toolArgs : {};

  if (toolName === 'caixa_resumo') {
    const totalRecebido = formatCurrencyBRL(result.total_recebido);
    const totalCapital = formatCurrencyBRL(result.total_capital_recebido);
    const totalJuros = formatCurrencyBRL(result.total_juros_recebido);
    const saldo = formatCurrencyBRL(result.saldo);
    const de = humanizeDateValue(result.de || args.de);
    const ate = humanizeDateValue(result.ate || args.ate);
    if (String(de) === String(ate)) {
      return `No dia ${de}, entrou ${totalRecebido} (capital ${totalCapital} e juros ${totalJuros}). Saldo do periodo: ${saldo}.`;
    }
    return `No periodo de ${de} ate ${ate}, entrou ${totalRecebido} (capital ${totalCapital} e juros ${totalJuros}). Saldo do periodo: ${saldo}.`;
  }

  if (toolName === 'parcelas_por_periodo') {
    const total = Number(result.total || 0);
    const de = humanizeDateValue(result.de || args.de);
    const ate = humanizeDateValue(result.ate || args.ate);
    const tipo = sanitizeShortText(result.tipo || args.tipo, 'todas');
    const rc = isPlainObject(requestClassification) ? requestClassification : {};
    const deterministicRoute = isPlainObject(rc.deterministic_route)
      ? rc.deterministic_route
      : {};
    const multiIntent = isPlainObject(deterministicRoute.multi_intent)
      ? deterministicRoute.multi_intent
      : null;
    const isCompositeVencimentoQuery =
      sanitizeShortText(intent).toLowerCase() === 'evento_parcelas_multi_intent' ||
      Boolean(multiIntent && (multiIntent.count || multiIntent.list || multiIntent.sum));
    const isForecastReceivableQuery =
      sanitizeShortText(intent).toLowerCase() === 'previsao_recebimento_parcelas' ||
      sanitizeShortText(deterministicRoute.reason).toLowerCase() ===
        'deterministic_forecast_receivable_summary';

    if (total <= 0) {
      if (isForecastReceivableQuery) {
        return `No periodo de ${de} ate ${ate}, projeção de recebimento: ${formatCurrencyBRL(0)}. Parcelas previstas: 0. Clientes unicos: 0.`;
      }
      if (isCompositeVencimentoQuery) {
        return `No periodo de ${de} ate ${ate}, nao encontrei clientes com parcelas vencendo.`;
      }
      return `Nao encontrei parcelas (${tipo}) entre ${de} e ${ate}.`;
    }

    const parcelas = Array.isArray(result.parcelas) ? result.parcelas : [];
    if (isForecastReceivableQuery) {
      const uniqueClients = new Map();
      let somaValorTotal = 0;
      for (const parcela of parcelas) {
        const clienteId = Number(parcela && parcela.cliente_id ? parcela.cliente_id : 0);
        const clienteNome = sanitizeShortText(parcela && parcela.cliente_nome, 'Cliente sem nome');
        const key = clienteId > 0 ? `id:${clienteId}` : `nome:${normalizeTextForAnalysis(clienteNome)}`;
        if (!uniqueClients.has(key)) uniqueClients.set(key, clienteNome);
        const valorTotal = Number(parcela && parcela.valor_total);
        if (Number.isFinite(valorTotal)) somaValorTotal += valorTotal;
      }
      const totalClientes = uniqueClients.size;
      const somaTexto = formatCurrencyBRL(somaValorTotal);
      return `No periodo de ${de} ate ${ate}, se todos pagarem certinho, voce deve receber ${somaTexto}. Parcelas previstas: ${total}. Clientes unicos: ${totalClientes}.`;
    }

    if (isCompositeVencimentoQuery) {
      const uniqueClients = new Map();
      let somaValorTotal = 0;

      for (const parcela of parcelas) {
        const clienteId = Number(parcela && parcela.cliente_id ? parcela.cliente_id : 0);
        const clienteNome = sanitizeShortText(parcela && parcela.cliente_nome, 'Cliente sem nome');
        const key = clienteId > 0 ? `id:${clienteId}` : `nome:${normalizeTextForAnalysis(clienteNome)}`;
        if (!uniqueClients.has(key)) {
          uniqueClients.set(key, clienteNome);
        }
        const valorTotal = Number(parcela && parcela.valor_total);
        if (Number.isFinite(valorTotal)) somaValorTotal += valorTotal;
      }

      const totalClientes = uniqueClients.size;
      const nomesClientes = Array.from(uniqueClients.values());
      const nomesTexto = nomesClientes.length
        ? nomesClientes.join('; ')
        : '-';
      const somaTexto = formatCurrencyBRL(somaValorTotal);

      if (String(de) === String(ate)) {
        return `No dia ${de}, encontrei ${totalClientes} cliente(s) com parcelas vencendo. Clientes: ${nomesTexto}. Soma prevista (valor_total): ${somaTexto}.`;
      }
      return `No periodo de ${de} ate ${ate}, encontrei ${totalClientes} cliente(s) com parcelas vencendo. Clientes: ${nomesTexto}. Soma prevista (valor_total): ${somaTexto}.`;
    }

    const preview = parcelas
      .slice(0, 3)
      .map((parcela) => {
        const cliente = sanitizeShortText(parcela && parcela.cliente_nome, 'Cliente');
        const numero = parcela && parcela.numero != null ? Number(parcela.numero) : null;
        const venc = humanizeDateValue(parcela && parcela.vencimento);
        const valor = formatCurrencyBRL(parcela && parcela.total_devido_calculado);
        return `${cliente} (parcela ${numero != null ? numero : '-'}, vence ${venc}, ${valor})`;
      })
      .join('; ');

    return `Encontrei ${total} parcela(s) (${tipo}) entre ${de} e ${ate}. ${preview ? `Exemplos: ${preview}.` : ''}`.trim();
  }

  if (toolName === 'emprestimo_detalhe') {
    const id = result.id != null ? Number(result.id) : null;
    const cliente = sanitizeShortText(result.cliente_nome, 'cliente nao identificado');
    const abertas = Number(result.parcelas_em_aberto || 0);
    const capitalRestante = formatCurrencyBRL(result.capital_restante);
    const totalPago = formatCurrencyBRL(result.total_pago);
    return `Emprestimo #${id != null ? id : '-'} (${cliente}): ${abertas} parcela(s) em aberto, capital restante ${capitalRestante} e total pago ${totalPago}.`;
  }

  if (toolName === 'notificacoes_pendentes') {
    const total = Number(result.total || 0);
    if (total <= 0) {
      return 'Nao ha notificacoes pendentes no momento.';
    }
    const itens = Array.isArray(result.notificacoes) ? result.notificacoes : [];
    const preview = itens
      .slice(0, 3)
      .map((item) => {
        const cliente = sanitizeShortText(item && item.cliente_nome, 'Cliente');
        const tipo = sanitizeShortText(item && item.tipo, 'alerta');
        const venc = humanizeDateValue(item && item.parcela_vencimento);
        return `${cliente} (${tipo}${venc !== '-' ? `, vencimento ${venc}` : ''})`;
      })
      .join('; ');
    return `Existem ${total} notificacao(oes) pendentes. ${preview ? `Exemplos: ${preview}.` : ''}`.trim();
  }

  if (toolName === 'cliente_busca') {
    const total = Number(result.total || 0);
    const clientes = Array.isArray(result.clientes) ? result.clientes : [];
    if (total <= 0) {
      return 'Nao encontrei cliente com os criterios informados.';
    }
    if (total === 1 && clientes.length) {
      const unico = clientes[0] || {};
      return `Encontrei 1 cliente: #${unico.id || '-'} ${sanitizeShortText(unico.nome, 'Sem nome')}.`;
    }
    const nomes = clientes
      .slice(0, 5)
      .map((c) => `#${c && c.id != null ? c.id : '-'} ${sanitizeShortText(c && c.nome, 'Sem nome')}`)
      .join('; ');
    return `Encontrei ${total} clientes. Primeiros resultados: ${nomes}.`;
  }

  return 'Consulta concluida com sucesso.';
}

function isResultEmpty(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!isPlainObject(value)) return false;

  const totalRaw = Number(value.total);
  if (Number.isFinite(totalRaw)) return totalRaw <= 0;

  return Object.keys(value).length === 0;
}

function isToolResultLikelyEmpty(toolName, toolResult) {
  const name = String(toolName || '').trim();
  if (name === 'caixa_resumo') return false;
  if (name === 'emprestimo_detalhe') return false;
  return isResultEmpty(toolResult);
}

function mergeUsageObjects(baseUsage, nextUsage) {
  const base = isPlainObject(baseUsage) ? baseUsage : {};
  const next = isPlainObject(nextUsage) ? nextUsage : {};
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  const merged = {};

  for (const key of keys) {
    const a = base[key];
    const b = next[key];
    const aNum = Number(a);
    const bNum = Number(b);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      merged[key] = aNum + bNum;
      continue;
    }
    if (Number.isFinite(bNum)) {
      merged[key] = bNum;
      continue;
    }
    if (Number.isFinite(aNum)) {
      merged[key] = aNum;
      continue;
    }
    merged[key] = b != null ? b : a;
  }

  return merged;
}

function mergePlanningUsageTrace(baseTrace, extraTrace) {
  if (!baseTrace) return extraTrace || null;
  if (!extraTrace) return baseTrace;

  return {
    model: baseTrace.model || extraTrace.model || null,
    usage: mergeUsageObjects(baseTrace.usage, extraTrace.usage),
  };
}

function sumToolLatencyMs(toolTrace = []) {
  if (!Array.isArray(toolTrace) || !toolTrace.length) return 0;
  return toolTrace.reduce((sum, item) => {
    const n = Number(item && item.latency_ms);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

function mergeTelemetry(baseTelemetry, extraTelemetry) {
  const base = isPlainObject(baseTelemetry) ? baseTelemetry : {};
  const extra = isPlainObject(extraTelemetry) ? extraTelemetry : {};
  return {
    ...base,
    ...extra,
  };
}

function attachTelemetry(result, extraTelemetry) {
  const payload = isPlainObject(result) ? { ...result } : {};
  payload.telemetry = mergeTelemetry(payload.telemetry, extraTelemetry);
  return payload;
}

function buildCriticalRulesApplied(toolName) {
  const tool = sanitizeShortText(toolName);
  const baseRules = [
    'diferenciar evento_vs_estoque',
    'diferenciar_vencimento_vs_data_pagamento',
  ];
  if (tool === 'parcelas_por_periodo') {
    return [
      ...baseRules,
      'filtrar_versao_ativa_do_emprestimo',
      'ignorar_parcela_numero_menos_um',
      'diferenciar_valor_total_vs_total_devido_calculado',
    ];
  }
  if (tool === 'caixa_resumo') {
    return [
      ...baseRules,
      'diferenciar_caixa_movimentos_vs_pagamentos',
    ];
  }
  if (tool === 'notificacoes_pendentes') {
    return [
      ...baseRules,
      'notificacoes_nao_sao_universo_completo_de_parcelas',
    ];
  }
  if (tool === 'emprestimo_detalhe') {
    return [
      ...baseRules,
      'total_pago_reflete_soma_de_pagamentos',
    ];
  }
  return baseRules;
}

async function composeNaturalAnswer({
  userText,
  intent,
  toolName,
  toolArgs,
  toolResult,
  resolvedContext,
  conversationContext,
  semanticProfile = null,
}) {
  const { modelAnswer } = getOpenAIConfig();
  const summarizedResult = summarizeToolResultForPrompt(toolResult);
  const safeConversation = normalizeConversationContext(conversationContext);

  const systemPrompt = buildAnswerSystemPrompt();

  const userPayload = {
    pergunta_original: userText,
    intent,
    semantic_profile: isPlainObject(semanticProfile) ? semanticProfile : null,
    tool: toolName,
    tool_args: toolArgs,
    resolved_context: resolvedContext,
    conversation_context: safeConversation,
    critical_rules_applied: buildCriticalRulesApplied(toolName),
    tool_result: summarizedResult,
  };

  const answerCall = await callOpenAIChat({
    model: modelAnswer,
    temperature: 0.28,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  const text = String(answerCall.content || '').trim();
  if (!text) {
    throw new Error('A IA retornou resposta natural vazia.');
  }
  return {
    text,
    usage: answerCall.usage,
    model: answerCall.model || modelAnswer,
  };
}

async function executeAndComposeAnswer({
  questionForAnswer,
  intent,
  validation,
  resolvedContext,
  screenContext,
  sessionId,
  turnId,
  planningUsageTrace,
  confidence,
  conversationContext,
  reasoningMode = 'advanced',
  requestClassification = null,
  planningLatencyMs = null,
  semanticProfile = null,
}) {
  const flowStartedAt = Date.now();
  let selectedValidation = validation;
  let selectedResolvedContext = resolvedContext || {};
  let selectedIntent = intent || null;
  let selectedConfidence = confidence;
  let selectedPlanningUsageTrace = planningUsageTrace || null;
  let retryPlanningLatencyMs = 0;

  const toolTrace = [];

  const firstToolStartedAt = Date.now();
  let selectedToolResult = await executeReadOnlyTool(
    selectedValidation.tool_name,
    selectedValidation.normalized_args
  );
  toolTrace.push({
    tool: selectedValidation.tool_name,
    input: selectedValidation.normalized_args,
    latency_ms: Date.now() - firstToolStartedAt,
  });

  if (isToolResultLikelyEmpty(selectedValidation.tool_name, selectedToolResult)) {
    try {
      const retryPlanning = await interpretRequestSemantically({
        userText: questionForAnswer,
        screenContext: sanitizeScreenContext(screenContext),
        conversationContext,
        retryHint: {
          previous_tool: selectedValidation.tool_name,
          previous_tool_args: selectedValidation.normalized_args,
          previous_result_status: 'empty',
        },
      });

      selectedPlanningUsageTrace = mergePlanningUsageTrace(selectedPlanningUsageTrace, {
        model: retryPlanning.model || null,
        usage: retryPlanning.usage || null,
      });
      retryPlanningLatencyMs += Number(retryPlanning.latency_ms || 0);

      const retryPlan = retryPlanning.planning;
      const retryToolName = String(retryPlan && retryPlan.tool_name ? retryPlan.tool_name : '').trim();
      const canRetryWithAlternativeTool =
        retryToolName &&
        retryToolName !== selectedValidation.tool_name &&
        !retryPlan.needs_clarification &&
        !retryPlan.out_of_scope;

      if (canRetryWithAlternativeTool) {
        const retryResolved = resolveToolCallWithContext({
          toolName: retryToolName,
          toolArgs: retryPlan.tool_args,
          entities: retryPlan.entities,
          screenContext: sanitizeScreenContext(screenContext),
        });

        if (!retryResolved.needs_clarification) {
          const retryValidation = validateToolCall(retryToolName, retryResolved.resolved_args || {});
          if (retryValidation.ok) {
            const retryToolStartedAt = Date.now();
            const retryResult = await executeReadOnlyTool(
              retryValidation.tool_name,
              retryValidation.normalized_args
            );

            toolTrace.push({
              tool: retryValidation.tool_name,
              input: retryValidation.normalized_args,
              latency_ms: Date.now() - retryToolStartedAt,
              via_retry: true,
            });

            selectedValidation = retryValidation;
            selectedResolvedContext = retryResolved.resolved_context || {};
            selectedIntent = retryPlan.intent || selectedIntent;
            selectedConfidence = retryPlan.confidence;
            selectedToolResult = retryResult;
          }
        }
      }
    } catch (retryErr) {
      console.error('[assistente/retry-planning] erro:', retryErr);
    }
  }

  let naturalAnswer = '';
  let answerUsageTrace = null;
  let answerGenerationMs = 0;
  try {
    const answerStartedAt = Date.now();
    const naturalAnswerResult = await composeNaturalAnswer({
      userText: questionForAnswer,
      intent: selectedIntent,
      toolName: selectedValidation.tool_name,
      toolArgs: selectedValidation.normalized_args,
      toolResult: selectedToolResult,
      resolvedContext: selectedResolvedContext,
      conversationContext,
      semanticProfile,
    });
    answerGenerationMs = Date.now() - answerStartedAt;
    naturalAnswer = humanizeDatesInText(naturalAnswerResult.text);
    answerUsageTrace = {
      model: naturalAnswerResult.model || null,
      usage: naturalAnswerResult.usage || null,
    };
  } catch (err) {
    naturalAnswer =
      'Consegui consultar os dados reais, mas tive falha ao redigir a resposta natural. Tente novamente.';
    console.error('[assistente/composeNaturalAnswer] erro:', err);
  }

  return {
    mode: 'answer',
    reasoning_mode: reasoningMode,
    request_classification: requestClassification || null,
    answer_text: naturalAnswer,
    tool_trace: toolTrace,
    resolved_context: selectedResolvedContext,
    intent: selectedIntent,
    confidence: selectedConfidence,
    session_id: sessionId || null,
    turn_id: turnId || null,
    tool_result: selectedToolResult,
    usage_trace: {
      planning: {
        ...(selectedPlanningUsageTrace || {}),
        metadata: {
          reasoning_mode: reasoningMode,
          request_classification: requestClassification || null,
        },
      },
      answer: answerUsageTrace
        ? {
            ...answerUsageTrace,
            metadata: {
              reasoning_mode: reasoningMode,
            },
          }
        : null,
    },
    telemetry: {
      flow: reasoningMode,
      planning_ms: Number.isFinite(Number(planningLatencyMs)) ? Number(planningLatencyMs) : null,
      retry_planning_ms: retryPlanningLatencyMs > 0 ? retryPlanningLatencyMs : 0,
      tool_execution_ms: sumToolLatencyMs(toolTrace),
      response_generation_ms: answerGenerationMs > 0 ? answerGenerationMs : 0,
      orchestration_ms: Date.now() - flowStartedAt,
    },
    follow_up: null,
  };
}

async function executeSimpleFlow({
  validation,
  resolvedContext,
  sessionId,
  turnId,
  intent,
  confidence,
  planningUsageTrace,
  requestClassification,
  planningLatencyMs = null,
}) {
  const flowStartedAt = Date.now();
  const startedAt = Date.now();
  const toolResult = await executeReadOnlyTool(validation.tool_name, validation.normalized_args);
  const toolTrace = [
    {
      tool: validation.tool_name,
      input: validation.normalized_args,
      latency_ms: Date.now() - startedAt,
    },
  ];

  const answerStartedAt = Date.now();
  const localAnswer = buildSimpleNaturalAnswerFromTool({
    toolName: validation.tool_name,
    toolArgs: validation.normalized_args,
    toolResult,
    intent,
    requestClassification,
  });
  const answerGenerationMs = Date.now() - answerStartedAt;

  return {
    mode: 'answer',
    reasoning_mode: 'simple',
    request_classification: requestClassification || null,
    answer_text: humanizeDatesInText(localAnswer),
    tool_trace: toolTrace,
    resolved_context: resolvedContext || {},
    intent: intent || null,
    confidence,
    session_id: sessionId || null,
    turn_id: turnId || null,
    tool_result: toolResult,
    usage_trace: {
      planning: {
        ...(planningUsageTrace || {}),
        metadata: {
          reasoning_mode: 'simple',
          request_classification: requestClassification || null,
        },
      },
      answer: {
        model: null,
        usage: null,
        metadata: {
          reasoning_mode: 'simple',
          generation: 'local_backend',
        },
      },
    },
    telemetry: {
      flow: 'simple',
      planning_ms: Number.isFinite(Number(planningLatencyMs)) ? Number(planningLatencyMs) : null,
      retry_planning_ms: 0,
      tool_execution_ms: sumToolLatencyMs(toolTrace),
      response_generation_ms: answerGenerationMs,
      orchestration_ms: Date.now() - flowStartedAt,
    },
    follow_up: null,
  };
}

async function executeAdvancedFlow(params) {
  return executeAndComposeAnswer({
    ...params,
    reasoningMode: 'advanced',
  });
}

async function executeRepoReadFlow({
  questionForAnswer,
  sessionId,
  turnId,
  planningUsageTrace = null,
  requestClassification = null,
  planningLatencyMs = null,
  sourceDecision = null,
  semanticProfile = null,
  factualContext = null,
  reasoningMode = 'repo_read',
}) {
  const flowStartedAt = Date.now();
  const source = normalizeKnowledgeSourceDecision(sourceDecision);
  const repoScope = chooseRepoScopeFromDecision(source, semanticProfile, factualContext);
  const budget = source.repo_budget || {
    search_calls: 2,
    open_calls: 3,
    max_snippets: 3,
    max_chars_total: 3200,
  };
  const searchQueries = buildRepoSearchQueries({
    userText: questionForAnswer,
    semanticProfile,
    sourceDecision: source,
    factualContext,
  });
  const repoTrace = [];
  const collectedMatches = [];

  let searchCalls = 0;
  for (const query of searchQueries) {
    if (searchCalls >= budget.search_calls) break;
    const startedAt = Date.now();
    const searchResult = await executeRepoReadTool('repo_search', {
      scope: repoScope,
      query,
      is_regex: false,
      case_sensitive: false,
      max_matches: Math.max(20, Math.min(100, budget.max_snippets * 20)),
    });
    const latencyMs = Date.now() - startedAt;
    repoTrace.push({
      tool: 'repo_search',
      input: {
        scope: repoScope,
        query,
      },
      latency_ms: latencyMs,
      result_count: Number(searchResult && searchResult.total_matches) || 0,
    });
    searchCalls += 1;
    if (Array.isArray(searchResult && searchResult.matches)) {
      collectedMatches.push(...searchResult.matches);
    }
    if (collectedMatches.length >= budget.max_snippets * 5) break;
  }

  const dedupedMatches = dedupeRepoMatches(collectedMatches);
  let repoEvidence = [];
  let hadNoMatches = false;

  if (dedupedMatches.length) {
    const hits = dedupedMatches
      .slice(0, Math.max(2, Math.min(20, budget.open_calls * 3)))
      .map((item) => ({
        path: item.path,
        line: item.line,
      }));
    const startedAt = Date.now();
    const snippetsResult = await executeRepoReadTool('repo_snippets', {
      scope: repoScope,
      hits,
      context_before: 2,
      context_after: 3,
      max_snippets: budget.max_snippets,
      max_chars_total: budget.max_chars_total,
    });
    const latencyMs = Date.now() - startedAt;
    repoTrace.push({
      tool: 'repo_snippets',
      input: {
        scope: repoScope,
        hits: hits.length,
      },
      latency_ms: latencyMs,
      result_count: Number(snippetsResult && snippetsResult.total_snippets) || 0,
      truncated: Boolean(snippetsResult && snippetsResult.truncated),
    });
    repoEvidence = Array.isArray(snippetsResult && snippetsResult.snippets)
      ? snippetsResult.snippets
      : [];
  } else {
    hadNoMatches = true;
    const startedAt = Date.now();
    const listResult = await executeRepoReadTool('repo_list', {
      scope: repoScope,
      max_depth: 2,
      max_entries: 30,
    });
    const latencyMs = Date.now() - startedAt;
    repoTrace.push({
      tool: 'repo_list',
      input: {
        scope: repoScope,
      },
      latency_ms: latencyMs,
      result_count: Number(listResult && listResult.total_found) || 0,
      truncated: Boolean(listResult && listResult.truncated),
    });
  }

  const answerText = buildRepoEvidenceAnswerText({
    userText: questionForAnswer,
    sourceDecision: source,
    repoEvidence,
    repoScope,
    noMatches: hadNoMatches,
  });

  return {
    mode: 'answer',
    reasoning_mode: reasoningMode,
    request_classification: requestClassification || null,
    answer_text: answerText,
    tool_trace: repoTrace,
    repo_trace: repoTrace,
    repo_evidence: repoEvidence,
    resolved_context: {
      repo_scope: repoScope,
    },
    intent: sanitizeShortText(source.repo_goal) || null,
    confidence: source.confidence,
    session_id: sessionId || null,
    turn_id: turnId || null,
    usage_trace: {
      planning: planningUsageTrace
        ? {
            ...planningUsageTrace,
            metadata: {
              reasoning_mode: reasoningMode,
              request_classification: requestClassification || null,
            },
          }
        : {
            model: null,
            usage: null,
            metadata: {
              reasoning_mode: reasoningMode,
              request_classification: requestClassification || null,
            },
          },
      answer: {
        model: null,
        usage: null,
        metadata: {
          reasoning_mode: reasoningMode,
          generation: 'local_repo_read',
        },
      },
    },
    telemetry: {
      flow: reasoningMode,
      planning_ms: Number.isFinite(Number(planningLatencyMs)) ? Number(planningLatencyMs) : null,
      retry_planning_ms: 0,
      tool_execution_ms: sumToolLatencyMs(repoTrace),
      response_generation_ms: 0,
      orchestration_ms: Date.now() - flowStartedAt,
      repo_queries: searchCalls,
    },
    follow_up: null,
  };
}

async function executeHybridFlow({
  questionForAnswer,
  reasoningMode,
  domainExecution,
  sourceDecision,
  semanticProfile = null,
  requestClassification = null,
  planningUsageTrace = null,
  planningLatencyMs = null,
}) {
  const flowStartedAt = Date.now();
  const domain = isPlainObject(domainExecution) ? domainExecution : {};
  const factualResult = reasoningMode === 'simple'
    ? await executeSimpleFlow({
        validation: domain.validation,
        resolvedContext: domain.resolvedContext,
        sessionId: domain.sessionId,
        turnId: domain.turnId,
        intent: domain.intent,
        confidence: domain.confidence,
        planningUsageTrace,
        requestClassification,
        planningLatencyMs,
      })
    : await executeAdvancedFlow({
        questionForAnswer,
        intent: domain.intent,
        validation: domain.validation,
        resolvedContext: domain.resolvedContext,
        screenContext: domain.screenContext,
        sessionId: domain.sessionId,
        turnId: domain.turnId,
        planningUsageTrace,
        confidence: domain.confidence,
        conversationContext: domain.conversationContext,
        requestClassification,
        planningLatencyMs,
        semanticProfile,
      });

  const hybridSource = normalizeKnowledgeSourceDecision({
    ...(isPlainObject(sourceDecision) ? sourceDecision : {}),
    strategy: 'hybrid',
    should_use_repo_read: true,
  });

  const repoResult = await executeRepoReadFlow({
    questionForAnswer,
    sessionId: domain.sessionId,
    turnId: domain.turnId,
    planningUsageTrace,
    requestClassification,
    planningLatencyMs,
    sourceDecision: hybridSource,
    semanticProfile,
    factualContext: {
      tool_name: domain.validation && domain.validation.tool_name,
      intent: domain.intent,
    },
    reasoningMode: 'hybrid_repo_read',
  });

  return {
    ...factualResult,
    answer_text: mergeFactualAndRepoAnswer({
      factualAnswer: factualResult.answer_text,
      repoExplanation: repoResult.answer_text,
    }),
    tool_trace: [
      ...(Array.isArray(factualResult.tool_trace) ? factualResult.tool_trace : []),
      ...(Array.isArray(repoResult.tool_trace) ? repoResult.tool_trace : []),
    ],
    repo_trace: Array.isArray(repoResult.repo_trace) ? repoResult.repo_trace : [],
    repo_evidence: Array.isArray(repoResult.repo_evidence) ? repoResult.repo_evidence : [],
    telemetry: mergeTelemetry(factualResult.telemetry, {
      flow: 'hybrid',
      repo_read_ms:
        Number(repoResult && repoResult.telemetry && repoResult.telemetry.orchestration_ms) || 0,
      orchestration_ms: Date.now() - flowStartedAt,
    }),
  };
}

async function executePendingClarificationCandidateFlow({
  candidate,
  sessionId,
  turnId,
}) {
  const selected = isPlainObject(candidate) ? candidate : {};
  const toolName = sanitizeShortText(selected.tool_name);
  const toolArgs = isPlainObject(selected.tool_args) ? selected.tool_args : {};
  const resolvedContext = isPlainObject(selected.resolved_context) ? selected.resolved_context : {};
  const intent = sanitizeShortText(selected.intent, null);

  if (!toolName) {
    return clarificationResponse({
      answerText:
        'Recebi sua opcao, mas nao consegui montar a consulta automaticamente. Reformule a pergunta com mais detalhes.',
      intent,
      resolvedContext,
      sessionId,
      turnId,
      confidence: 0.6,
      planningUsageTrace: null,
      mode: 'clarification',
      reasoningMode: 'clarification_resolved',
      requestClassification: { category: 'clarification_selection' },
      planningLatencyMs: 0,
    });
  }

  const validation = validateToolCall(toolName, toolArgs);
  if (!validation.ok) {
    const msg = validation.errors && validation.errors.length
      ? validation.errors[0]
      : 'Opcao selecionada, mas faltou detalhe para concluir a consulta.';
    return clarificationResponse({
      answerText: msg,
      intent,
      resolvedContext,
      sessionId,
      turnId,
      confidence: 0.6,
      planningUsageTrace: null,
      mode: 'clarification',
      reasoningMode: 'clarification_resolved',
      requestClassification: { category: 'clarification_selection' },
      planningLatencyMs: 0,
    });
  }

  const answer = await executeSimpleFlow({
    validation,
    resolvedContext,
    sessionId,
    turnId,
    intent,
    confidence: 0.99,
    planningUsageTrace: null,
    requestClassification: { category: 'clarification_selection' },
    planningLatencyMs: 0,
  });
  return {
    ...answer,
    reasoning_mode: 'clarification_resolved',
    request_classification: {
      category: 'clarification_selection',
      via_pending: true,
    },
    telemetry: mergeTelemetry(answer.telemetry, {
      flow: 'clarification_resolved',
      planning_ms: 0,
      decision_ms: 0,
    }),
  };
}

function clarificationResponse({
  answerText,
  intent,
  resolvedContext,
  sessionId,
  turnId,
  confidence,
  planningUsageTrace,
  mode = 'clarification',
  followUp = null,
  reasoningMode = 'advanced',
  requestClassification = null,
  planningLatencyMs = null,
  telemetry = null,
}) {
  return {
    mode,
    reasoning_mode: reasoningMode,
    request_classification: requestClassification || null,
    answer_text: answerText,
    tool_trace: [],
    resolved_context: resolvedContext || {},
    intent: intent || null,
    session_id: sessionId || null,
    turn_id: turnId || null,
    confidence,
    usage_trace: {
      planning: planningUsageTrace
        ? {
            ...planningUsageTrace,
            metadata: {
              reasoning_mode: reasoningMode,
              request_classification: requestClassification || null,
            },
          }
        : {
            model: null,
            usage: null,
            metadata: {
              reasoning_mode: reasoningMode,
              request_classification: requestClassification || null,
            },
          },
      answer: null,
    },
    telemetry: mergeTelemetry({
      flow: reasoningMode,
      planning_ms: Number.isFinite(Number(planningLatencyMs)) ? Number(planningLatencyMs) : null,
      retry_planning_ms: 0,
      tool_execution_ms: 0,
      response_generation_ms: 0,
      orchestration_ms: 0,
    }, telemetry),
    follow_up: followUp || null,
  };
}

async function runAssistantQuery({
  userText,
  screenContext,
  conversationContext,
  sessionId,
  turnId,
}) {
  const runStartedAt = Date.now();
  const question = String(userText || '').trim();
  if (!question) {
    throw new Error('Pergunta vazia.');
  }

  maybeResetSessionContext(sessionId, question);

  const memorySnapshot = getSessionMemorySnapshot(sessionId);
  const safeScreenContext = applyActiveContextToScreenContext(
    sanitizeScreenContext(screenContext),
    memorySnapshot && memorySnapshot.active_context ? memorySnapshot.active_context : {}
  );
  const safeConversationContext = normalizeConversationContext(conversationContext);
  const memoryConversationContext = getSessionConversationContext(sessionId);
  const mergedConversationContext = mergeConversationContexts(
    safeConversationContext,
    memoryConversationContext
  );
  const memoryContext = {
    active_context: memorySnapshot && memorySnapshot.active_context
      ? memorySnapshot.active_context
      : {},
    recent_turns: memorySnapshot && Array.isArray(memorySnapshot.recent_turns)
      ? memorySnapshot.recent_turns.slice(-MAX_MEMORY_TURNS_HINT)
      : [],
  };

  let classificationMs = 0;
  const finalizeResponse = (result, extraTelemetry = {}, memoryMeta = {}) => {
    const payload = attachTelemetry(result, {
      classification_ms: classificationMs,
      run_total_ms: Date.now() - runStartedAt,
      ...extraTelemetry,
    });

    try {
      const firstToolTrace = Array.isArray(payload.tool_trace) && payload.tool_trace.length
        ? payload.tool_trace[0]
        : null;
      recordConversationTurn({
        sessionId,
        turnId,
        userText: question,
        answerText: payload.answer_text,
        mode: payload.mode || 'answer',
        intent: memoryMeta.intent != null ? memoryMeta.intent : payload.intent,
        questionType: memoryMeta.questionType || '',
        entities: memoryMeta.entities || {},
        resolvedContext:
          memoryMeta.resolvedContext != null ? memoryMeta.resolvedContext : payload.resolved_context,
        toolName:
          memoryMeta.toolName != null
            ? memoryMeta.toolName
            : firstToolTrace && firstToolTrace.tool
              ? firstToolTrace.tool
              : '',
        toolArgs:
          memoryMeta.toolArgs != null
            ? memoryMeta.toolArgs
            : firstToolTrace && isPlainObject(firstToolTrace.input)
              ? firstToolTrace.input
              : {},
      });
    } catch (memoryErr) {
      console.error('[assistente/memory] erro ao registrar turno:', memoryErr);
    }

    return payload;
  };

  const pendingResolution = resolvePendingClarificationSelection({
    sessionId,
    userText: question,
  });
  if (pendingResolution.status === 'resolved') {
    const selectedResult = await executePendingClarificationCandidateFlow({
      candidate: pendingResolution.candidate,
      sessionId,
      turnId,
    });
    return finalizeResponse(selectedResult, {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: selectedResult.intent || (pendingResolution.pending && pendingResolution.pending.original_intent),
      questionType: 'clarification_selection',
      entities: {},
      resolvedContext: selectedResult.resolved_context || {},
      toolName: pendingResolution.candidate && pendingResolution.candidate.tool_name,
      toolArgs: pendingResolution.candidate && pendingResolution.candidate.tool_args,
    });
  }

  if (pendingResolution.status === 'pending') {
    const shortReply = tokenizeForAnalysis(question).length <= 5 && question.length <= 24;
    if (shortReply) {
      return finalizeResponse(clarificationResponse({
        answerText: buildPendingClarificationReminder(pendingResolution.pending),
        intent: pendingResolution.pending && pendingResolution.pending.original_intent
          ? pendingResolution.pending.original_intent
          : null,
        resolvedContext: {},
        sessionId,
        turnId,
        confidence: 0.3,
        planningUsageTrace: null,
        mode: 'forced_ambiguity',
        reasoningMode: 'advanced',
        requestClassification: { category: 'clarification_pending' },
        followUp: {
          type: 'ambiguity_options',
          options: pendingResolution.pending && pendingResolution.pending.options
            ? pendingResolution.pending.options
            : [],
        },
        planningLatencyMs: 0,
      }), {
        decision_ms: 0,
        orchestration_ms: Date.now() - runStartedAt,
      }, {
        intent: pendingResolution.pending && pendingResolution.pending.original_intent
          ? pendingResolution.pending.original_intent
          : null,
        questionType: 'clarification_pending',
      });
    }
    clearPendingClarification(sessionId);
  }

  const classificationStartedAt = Date.now();
  const requestClassification = classifyRequest({
    userText: question,
    screenContext: safeScreenContext,
    conversationContext: mergedConversationContext,
  });
  classificationMs = Date.now() - classificationStartedAt;
  const reasoningMode = shouldUseAdvancedReasoning(requestClassification) ? 'advanced' : 'simple';
  const earlyKnowledgeSource = normalizeKnowledgeSourceDecision(
    decideKnowledgeSource({
      userText: question,
      requestClassification,
      semanticProfile: null,
    })
  );

  if (requestClassification.category === 'sem_contexto_suficiente') {
    clearPendingClarification(sessionId);
    return finalizeResponse(clarificationResponse({
      answerText: buildClassificationClarificationQuestion(requestClassification),
      intent: null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: 0,
      planningUsageTrace: null,
      mode: 'clarification',
      reasoningMode,
      requestClassification,
      planningLatencyMs: null,
    }), {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      questionType: 'clarification',
    });
  }

  const deterministicRoute = detectDeterministicRoute({
    userText: question,
    screenContext: safeScreenContext,
  });
  if (deterministicRoute.matched) {
    const deterministicResolved = resolveToolCallWithContext({
      toolName: deterministicRoute.tool_name,
      toolArgs: deterministicRoute.tool_args,
      entities: {},
      screenContext: safeScreenContext,
    });

    if (deterministicResolved.needs_clarification) {
      clearPendingClarification(sessionId);
      return finalizeResponse(clarificationResponse({
        answerText:
          deterministicResolved.clarification_question ||
          'Preciso confirmar o periodo antes de consultar.',
        intent: deterministicRoute.intent || null,
        resolvedContext: deterministicResolved.resolved_context || {},
        sessionId,
        turnId,
        confidence: 0.7,
        planningUsageTrace: null,
        mode: 'clarification',
        reasoningMode: 'deterministic',
        requestClassification: {
          ...requestClassification,
          deterministic_route: {
            matched: true,
            reason: deterministicRoute.reason,
            multi_intent: deterministicRoute.multi_intent || null,
          },
        },
        planningLatencyMs: 0,
      }), {
        decision_ms: 0,
        orchestration_ms: Date.now() - runStartedAt,
      }, {
        intent: deterministicRoute.intent || null,
        questionType: deterministicRoute.question_type || 'resumo',
      });
    }

    const deterministicValidation = validateToolCall(
      deterministicRoute.tool_name,
      deterministicResolved.resolved_args || {}
    );
    if (!deterministicValidation.ok) {
      const msg = deterministicValidation.errors && deterministicValidation.errors.length
        ? deterministicValidation.errors[0]
        : 'Nao consegui validar os parametros da consulta deterministica.';
      return finalizeResponse(clarificationResponse({
        answerText: msg,
        intent: deterministicRoute.intent || null,
        resolvedContext: deterministicResolved.resolved_context || {},
        sessionId,
        turnId,
        confidence: 0.7,
        planningUsageTrace: null,
        mode: 'clarification',
        reasoningMode: 'deterministic',
        requestClassification: {
          ...requestClassification,
          deterministic_route: {
            matched: true,
            reason: deterministicRoute.reason,
            validation_failed: true,
            multi_intent: deterministicRoute.multi_intent || null,
          },
        },
        planningLatencyMs: 0,
      }), {
        decision_ms: 0,
        orchestration_ms: Date.now() - runStartedAt,
      }, {
        intent: deterministicRoute.intent || null,
        questionType: deterministicRoute.question_type || 'resumo',
      });
    }

    clearPendingClarification(sessionId);
    const deterministicResult = await executeSimpleFlow({
      validation: deterministicValidation,
      resolvedContext: deterministicResolved.resolved_context || {},
      sessionId,
      turnId,
      intent: deterministicRoute.intent,
      confidence: deterministicRoute.confidence,
      planningUsageTrace: {
        model: null,
        usage: null,
        metadata: {
          reasoning_mode: 'deterministic',
          deterministic_route: {
            matched: true,
            reason: deterministicRoute.reason,
            multi_intent: deterministicRoute.multi_intent || null,
          },
        },
      },
      requestClassification: {
        ...requestClassification,
        deterministic_route: {
          matched: true,
          reason: deterministicRoute.reason,
          multi_intent: deterministicRoute.multi_intent || null,
        },
      },
      planningLatencyMs: 0,
    });

    return finalizeResponse({
      ...deterministicResult,
      reasoning_mode: 'deterministic',
      telemetry: mergeTelemetry(deterministicResult.telemetry, {
        flow: 'deterministic',
      }),
    }, {
      decision_ms: 0,
    }, {
      intent: deterministicRoute.intent || null,
      questionType: deterministicRoute.question_type || 'resumo',
      entities: {},
      resolvedContext: deterministicResolved.resolved_context || {},
      toolName: deterministicValidation.tool_name,
      toolArgs: deterministicValidation.normalized_args,
    });
  }

  if (earlyKnowledgeSource.strategy === 'repo_only' && earlyKnowledgeSource.should_use_repo_read) {
    clearPendingClarification(sessionId);
    const repoOnlyResult = await executeRepoReadFlow({
      questionForAnswer: question,
      sessionId,
      turnId,
      planningUsageTrace: null,
      requestClassification: {
        ...requestClassification,
        knowledge_source: earlyKnowledgeSource,
      },
      planningLatencyMs: 0,
      sourceDecision: earlyKnowledgeSource,
      semanticProfile: null,
      factualContext: null,
      reasoningMode: 'repo_read',
    });
    return finalizeResponse(repoOnlyResult, {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: repoOnlyResult.intent || null,
      questionType: 'repo_only',
      entities: {},
      resolvedContext: repoOnlyResult.resolved_context || {},
      toolName: 'repo_search',
      toolArgs: {},
    });
  }

  const planningResult = await interpretRequestSemantically({
    userText: question,
    screenContext: safeScreenContext,
    conversationContext: mergedConversationContext,
    memoryContext,
  });
  const planning = planningResult.planning;
  const planningLatencyMs = Number(planningResult.latency_ms || 0);

  const planningUsageTrace = {
    model: planningResult.model || null,
    usage: planningResult.usage || null,
  };

  const semanticProfile = buildSemanticDecisionProfile({
    userText: question,
    planning,
    requestClassification,
    screenContext: safeScreenContext,
  });
  let effectiveRequestClassification = enrichRequestClassificationWithSemantic(
    requestClassification,
    semanticProfile
  );
  const sourceDecision = normalizeKnowledgeSourceDecision(
    decideKnowledgeSource({
      userText: question,
      requestClassification: effectiveRequestClassification,
      semanticProfile,
    })
  );
  effectiveRequestClassification = {
    ...effectiveRequestClassification,
    knowledge_source: sourceDecision,
  };
  let semanticPlanning = applySemanticProfileToPlanning({
    planning,
    semanticProfile,
  });

  if (sourceDecision.strategy === 'repo_only' && sourceDecision.should_use_repo_read) {
    clearPendingClarification(sessionId);
    const repoOnlyResult = await executeRepoReadFlow({
      questionForAnswer: question,
      sessionId,
      turnId,
      planningUsageTrace,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
      sourceDecision,
      semanticProfile,
      factualContext: null,
      reasoningMode: 'repo_read',
    });
    return finalizeResponse(repoOnlyResult, {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: repoOnlyResult.intent || null,
      questionType: 'repo_only',
      entities: semanticPlanning.entities || {},
      resolvedContext: repoOnlyResult.resolved_context || {},
      toolName: 'repo_search',
      toolArgs: {},
    });
  }

  const semanticSafety = applySemanticSafetyGuard({
    userText: question,
    planning: semanticPlanning,
    semanticProfile,
  });
  semanticPlanning = isPlainObject(semanticSafety.planning) ? semanticSafety.planning : semanticPlanning;
  effectiveRequestClassification = {
    ...effectiveRequestClassification,
    semantic_safety: {
      blocked: Boolean(semanticSafety.blocked),
      corrected: Boolean(semanticSafety.corrected),
      reason: sanitizeShortText(semanticSafety.reason),
    },
  };

  if (semanticSafety.blocked) {
    clearPendingClarification(sessionId);
    return finalizeResponse(clarificationResponse({
      answerText:
        sanitizeShortText(semanticSafety.message) ||
        'Preciso de periodo explicito para executar essa consulta com seguranca.',
      intent: semanticPlanning.intent || null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      mode: 'clarification',
      reasoningMode: 'advanced',
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
    });
  }

  if (sanitizeShortText(semanticProfile.coverage_limitation)) {
    clearPendingClarification(sessionId);
    return finalizeResponse(clarificationResponse({
      answerText: sanitizeShortText(semanticProfile.coverage_limitation),
      intent: semanticPlanning.intent || null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      mode: 'limitation',
      reasoningMode: 'advanced',
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
    });
  }

  if (semanticPlanning.out_of_scope) {
    clearPendingClarification(sessionId);
    return finalizeResponse(clarificationResponse({
      answerText:
        semanticPlanning.clarification_question ||
        'Sou focada apenas no sistema de emprestimos. Pode pedir uma consulta do sistema?',
      intent: semanticPlanning.intent || null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      mode: 'out_of_scope',
      reasoningMode,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: 0,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
    });
  }

  const decisionStartedAt = Date.now();
  const interpretationSnapshot = buildInterpretationSnapshot(semanticPlanning);
  const decision = decideExecutionPath({
    planning: semanticPlanning,
    interpretationSnapshot,
    requestClassification: effectiveRequestClassification,
    userText: question,
    semanticProfile,
  });
  const decisionMs = Date.now() - decisionStartedAt;

  if (decision.needs_clarification) {
    let pinnedOptions = Array.isArray(decision.ambiguity_options)
      ? decision.ambiguity_options.slice(0, 5)
      : [];
    let canUseNumberedResolution = false;
    if (decision.forced_ambiguity) {
      const pendingCandidates = buildPendingClarificationCandidates({
        planning: semanticPlanning,
        decision,
        requestClassification: effectiveRequestClassification,
        screenContext: safeScreenContext,
        resolvedContext: safeScreenContext.selected_ids || {},
      });

      if (pendingCandidates.length >= 2) {
        if (pendingCandidates.length !== pinnedOptions.length) {
          pinnedOptions = pendingCandidates
            .map((item) => sanitizeShortText(item && item.label))
            .filter(Boolean)
            .slice(0, 5);
        }
        if (pinnedOptions.length >= 2 && pendingCandidates.length >= pinnedOptions.length) {
          setPendingClarification(sessionId, {
            original_question: question,
            original_intent: semanticPlanning.intent || '',
            options: pinnedOptions,
            candidates: pendingCandidates.slice(0, pinnedOptions.length),
          });
          canUseNumberedResolution = true;
        } else {
          clearPendingClarification(sessionId);
        }
      } else {
        clearPendingClarification(sessionId);
      }
    } else {
      clearPendingClarification(sessionId);
    }

    const forcedAmbiguityWithoutPinnedCandidates =
      decision.forced_ambiguity && !canUseNumberedResolution;
    const clarificationText = forcedAmbiguityWithoutPinnedCandidates
      ? 'Preciso de mais detalhes objetivos para consultar sem erro. Informe periodo e o tipo exato de total que voce quer.'
      : decision.forced_ambiguity && canUseNumberedResolution
        ? buildForcedAmbiguityQuestion(pinnedOptions)
        : decision.clarification_question ||
          'Pode detalhar um pouco melhor para eu consultar os dados corretos?';

    return finalizeResponse(clarificationResponse({
      answerText: clarificationText,
      intent: semanticPlanning.intent || null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      mode: decision.reason === 'forced_ambiguity'
        ? 'forced_ambiguity'
        : decision.reason === 'mandatory_ambiguity'
          ? 'forced_ambiguity'
        : decision.reason === 'low_confidence'
          ? 'low_confidence'
          : 'clarification',
      reasoningMode: decision.forced_ambiguity ? 'advanced' : reasoningMode,
      requestClassification: effectiveRequestClassification,
      followUp: decision.forced_ambiguity && canUseNumberedResolution
        ? {
            type: 'ambiguity_options',
            options: pinnedOptions,
          }
        : null,
      planningLatencyMs,
    }), {
      decision_ms: decisionMs,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
    });
  }

  clearPendingClarification(sessionId);

  if (!semanticPlanning.tool_name) {
    return finalizeResponse(clarificationResponse({
      answerText:
        'Nao consegui identificar com seguranca qual consulta executar. Pode reformular?',
      intent: semanticPlanning.intent || null,
      resolvedContext: {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      reasoningMode,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: decisionMs,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
    });
  }

  const resolved = resolveToolCallWithContext({
    toolName: semanticPlanning.tool_name,
    toolArgs: semanticPlanning.tool_args,
    entities: semanticPlanning.entities,
    screenContext: safeScreenContext,
  });

  if (resolved.needs_clarification) {
    return finalizeResponse(clarificationResponse({
      answerText:
        resolved.clarification_question ||
        'Preciso de mais detalhes para executar a consulta com seguranca.',
      intent: semanticPlanning.intent || null,
      resolvedContext: resolved.resolved_context || {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      reasoningMode,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: decisionMs,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
      resolvedContext: resolved.resolved_context || {},
    });
  }

  const validation = validateToolCall(semanticPlanning.tool_name, resolved.resolved_args || {});
  if (!validation.ok) {
    const validationMessage =
      validation.errors && validation.errors.length
        ? validation.errors[0]
        : 'Nao consegui validar os parametros da consulta.';
    return finalizeResponse(clarificationResponse({
      answerText: validationMessage,
      intent: semanticPlanning.intent || null,
      resolvedContext: resolved.resolved_context || {},
      sessionId,
      turnId,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      reasoningMode,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    }), {
      decision_ms: decisionMs,
      orchestration_ms: Date.now() - runStartedAt,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
      resolvedContext: resolved.resolved_context || {},
    });
  }

  const shouldUseHybrid =
    sourceDecision.strategy === 'hybrid' &&
    sourceDecision.should_use_repo_read;

  if (shouldUseHybrid) {
    const hybridResult = await executeHybridFlow({
      questionForAnswer: question,
      reasoningMode,
      domainExecution: {
        validation,
        resolvedContext: resolved.resolved_context || {},
        screenContext: safeScreenContext,
        sessionId,
        turnId,
        intent: semanticPlanning.intent,
        confidence: semanticPlanning.confidence,
        conversationContext: mergedConversationContext,
      },
      sourceDecision,
      semanticProfile,
      requestClassification: effectiveRequestClassification,
      planningUsageTrace,
      planningLatencyMs,
    });
    return finalizeResponse(hybridResult, {
      decision_ms: decisionMs,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
      resolvedContext: resolved.resolved_context || {},
      toolName: validation.tool_name,
      toolArgs: validation.normalized_args,
    });
  }

  if (reasoningMode === 'simple') {
    const simpleResult = await executeSimpleFlow({
      validation,
      resolvedContext: resolved.resolved_context || {},
      sessionId,
      turnId,
      intent: semanticPlanning.intent,
      confidence: semanticPlanning.confidence,
      planningUsageTrace,
      requestClassification: effectiveRequestClassification,
      planningLatencyMs,
    });
    return finalizeResponse(simpleResult, {
      decision_ms: decisionMs,
    }, {
      intent: semanticPlanning.intent || null,
      questionType: semanticPlanning.question_type || '',
      entities: semanticPlanning.entities || {},
      resolvedContext: resolved.resolved_context || {},
      toolName: validation.tool_name,
      toolArgs: validation.normalized_args,
    });
  }

  const advancedResult = await executeAdvancedFlow({
    questionForAnswer: question,
    intent: semanticPlanning.intent,
    validation,
    resolvedContext: resolved.resolved_context || {},
    screenContext: safeScreenContext,
    sessionId,
    turnId,
    planningUsageTrace,
    confidence: semanticPlanning.confidence,
    conversationContext: mergedConversationContext,
    requestClassification: effectiveRequestClassification,
    planningLatencyMs,
    semanticProfile,
  });
  return finalizeResponse(advancedResult, {
    decision_ms: decisionMs,
  }, {
    intent: semanticPlanning.intent || null,
    questionType: semanticPlanning.question_type || '',
    entities: semanticPlanning.entities || {},
    resolvedContext: resolved.resolved_context || {},
    toolName: validation.tool_name,
    toolArgs: validation.normalized_args,
  });
}

function warmupAssistantPipeline() {
  const cfg = getOpenAIConfig();
  const catalog = getToolCatalog();
  // Warm-up local e sem custo de provedor.
  buildPlanningSystemPrompt();
  buildAnswerSystemPrompt();

  return {
    ready: true,
    has_api_key: Boolean(cfg.apiKey),
    tools_count: catalog.length,
    warmed_at: new Date().toISOString(),
  };
}

module.exports = {
  runAssistantQuery,
  warmupAssistantPipeline,
  __internal: {
    detectDeterministicRoute,
    buildCaixaResumoArgsFromTemporalScope,
    inferTemporalScope,
    buildSemanticDecisionProfile,
    applySemanticSafetyGuard,
    resolveEventStockRange,
    buildPendingClarificationCandidates,
    buildSimpleNaturalAnswerFromTool,
    detectCompositeAggregationsFromText,
    normalizeKnowledgeSourceDecision,
    buildRepoSearchQueries,
    buildRepoEvidenceAnswerText,
    mergeFactualAndRepoAnswer,
    executeRepoReadFlow,
    executeHybridFlow,
  },
};
