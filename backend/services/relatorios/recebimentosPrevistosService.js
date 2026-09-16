const db = require('../../models/database');
const { getAsync } = require('../../utils/sqliteAsync');
const { toMoney } = require('./common/money');
const { isIsoDate, parseBooleanFlag } = require('./common/dateRange');
const { getTableColumns } = require('./common/schemaGuards');
const { buildParcelasSqlParts } = require('./queries/parcelasBaseQuery');
const {
  getDiasPagamentoCorrespondentes,
  buildRecebimentosPrevistosSql,
} = require('./queries/recebimentosPrevistosQuery');

function normalizeRange({ de, ate } = {}) {
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

function mapBucket(row, prefix) {
  return {
    total: toMoney(row?.[`${prefix}_total`]),
    capital: toMoney(row?.[`${prefix}_capital`]),
    juros: toMoney(row?.[`${prefix}_juros`]),
  };
}

function addBuckets(left, right) {
  return {
    total: toMoney(Number(left?.total || 0) + Number(right?.total || 0)),
    capital: toMoney(Number(left?.capital || 0) + Number(right?.capital || 0)),
    juros: toMoney(Number(left?.juros || 0) + Number(right?.juros || 0)),
  };
}

async function getRecebimentosPrevistosByRange(
  { de, ate, incluirAtrasados = false } = {},
  { dbHandle = db } = {}
) {
  const range = normalizeRange({ de, ate });
  const useSchemaCache = dbHandle === db;

  const [parcelasCols, emprestimosCols, clientesCols] = await Promise.all([
    getTableColumns('parcelas', { dbHandle, useCache: useSchemaCache }),
    getTableColumns('emprestimos', { dbHandle, useCache: useSchemaCache }),
    getTableColumns('clientes', { dbHandle, useCache: useSchemaCache }),
  ]);

  const { baseCte } = buildParcelasSqlParts(
    parcelasCols,
    emprestimosCols,
    clientesCols
  );
  const diasPagamentoCorrespondentes = getDiasPagamentoCorrespondentes(
    range.de,
    range.ate
  );
  const sql = buildRecebimentosPrevistosSql({
    baseCte,
    diasPagamentoCorrespondentes,
  });
  const row = await getAsync(dbHandle, sql, [
    range.de,
    range.ate,
    range.de,
    ...diasPagamentoCorrespondentes,
  ]);

  const periodo = mapBucket(row, 'periodo');
  const atrasados = mapBucket(row, 'atrasados');
  const deveIncluirAtrasados = parseBooleanFlag(incluirAtrasados, false);

  return {
    incluir_atrasados: deveIncluirAtrasados ? 1 : 0,
    periodo,
    atrasados,
    total: deveIncluirAtrasados ? addBuckets(periodo, atrasados) : periodo,
  };
}

module.exports = {
  normalizeRange,
  mapBucket,
  addBuckets,
  getRecebimentosPrevistosByRange,
};
