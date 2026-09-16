const { getAsync, allAsync } = require('../../utils/sqliteAsync');
const { buildParcelasSqlParts } = require('./queries/parcelasBaseQuery');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

async function getTableColumns(tableName, dbHandle) {
  const rows = await allAsync(dbHandle, `PRAGMA table_info(${tableName})`);
  return new Set((rows || []).map((row) => row?.name).filter(Boolean));
}

function assertISODate(value, field) {
  if (!ISO_DATE_RE.test(String(value || ''))) {
    const error = new Error(`${field} deve estar no formato YYYY-MM-DD.`);
    error.code = 'INVALID_DATE_RANGE_FORMAT';
    throw error;
  }
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    const error = new Error(`${field} e invalida.`);
    error.code = 'INVALID_DATE_RANGE_FORMAT';
    throw error;
  }
}

function normalizeParams({ de, ate, agrupamento = 'dia' } = {}) {
  assertISODate(de, 'Data inicial');
  assertISODate(ate, 'Data final');
  if (de > ate) {
    const error = new Error('Data final nao pode ser anterior a data inicial.');
    error.code = 'INVALID_DATE_RANGE_ORDER';
    throw error;
  }
  const group = String(agrupamento).toLowerCase();
  if (group !== 'dia' && group !== 'mes') {
    const error = new Error('Agrupamento deve ser dia ou mes.');
    error.code = 'INVALID_GROUPING';
    throw error;
  }
  return { de: String(de), ate: String(ate), agrupamento: group };
}

function buildBuckets(de, ate, agrupamento) {
  const buckets = [];
  const cursor = new Date(`${de}T00:00:00`);
  const end = new Date(`${ate}T00:00:00`);
  if (agrupamento === 'mes') {
    cursor.setDate(1);
    while (cursor <= end) {
      buckets.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
      cursor.setMonth(cursor.getMonth() + 1, 1);
    }
    return buckets;
  }
  while (cursor <= end) {
    buckets.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

const DETAIL_METRICS = Object.freeze({
  previsto: { title: 'Previsto para receber', type: 'currency' },
  recebido: { title: 'Recebido no período', type: 'currency' },
  pendente: { title: 'Pendente', type: 'currency' },
  cobertura: { title: 'Cobertura do previsto', type: 'percent' },
  capitalRecebido: { title: 'Capital recebido', type: 'currency' },
  jurosRecebidos: { title: 'Juros recebidos', type: 'currency' },
  quantidadePagamentos: { title: 'Pagamentos registrados', type: 'count' },
  quantidadeParcelasPendentes: { title: 'Parcelas pendentes', type: 'count' },
  novosEmprestimos: { title: 'Novos empréstimos', type: 'count' },
  novosClientes: { title: 'Novos clientes', type: 'count' },
  valorEmprestado: { title: 'Valor emprestado', type: 'currency' },
});

function normalizeDetailMetric(metric) {
  const key = String(metric || '').trim();
  const config = DETAIL_METRICS[key];
  if (!config) {
    const error = new Error('Indicador inválido para detalhamento.');
    error.code = 'INVALID_DETAIL_METRIC';
    throw error;
  }
  return { key, ...config };
}

function mapDetailRows(rows, type) {
  return (rows || []).map((row) => ({
    id: row?.cliente_id == null ? null : Number(row.cliente_id),
    nome: row?.cliente_nome || 'Cliente não identificado',
    valor: type === 'count' ? Number(row?.valor || 0) : money(row?.valor),
  }));
}

async function getDetalhamentoPainelPeriodo(params = {}, options = {}) {
  const dbHandle = options.dbHandle || require('../../models/database');
  const range = normalizeParams(params);
  const metric = normalizeDetailMetric(params.metric);
  const [parcelasCols, emprestimosCols, clientesCols] = await Promise.all([
    getTableColumns('parcelas', dbHandle),
    getTableColumns('emprestimos', dbHandle),
    getTableColumns('clientes', dbHandle),
  ]);
  const { baseCte } = buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols);
  const baseWhere = 'WHERE DATE(vencimento) BETWEEN DATE(?) AND DATE(?)';
  const cashWhere = `WHERE UPPER(COALESCE(cm.tipo, '')) = 'ENTRADA'
      AND UPPER(COALESCE(cm.categoria, '')) = 'PAGAMENTO'
      AND DATE(COALESCE(cm.data_pagamento, cm.data)) BETWEEN DATE(?) AND DATE(?)`;
  const cashClientName = "COALESCE(NULLIF(TRIM(cm.cliente_nome), ''), 'Cliente não identificado')";
  let rows = [];

  if (metric.key === 'previsto') {
    rows = await allAsync(dbHandle, `${baseCte}
      SELECT cliente_id, cliente_nome, COALESCE(SUM(total_devido_calculado), 0) AS valor
      FROM base_parcelas ${baseWhere}
      GROUP BY cliente_id, cliente_nome ORDER BY valor DESC, cliente_nome`, [range.de, range.ate]);
  } else if (metric.key === 'pendente' || metric.key === 'quantidadeParcelasPendentes') {
    const value = metric.key === 'pendente'
      ? 'COALESCE(SUM(MAX(total_devido_calculado - valor_pago, 0)), 0)'
      : 'COALESCE(SUM(CASE WHEN MAX(total_devido_calculado - valor_pago, 0) > 0 THEN 1 ELSE 0 END), 0)';
    rows = await allAsync(dbHandle, `${baseCte}
      SELECT cliente_id, cliente_nome, ${value} AS valor
      FROM base_parcelas ${baseWhere}
      GROUP BY cliente_id, cliente_nome
      HAVING valor > 0 ORDER BY valor DESC, cliente_nome`, [range.de, range.ate]);
  } else if (metric.key === 'recebido' || metric.key === 'capitalRecebido' || metric.key === 'jurosRecebidos' || metric.key === 'quantidadePagamentos') {
    const valueByMetric = {
      recebido: 'COALESCE(SUM(cm.valor_total), 0)',
      capitalRecebido: 'COALESCE(SUM(cm.valor_capital), 0)',
      jurosRecebidos: 'COALESCE(SUM(cm.valor_juros), 0)',
      quantidadePagamentos: 'COUNT(*)',
    };
    rows = await allAsync(dbHandle, `
      SELECT cm.cliente_id, ${cashClientName} AS cliente_nome, ${valueByMetric[metric.key]} AS valor
      FROM caixa_movimentos cm ${cashWhere}
      GROUP BY cm.cliente_id, ${cashClientName} ORDER BY valor DESC, cliente_nome`, [range.de, range.ate]);
  } else if (metric.key === 'cobertura') {
    rows = await allAsync(dbHandle, `${baseCte},
      previsto_por_cliente AS (
        SELECT cliente_id, cliente_nome, COALESCE(SUM(total_devido_calculado), 0) AS previsto
        FROM base_parcelas ${baseWhere}
        GROUP BY cliente_id, cliente_nome
      ),
      recebido_por_cliente AS (
        SELECT cm.cliente_id, ${cashClientName} AS cliente_nome, COALESCE(SUM(cm.valor_total), 0) AS recebido
        FROM caixa_movimentos cm ${cashWhere}
        GROUP BY cm.cliente_id, ${cashClientName}
      ),
      clientes_periodo AS (
        SELECT cliente_id, cliente_nome FROM previsto_por_cliente
        UNION
        SELECT cliente_id, cliente_nome FROM recebido_por_cliente
      )
      SELECT cp.cliente_id, cp.cliente_nome,
        CASE WHEN COALESCE(ppc.previsto, 0) > 0
          THEN (COALESCE(rpc.recebido, 0) * 100.0 / ppc.previsto)
          ELSE 0 END AS valor
      FROM clientes_periodo cp
      LEFT JOIN previsto_por_cliente ppc
        ON ppc.cliente_id = cp.cliente_id AND ppc.cliente_nome = cp.cliente_nome
      LEFT JOIN recebido_por_cliente rpc
        ON rpc.cliente_id = cp.cliente_id AND rpc.cliente_nome = cp.cliente_nome
      ORDER BY valor DESC, cp.cliente_nome`, [range.de, range.ate, range.de, range.ate]);
  } else if (metric.key === 'novosClientes') {
    const clientCreatedAtColumn = [
      'criadoEm',
      'criado_em',
      'created_at',
      'createdAt',
    ].find((column) => clientesCols.has(column));
    if (clientCreatedAtColumn) {
      rows = await allAsync(dbHandle, `
        SELECT c.id AS cliente_id,
          COALESCE(NULLIF(TRIM(c.nome), ''), 'Cliente nao identificado') AS cliente_nome,
          1 AS valor
        FROM clientes c
        WHERE DATE(c.${clientCreatedAtColumn}) BETWEEN DATE(?) AND DATE(?)
        ORDER BY cliente_nome`, [range.de, range.ate]);
    }
  } else {
    const loanDateExpr = emprestimosCols.has('data') ? 'DATE(e.data)' : 'NULL';
    const loanValueExpr = emprestimosCols.has('valor_emprestado')
      ? 'COALESCE(e.valor_emprestado, e.valor, 0)'
      : emprestimosCols.has('valor') ? 'COALESCE(e.valor, 0)' : '0';
    const renegociacaoFilter = emprestimosCols.has('renegociacao_de')
      ? 'AND e.renegociacao_de IS NULL'
      : '1=1';
    const value = metric.key === 'novosEmprestimos' ? 'COUNT(*)' : `COALESCE(SUM(${loanValueExpr}), 0)`;
    const clientNameExpr = clientesCols.has('nome')
      ? "COALESCE(NULLIF(TRIM(c.nome), ''), 'Cliente não identificado')"
      : "'Cliente não identificado'";
    rows = await allAsync(dbHandle, `
      SELECT e.cliente_id, ${clientNameExpr} AS cliente_nome, ${value} AS valor
      FROM emprestimos e
      LEFT JOIN clientes c ON c.id = e.cliente_id
      WHERE ${loanDateExpr} BETWEEN DATE(?) AND DATE(?) ${renegociacaoFilter}
      GROUP BY e.cliente_id, ${clientNameExpr} ORDER BY valor DESC, cliente_nome`, [range.de, range.ate]);
  }

  return {
    metric: metric.key,
    titulo: metric.title,
    tipoValor: metric.type,
    rows: mapDetailRows(rows, metric.type),
  };
}

async function getRelatorioPainelPeriodo(params = {}, options = {}) {
  const dbHandle = options.dbHandle || require('../../models/database');
  const range = normalizeParams(params);
  const [parcelasCols, emprestimosCols, clientesCols] = await Promise.all([
    getTableColumns('parcelas', dbHandle),
    getTableColumns('emprestimos', dbHandle),
    getTableColumns('clientes', dbHandle),
  ]);
  const { baseCte } = buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols);
  const bucketExprParcelas = range.agrupamento === 'mes'
    ? "strftime('%Y-%m', vencimento)"
    : 'DATE(vencimento)';
  const bucketExprCaixa = range.agrupamento === 'mes'
    ? "strftime('%Y-%m', COALESCE(data_pagamento, data))"
    : 'DATE(COALESCE(data_pagamento, data))';

  const [parcelasResumo, recebidoResumo, previstoSerieRows, recebidoSerieRows] = await Promise.all([
    getAsync(
      dbHandle,
      `${baseCte}
       SELECT
         COALESCE(SUM(total_devido_calculado), 0) AS previsto,
         COALESCE(SUM(MAX(total_devido_calculado - valor_pago, 0)), 0) AS pendente,
         COALESCE(SUM(CASE WHEN MAX(total_devido_calculado - valor_pago, 0) > 0 THEN 1 ELSE 0 END), 0) AS parcelas_pendentes
       FROM base_parcelas
       WHERE DATE(vencimento) BETWEEN DATE(?) AND DATE(?)`,
      [range.de, range.ate]
    ),
    getAsync(
      dbHandle,
      `SELECT
         COALESCE(SUM(valor_total), 0) AS recebido,
         COALESCE(SUM(valor_capital), 0) AS capital,
         COALESCE(SUM(valor_juros), 0) AS juros,
         COUNT(*) AS quantidade_pagamentos,
         COALESCE(SUM(CASE WHEN meta_json LIKE '%"backfill":true%' THEN 1 ELSE 0 END), 0) AS registros_backfill
       FROM caixa_movimentos
       WHERE UPPER(COALESCE(tipo, '')) = 'ENTRADA'
         AND UPPER(COALESCE(categoria, '')) = 'PAGAMENTO'
         AND DATE(COALESCE(data_pagamento, data)) BETWEEN DATE(?) AND DATE(?)`,
      [range.de, range.ate]
    ),
    allAsync(
      dbHandle,
      `${baseCte}
       SELECT ${bucketExprParcelas} AS chave, COALESCE(SUM(total_devido_calculado), 0) AS valor
       FROM base_parcelas
       WHERE DATE(vencimento) BETWEEN DATE(?) AND DATE(?)
       GROUP BY ${bucketExprParcelas}`,
      [range.de, range.ate]
    ),
    allAsync(
      dbHandle,
      `SELECT ${bucketExprCaixa} AS chave, COALESCE(SUM(valor_total), 0) AS valor
       FROM caixa_movimentos
       WHERE UPPER(COALESCE(tipo, '')) = 'ENTRADA'
         AND UPPER(COALESCE(categoria, '')) = 'PAGAMENTO'
         AND DATE(COALESCE(data_pagamento, data)) BETWEEN DATE(?) AND DATE(?)
       GROUP BY ${bucketExprCaixa}`,
      [range.de, range.ate]
    ),
  ]);

  const loanDateExpr = emprestimosCols.has('data') ? 'DATE(e.data)' : 'NULL';
  const loanValueExpr = emprestimosCols.has('valor_emprestado')
    ? 'COALESCE(e.valor_emprestado, e.valor, 0)'
    : emprestimosCols.has('valor') ? 'COALESCE(e.valor, 0)' : '0';
  const renegociacaoFilter = emprestimosCols.has('renegociacao_de')
    ? 'AND e.renegociacao_de IS NULL'
    : '1=1';
  const emprestimosResumo = await getAsync(
    dbHandle,
    `SELECT COUNT(*) AS novos_emprestimos, COALESCE(SUM(${loanValueExpr}), 0) AS valor_emprestado
       FROM emprestimos e
      WHERE ${loanDateExpr} BETWEEN DATE(?) AND DATE(?)
        ${renegociacaoFilter}`,
    [range.de, range.ate]
  );

  const clientCreatedAtColumn = [
    'criadoEm',
    'criado_em',
    'created_at',
    'createdAt',
  ].find((column) => clientesCols.has(column));
  const novosClientesResumo = clientCreatedAtColumn
    ? await getAsync(
      dbHandle,
      `SELECT COUNT(*) AS novos_clientes
         FROM clientes c
        WHERE DATE(c.${clientCreatedAtColumn}) BETWEEN DATE(?) AND DATE(?)`,
      [range.de, range.ate]
    )
    : { novos_clientes: 0 };

  const previsto = money(parcelasResumo?.previsto);
  const recebido = money(recebidoResumo?.recebido);
  const composicaoConfiavel = Number(recebidoResumo?.registros_backfill || 0) === 0;
  const coverage = previsto > 0 ? money((recebido / previsto) * 100) : 0;
  const previstoPorChave = new Map((previstoSerieRows || []).map((row) => [row.chave, money(row.valor)]));
  const recebidoPorChave = new Map((recebidoSerieRows || []).map((row) => [row.chave, money(row.valor)]));
  const serie = buildBuckets(range.de, range.ate, range.agrupamento).map((chave) => ({
    chave,
    previsto: previstoPorChave.get(chave) || 0,
    recebido: recebidoPorChave.get(chave) || 0,
  }));

  return {
    periodo: range,
    indicadores: {
      previsto,
      recebido,
      pendente: money(parcelasResumo?.pendente),
      percentual: coverage,
      percentualTipo: 'cobertura',
      capitalRecebido: composicaoConfiavel ? money(recebidoResumo?.capital) : null,
      jurosRecebidos: composicaoConfiavel ? money(recebidoResumo?.juros) : null,
      jurosAdicionaisRecebidos: null,
      quantidadePagamentos: Number(recebidoResumo?.quantidade_pagamentos || 0),
      quantidadeParcelasPendentes: Number(parcelasResumo?.parcelas_pendentes || 0),
      novosClientes: Number(novosClientesResumo?.novos_clientes || 0),
      novosEmprestimos: Number(emprestimosResumo?.novos_emprestimos || 0),
      valorEmprestado: money(emprestimosResumo?.valor_emprestado),
      composicaoConfiavel,
    },
    serie,
  };
}

module.exports = {
  normalizeParams,
  buildBuckets,
  getRelatorioPainelPeriodo,
  getDetalhamentoPainelPeriodo,
};
