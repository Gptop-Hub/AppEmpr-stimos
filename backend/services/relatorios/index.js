const db = require('../../models/database');
const { allAsync, getAsync } = require('../../utils/sqliteAsync');
const {
  normalizeCaixaRangeFromQuery,
  normalizeCaixaRange,
  parseBooleanFlag,
} = require('./common/dateRange');
const { toMoney } = require('./common/money');
const { getRecebimentosPrevistosByRange } = require('./recebimentosPrevistosService');

async function getFluxoCaixaResumoByRange(range, { incluirAtrasados = false } = {}) {
  const { periodo, de, ate } = range;

  const [row, recebimentos_previstos] = await Promise.all([
    getAsync(
      db,
      `SELECT
       COALESCE(SUM(CASE
         WHEN UPPER(COALESCE(tipo, '')) = 'ENTRADA'
         THEN COALESCE(valor_total, 0)
         ELSE 0
       END), 0) AS total_recebido,
       COALESCE(SUM(CASE
         WHEN UPPER(COALESCE(tipo, '')) = 'ENTRADA'
         THEN COALESCE(valor_juros, 0)
         ELSE 0
       END), 0) AS total_juros_recebido,
       COALESCE(SUM(CASE
         WHEN UPPER(COALESCE(tipo, '')) = 'ENTRADA'
         THEN COALESCE(valor_capital, 0)
         ELSE 0
       END), 0) AS total_capital_recebido,
       COALESCE(SUM(CASE
         WHEN UPPER(COALESCE(tipo, '')) = 'SAIDA'
          AND UPPER(COALESCE(categoria, '')) = 'EMPRESTIMO'
         THEN COALESCE(NULLIF(valor_emprestimo, 0), valor_total, 0)
         ELSE 0
       END), 0) AS total_emprestimos,
       COALESCE(SUM(CASE
         WHEN UPPER(COALESCE(tipo, '')) = 'SAIDA'
          AND UPPER(COALESCE(categoria, '')) = 'DESPESA'
         THEN COALESCE(NULLIF(valor_despesa, 0), valor_total, 0)
         ELSE 0
       END), 0) AS total_despesas
     FROM caixa_movimentos
    WHERE DATE(data) BETWEEN DATE(?) AND DATE(?)`,
      [de, ate]
    ),
    getRecebimentosPrevistosByRange({ de, ate, incluirAtrasados }),
  ]);

  const total_recebido = toMoney(row?.total_recebido);
  const total_juros_recebido = toMoney(row?.total_juros_recebido);
  const total_capital_recebido = toMoney(row?.total_capital_recebido);
  const total_emprestimos = toMoney(row?.total_emprestimos);
  const total_despesas = toMoney(row?.total_despesas);
  const saldo = toMoney(total_recebido - total_emprestimos - total_despesas);

  return {
    success: true,
    periodo,
    de,
    ate,
    total_recebido,
    total_juros_recebido,
    total_capital_recebido,
    total_emprestimos,
    total_despesas,
    saldo,
    recebimentos_previstos,
  };
}

async function getFluxoCaixaLinhasByRange(range) {
  const { periodo, de, ate } = range;

  const rows = await allAsync(
    db,
    `SELECT
       id,
       cliente_id,
       cliente_nome,
       emprestimo_id,
       parcela_id,
       parcela_numero,
       DATE(data) AS data_evento,
       data_vencimento,
       data_pagamento,
       COALESCE(valor_total, 0) AS valor_total,
       COALESCE(valor_juros, 0) AS valor_juros,
       COALESCE(valor_capital, 0) AS valor_capital,
       COALESCE(valor_emprestimo, 0) AS valor_emprestimo,
       COALESCE(valor_despesa, 0) AS valor_despesa,
       descricao,
       categoria,
       tipo,
       meta_json
     FROM caixa_movimentos
    WHERE DATE(data) BETWEEN DATE(?) AND DATE(?)
    ORDER BY DATE(data) DESC, id DESC`,
    [de, ate]
  );

  const linhas = (rows || []).map((row) => ({
    id: Number(row.id),
    id_cliente: row.cliente_id != null ? Number(row.cliente_id) : null,
    cliente_id: row.cliente_id != null ? Number(row.cliente_id) : null,
    nome: row.cliente_nome || null,
    cliente_nome: row.cliente_nome || null,
    emprestimo_id: row.emprestimo_id != null ? Number(row.emprestimo_id) : null,
    parcela_id: row.parcela_id != null ? Number(row.parcela_id) : null,
    parcela_numero: row.parcela_numero != null ? Number(row.parcela_numero) : null,
    data: row.data_evento || null,
    data_vencimento: row.data_vencimento || null,
    data_pagamento: row.data_pagamento || row.data_evento || null,
    valor_total: toMoney(row.valor_total),
    valor_juros: toMoney(row.valor_juros),
    valor_capital: toMoney(row.valor_capital),
    valor_emprestimo: toMoney(row.valor_emprestimo),
    valor_despesa: toMoney(row.valor_despesa),
    descricao: row.descricao || null,
    categoria: row.categoria || null,
    tipo: row.tipo || null,
    meta_json: row.meta_json || null,
  }));

  return {
    success: true,
    periodo,
    de,
    ate,
    total: linhas.length,
    linhas,
  };
}

async function getFluxoCaixaResumoFromQuery(query = {}) {
  const range = normalizeCaixaRangeFromQuery(query);
  const incluirAtrasados = parseBooleanFlag(
    query?.incluirAtrasados ?? query?.incluir_atrasados,
    false
  );
  return getFluxoCaixaResumoByRange(range, { incluirAtrasados });
}

async function getFluxoCaixaLinhasFromQuery(query = {}) {
  const range = normalizeCaixaRangeFromQuery(query);
  return getFluxoCaixaLinhasByRange(range);
}

module.exports = {
  normalizeCaixaRange,
  normalizeCaixaRangeFromQuery,
  getFluxoCaixaResumoByRange,
  getFluxoCaixaLinhasByRange,
  getFluxoCaixaResumoFromQuery,
  getFluxoCaixaLinhasFromQuery,
  getRecebimentosPrevistosByRange,
};
