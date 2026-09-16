const db = require('../../models/database');
const { allAsync, getAsync } = require('../../utils/sqliteAsync');
const { toMoney } = require('./common/money');
const {
  isIsoDate,
  todayLocalISO,
  parseBooleanFlag,
} = require('./common/dateRange');
const { getTableColumns } = require('./common/schemaGuards');
const { buildParcelasSqlParts } = require('./queries/parcelasBaseQuery');
const {
  normalizeStatus,
  buildCobrancaWhereAndParams,
  buildCobrancaCountSql,
  buildCobrancaDataSql,
} = require('./queries/cobrancaQuery');

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePositiveInt(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.trunc(n);
}

function normalizeDateFilters({ de, ate } = {}) {
  const hoje = todayLocalISO();

  let deFinal = de ? String(de).trim() : '';
  let ateFinal = ate ? String(ate).trim() : '';

  if (!deFinal && !ateFinal) {
    deFinal = hoje;
    ateFinal = hoje;
  } else if (deFinal && !ateFinal) {
    ateFinal = deFinal;
  } else if (!deFinal && ateFinal) {
    deFinal = ateFinal;
  }

  if (!isIsoDate(deFinal) || !isIsoDate(ateFinal)) {
    const err = new Error('Parametros de e ate devem estar no formato YYYY-MM-DD.');
    err.code = 'INVALID_DATE_RANGE_FORMAT';
    throw err;
  }
  if (deFinal > ateFinal) {
    const err = new Error('Intervalo invalido: de deve ser menor ou igual a ate.');
    err.code = 'INVALID_DATE_RANGE_ORDER';
    throw err;
  }

  return { de: deFinal, ate: ateFinal };
}

function normalizeFilters(raw = {}) {
  const { de, ate } = normalizeDateFilters({
    de: raw?.de,
    ate: raw?.ate,
  });
  const status = normalizeStatus(raw?.status);
  const incluirPagas = parseBooleanFlag(raw?.incluirPagas, false);
  const cliente_id =
    Number.isFinite(Number(raw?.cliente_id)) && Number(raw?.cliente_id) > 0
      ? Math.trunc(Number(raw?.cliente_id))
      : null;
  const cliente_nome = String(raw?.cliente_nome || '').trim();
  const page = parsePositiveInt(raw?.page, DEFAULT_PAGE);
  const pageSize = Math.min(parsePositiveInt(raw?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  return {
    de,
    ate,
    status,
    incluirPagas,
    cliente_id,
    cliente_nome,
    page,
    pageSize,
  };
}

function mapCobrancaRow(row) {
  return {
    parcela_id: row?.parcela_id != null ? Number(row.parcela_id) : null,
    emprestimo_id: row?.emprestimo_id != null ? Number(row.emprestimo_id) : null,
    cliente_id: row?.cliente_id != null ? Number(row.cliente_id) : null,
    cliente_nome: row?.cliente_nome || null,
    telefone: row?.telefone || null,
    parcela_numero: row?.parcela_numero != null ? Number(row.parcela_numero) : null,
    vencimento: row?.vencimento || null,
    valor_total: toMoney(row?.valor_total),
    dias_em_atraso: row?.dias_em_atraso != null ? Number(row.dias_em_atraso) : 0,
    observacao: row?.observacao || null,
  };
}

async function carregarBaseParcelasSql() {
  const [parcelasCols, emprestimosCols, clientesCols] = await Promise.all([
    getTableColumns('parcelas'),
    getTableColumns('emprestimos'),
    getTableColumns('clientes'),
  ]);

  const { baseCte } = buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols);
  const hasTelefone = clientesCols.has('telefone');
  const hasParcelaObservacao = parcelasCols.has('observacao');

  return {
    baseCte,
    hasTelefone,
    hasParcelaObservacao,
  };
}

async function listarCobranca(rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  const hoje = todayLocalISO();

  const { baseCte, hasTelefone, hasParcelaObservacao } = await carregarBaseParcelasSql();
  const { whereSql, whereParams } = buildCobrancaWhereAndParams({
    status: filters.status,
    de: filters.de,
    ate: filters.ate,
    hoje,
    incluirPagas: filters.incluirPagas,
    clienteId: filters.cliente_id,
    clienteNome: filters.cliente_nome,
  });

  const countSql = buildCobrancaCountSql({ baseCte, whereSql });
  const totalRow = await getAsync(db, countSql, whereParams);
  const total = Number(totalRow?.total || 0);

  const page = filters.page;
  const pageSize = filters.pageSize;
  const offset = (page - 1) * pageSize;

  const dataSql = buildCobrancaDataSql({
    baseCte,
    whereSql,
    hasTelefone,
    hasParcelaObservacao,
    paginated: true,
  });
  const rows = await allAsync(db, dataSql, [hoje, hoje, ...whereParams, pageSize, offset]);
  const itens = (rows || []).map(mapCobrancaRow);

  return {
    success: true,
    de: filters.de,
    ate: filters.ate,
    status: filters.status,
    incluirPagas: filters.incluirPagas ? 1 : 0,
    cliente_id: filters.cliente_id,
    cliente_nome: filters.cliente_nome || null,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    itens,
  };
}

async function listarCobrancaPrint(rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  const hoje = todayLocalISO();

  const { baseCte, hasTelefone, hasParcelaObservacao } = await carregarBaseParcelasSql();
  const { whereSql, whereParams } = buildCobrancaWhereAndParams({
    status: filters.status,
    de: filters.de,
    ate: filters.ate,
    hoje,
    incluirPagas: filters.incluirPagas,
    clienteId: filters.cliente_id,
    clienteNome: filters.cliente_nome,
  });

  const dataSql = buildCobrancaDataSql({
    baseCte,
    whereSql,
    hasTelefone,
    hasParcelaObservacao,
    paginated: false,
  });
  const rows = await allAsync(db, dataSql, [hoje, hoje, ...whereParams]);
  const itens = (rows || []).map(mapCobrancaRow);

  return {
    success: true,
    de: filters.de,
    ate: filters.ate,
    status: filters.status,
    incluirPagas: filters.incluirPagas ? 1 : 0,
    cliente_id: filters.cliente_id,
    cliente_nome: filters.cliente_nome || null,
    total: itens.length,
    itens,
  };
}

module.exports = {
  normalizeFilters,
  listarCobranca,
  listarCobrancaPrint,
};

