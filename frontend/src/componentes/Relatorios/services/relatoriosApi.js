import axios from 'axios';

const STATUS_VALIDO = new Set(['vencidas', 'vencendo', 'todos']);
const DEFAULT_STATUS = 'todos';
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === 'sim' || raw === 'yes') return true;
  if (raw === 'false' || raw === 'nao' || raw === 'não' || raw === 'no') return false;
  return fallback;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return STATUS_VALIDO.has(status) ? status : DEFAULT_STATUS;
}

export function buildCobrancaQueryParams(rawFilters = {}, options = {}) {
  const includePagination = options.includePagination !== false;
  const page = parsePositiveInt(rawFilters.page, DEFAULT_PAGE);
  const pageSize = Math.min(
    parsePositiveInt(rawFilters.pageSize, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );

  const query = {
    status: normalizeStatus(rawFilters.status),
    incluirPagas: parseBooleanFlag(rawFilters.incluirPagas, false) ? 1 : 0,
  };

  const de = String(rawFilters.de || '').trim();
  if (de) query.de = de;

  const ate = String(rawFilters.ate || '').trim();
  if (ate) query.ate = ate;

  const clienteNome = String(rawFilters.cliente_nome || '').trim();
  if (clienteNome) query.cliente_nome = clienteNome;

  const clienteId = parsePositiveInt(rawFilters.cliente_id, 0);
  if (clienteId > 0) query.cliente_id = clienteId;

  if (includePagination) {
    query.page = page;
    query.pageSize = pageSize;
  }

  return query;
}

export async function getCobranca(filters = {}) {
  const params = buildCobrancaQueryParams(filters, { includePagination: true });
  const resp = await axios.get('/relatorios/cobranca', { params });
  return resp?.data || {};
}

export async function getCobrancaPrint(filters = {}) {
  const params = buildCobrancaQueryParams(filters, { includePagination: false });
  const resp = await axios.get('/relatorios/cobranca/print', { params });
  return resp?.data || {};
}

