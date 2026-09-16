const { resolvePeriodoRange } = require('../../caixaService');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

function todayLocalISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDaysISO(baseISO, daysToAdd) {
  const dt = new Date(`${baseISO}T00:00:00`);
  dt.setDate(dt.getDate() + Number(daysToAdd || 0));
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return !!defaultValue;
  return String(value) === '1' || String(value).toLowerCase() === 'true';
}

function parseNonNegativeInt(value, defaultValue = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return defaultValue;
  return Math.trunc(n);
}

function normalizeStrictDateRange({ de, ate } = {}) {
  if (!isIsoDate(de) || !isIsoDate(ate)) {
    const err = new Error('Parametros de e ate sao obrigatorios no formato YYYY-MM-DD.');
    err.code = 'INVALID_DATE_RANGE_FORMAT';
    throw err;
  }

  if (de > ate) {
    const err = new Error('Intervalo invalido: de deve ser menor ou igual a ate.');
    err.code = 'INVALID_DATE_RANGE_ORDER';
    throw err;
  }

  return { de, ate };
}

function normalizeCaixaRange({ periodo = 'dia', de, ate } = {}) {
  return resolvePeriodoRange({
    periodo: String(periodo || 'dia').toLowerCase(),
    de,
    ate,
  });
}

function normalizeCaixaRangeFromQuery(query = {}) {
  return normalizeCaixaRange({
    periodo: query?.periodo,
    de: query?.de,
    ate: query?.ate,
  });
}

module.exports = {
  ISO_DATE_RE,
  isIsoDate,
  todayLocalISO,
  addDaysISO,
  parseBooleanFlag,
  parseNonNegativeInt,
  normalizeStrictDateRange,
  normalizeCaixaRange,
  normalizeCaixaRangeFromQuery,
};

