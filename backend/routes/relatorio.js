const express = require('express');
const db = require('../models/database');
const { allAsync, getAsync } = require('../utils/sqliteAsync');
const { getTableColumns } = require('../services/relatorios/common/schemaGuards');
const {
  parseBooleanFlag,
  parseNonNegativeInt,
  isIsoDate,
  todayLocalISO,
  addDaysISO,
} = require('../services/relatorios/common/dateRange');
const { buildParcelasSqlParts } = require('../services/relatorios/queries/parcelasBaseQuery');

const router = express.Router();

function normalizeDateRange(req, res) {
  const de = req.query?.de;
  const ate = req.query?.ate;

  if (!isIsoDate(de) || !isIsoDate(ate)) {
    res.status(400).json({
      success: false,
      error: 'Parametros de e ate sao obrigatorios no formato YYYY-MM-DD.',
    });
    return null;
  }

  if (de > ate) {
    res.status(400).json({
      success: false,
      error: 'Intervalo invalido: de deve ser menor ou igual a ate.',
    });
    return null;
  }

  return { de, ate };
}

router.get('/relatorio/resumo', async (req, res) => {
  try {
    const range = normalizeDateRange(req, res);
    if (!range) return;

    const { de, ate } = range;
    const incluirPagas = parseBooleanFlag(req.query?.incluirPagas, false);
    const incluirVencendoEmXDias = parseNonNegativeInt(req.query?.incluirVencendoEmXDias, 0);

    const hoje = todayLocalISO();
    const limiteBreve = addDaysISO(hoje, incluirVencendoEmXDias);

    const [parcelasCols, emprestimosCols, clientesCols, pagamentosCols] = await Promise.all([
      getTableColumns('parcelas'),
      getTableColumns('emprestimos'),
      getTableColumns('clientes'),
      getTableColumns('pagamentos'),
    ]);

    const { baseCte } = buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols);
    const condAbertaResumo = incluirPagas ? '1=1' : 'is_paga_defensiva = 0';

    const resumoSql = `
      ${baseCte}
      SELECT
        COALESCE(SUM(CASE WHEN DATE(vencimento) < DATE(?) AND ${condAbertaResumo} THEN 1 ELSE 0 END), 0) AS totalParcelasVencidas,
        COALESCE(SUM(CASE WHEN DATE(vencimento) = DATE(?) AND ${condAbertaResumo} THEN 1 ELSE 0 END), 0) AS totalParcelasVencendoHoje,
        COALESCE(SUM(CASE WHEN DATE(vencimento) > DATE(?) AND DATE(vencimento) <= DATE(?) AND ${condAbertaResumo} THEN 1 ELSE 0 END), 0) AS totalParcelasVencendoEmBreve,
        COALESCE(COUNT(DISTINCT CASE WHEN DATE(vencimento) < DATE(?) AND ${condAbertaResumo} THEN emprestimo_id END), 0) AS totalContratosComAtraso
      FROM base_parcelas
    `;

    const resumoRow = await getAsync(db, resumoSql, [hoje, hoje, hoje, limiteBreve, hoje]);

    let totalRecebidoNoPeriodo = 0;
    let totalJurosRecebidosNoPeriodo = null;
    let totalCapitalRecebidoNoPeriodo = null;

    const hasPagamentosData = pagamentosCols.has('data');
    const tipoCol = pagamentosCols.has('tipo_pagamento')
      ? 'tipo_pagamento'
      : pagamentosCols.has('tipo')
        ? 'tipo'
        : null;

    if (hasPagamentosData) {
      const recebidosSql = `
        SELECT
          COALESCE(SUM(COALESCE(pg.valor, 0)), 0) AS total_recebido,
          ${
            tipoCol
              ? `COALESCE(SUM(CASE WHEN LOWER(COALESCE(pg.${tipoCol}, '')) = 'juros' THEN COALESCE(pg.valor, 0) ELSE 0 END), 0)`
              : 'NULL'
          } AS total_juros,
          ${
            tipoCol
              ? `COALESCE(SUM(CASE WHEN LOWER(COALESCE(pg.${tipoCol}, '')) = 'juros' THEN 0 ELSE COALESCE(pg.valor, 0) END), 0)`
              : 'NULL'
          } AS total_capital
        FROM pagamentos pg
        WHERE DATE(pg.data) BETWEEN DATE(?) AND DATE(?)
      `;

      const recebidosRow = await getAsync(db, recebidosSql, [de, ate]);
      totalRecebidoNoPeriodo = Number(recebidosRow?.total_recebido || 0);
      totalJurosRecebidosNoPeriodo =
        recebidosRow?.total_juros === null || recebidosRow?.total_juros === undefined
          ? null
          : Number(recebidosRow.total_juros || 0);
      totalCapitalRecebidoNoPeriodo =
        recebidosRow?.total_capital === null || recebidosRow?.total_capital === undefined
          ? null
          : Number(recebidosRow.total_capital || 0);
    }

    return res.json({
      success: true,
      de,
      ate,
      incluirPagas: incluirPagas ? 1 : 0,
      incluirVencendoEmXDias,
      totalParcelasVencidas: Number(resumoRow?.totalParcelasVencidas || 0),
      totalParcelasVencendoHoje: Number(resumoRow?.totalParcelasVencendoHoje || 0),
      totalParcelasVencendoEmBreve: Number(resumoRow?.totalParcelasVencendoEmBreve || 0),
      totalRecebidoNoPeriodo,
      totalJurosRecebidosNoPeriodo,
      totalCapitalRecebidoNoPeriodo,
      totalContratosComAtraso: Number(resumoRow?.totalContratosComAtraso || 0),
    });
  } catch (err) {
    console.error('[relatorio/resumo] erro:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao gerar resumo.' });
  }
});

router.get('/relatorio/parcelas', async (req, res) => {
  try {
    const range = normalizeDateRange(req, res);
    if (!range) return;

    const { de, ate } = range;
    const tipoRaw = String(req.query?.tipo || 'todas').toLowerCase();
    const tipo = ['vencidas', 'vencendo', 'todas'].includes(tipoRaw) ? tipoRaw : 'todas';
    const incluirPagas = parseBooleanFlag(req.query?.incluirPagas, false);
    const hoje = todayLocalISO();

    const [parcelasCols, emprestimosCols, clientesCols] = await Promise.all([
      getTableColumns('parcelas'),
      getTableColumns('emprestimos'),
      getTableColumns('clientes'),
    ]);

    const { baseCte, hasNumero } = buildParcelasSqlParts(parcelasCols, emprestimosCols, clientesCols);

    let whereSql = '1=1';
    const whereParams = [];

    if (tipo === 'vencidas') {
      whereSql = 'DATE(vencimento) < DATE(?) AND is_paga_defensiva = 0';
      whereParams.push(hoje);
    } else if (tipo === 'vencendo') {
      whereSql = 'DATE(vencimento) BETWEEN DATE(?) AND DATE(?) AND is_paga_defensiva = 0';
      whereParams.push(de, ate);
    } else {
      whereSql = 'DATE(vencimento) BETWEEN DATE(?) AND DATE(?)';
      whereParams.push(de, ate);
      if (!incluirPagas) {
        whereSql += ' AND is_paga_defensiva = 0';
      }
    }

    const parcelasSql = `
      ${baseCte}
      SELECT
        parcela_id,
        emprestimo_id,
        cliente_id,
        cliente_nome,
        numero,
        vencimento,
        valor_total,
        juros_adicionais,
        valor_pago,
        pago_flag,
        total_devido_calculado,
        CASE
          WHEN is_paga_defensiva = 1 THEN 'PAGA'
          WHEN DATE(vencimento) < DATE(?) THEN 'VENCIDA'
          WHEN DATE(vencimento) = DATE(?) THEN 'VENCE_HOJE'
          WHEN DATE(vencimento) > DATE(?) THEN 'VENCE_EM_BREVE'
          ELSE 'ABERTA'
        END AS status,
        CASE
          WHEN DATE(vencimento) < DATE(?) THEN CAST(julianday(DATE(?)) - julianday(DATE(vencimento)) AS INTEGER)
          ELSE 0
        END AS dias_atraso,
        modalidade,
        valor_emprestado,
        valor_atual,
        versao
      FROM base_parcelas
      WHERE ${whereSql}
      ORDER BY
        DATE(vencimento) ASC,
        cliente_nome COLLATE NOCASE ASC,
        emprestimo_id ASC,
        ${hasNumero ? 'COALESCE(numero, 0) ASC,' : ''}
        parcela_id ASC
    `;

    const rows = await allAsync(db, parcelasSql, [hoje, hoje, hoje, hoje, hoje, ...whereParams]);
    const parcelas = (rows || []).map((row) => ({
      ...row,
      total_devido_calculado: Number(row.total_devido_calculado || 0),
      valor_total: Number(row.valor_total || 0),
      juros_adicionais: Number(row.juros_adicionais || 0),
      valor_pago: Number(row.valor_pago || 0),
      pago_flag: Number(row.pago_flag || 0),
      dias_atraso: Number(row.dias_atraso || 0),
    }));

    return res.json({
      success: true,
      de,
      ate,
      tipo,
      incluirPagas: incluirPagas ? 1 : 0,
      total: parcelas.length,
      parcelas,
    });
  } catch (err) {
    console.error('[relatorio/parcelas] erro:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao listar parcelas.' });
  }
});

router.get('/relatorio/recebidos', async (req, res) => {
  try {
    const range = normalizeDateRange(req, res);
    if (!range) return;

    const { de, ate } = range;
    const [pagamentosCols, clientesCols] = await Promise.all([
      getTableColumns('pagamentos'),
      getTableColumns('clientes'),
    ]);

    const dataCol = pagamentosCols.has('data')
      ? 'data'
      : pagamentosCols.has('created_at')
        ? 'created_at'
        : null;

    if (!dataCol) {
      return res.status(500).json({
        success: false,
        error: 'Coluna de data de pagamentos nao encontrada (data/created_at).',
      });
    }

    const tipoExpr = pagamentosCols.has('tipo_pagamento')
      ? 'pg.tipo_pagamento'
      : pagamentosCols.has('tipo')
        ? 'pg.tipo'
        : 'NULL';
    const observacaoExpr = pagamentosCols.has('observacao') ? 'pg.observacao' : 'NULL';
    const explicacaoExpr = pagamentosCols.has('explicacao') ? 'pg.explicacao' : 'NULL';
    const parcelaOrigemExpr = pagamentosCols.has('parcela_origem') ? 'pg.parcela_origem' : 'NULL';
    const parcelaOrigemNumeroExpr = pagamentosCols.has('parcela_origem')
      ? '(CASE WHEN pg.parcela_origem IS NULL THEN NULL ELSE (pg.parcela_origem + 1) END)'
      : 'NULL';
    const renegociacaoExpr = pagamentosCols.has('renegociacao_id') ? 'pg.renegociacao_id' : 'NULL';
    const clienteNomeExpr = clientesCols.has('nome') ? 'c.nome' : 'NULL';

    const eventosSql = `
      SELECT
        pg.id AS pagamento_id,
        pg.emprestimo_id AS emprestimo_id,
        e.cliente_id AS cliente_id,
        ${clienteNomeExpr} AS cliente_nome,
        DATE(pg.${dataCol}) AS data,
        COALESCE(pg.valor, 0) AS valor,
        ${tipoExpr} AS tipo,
        ${observacaoExpr} AS observacao,
        ${explicacaoExpr} AS explicacao,
        ${parcelaOrigemExpr} AS parcela_origem,
        ${parcelaOrigemNumeroExpr} AS parcela_origem_numero,
        ${renegociacaoExpr} AS renegociacao_id
      FROM pagamentos pg
      LEFT JOIN emprestimos e ON e.id = pg.emprestimo_id
      LEFT JOIN clientes c ON c.id = e.cliente_id
      WHERE DATE(pg.${dataCol}) BETWEEN DATE(?) AND DATE(?)
      ORDER BY DATE(pg.${dataCol}) DESC, pg.id DESC
    `;

    const porDiaSql = `
      SELECT
        DATE(pg.${dataCol}) AS data,
        COALESCE(SUM(COALESCE(pg.valor, 0)), 0) AS total,
        COUNT(1) AS count
      FROM pagamentos pg
      WHERE DATE(pg.${dataCol}) BETWEEN DATE(?) AND DATE(?)
      GROUP BY DATE(pg.${dataCol})
      ORDER BY DATE(pg.${dataCol}) ASC
    `;

    const [eventosRows, porDiaRows] = await Promise.all([
      allAsync(db, eventosSql, [de, ate]),
      allAsync(db, porDiaSql, [de, ate]),
    ]);

    const eventos = (eventosRows || []).map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
    }));

    const por_dia = (porDiaRows || []).map((row) => ({
      data: row.data,
      total: Number(row.total || 0),
      count: Number(row.count || 0),
    }));

    const totalRecebidoNoPeriodo = Number(
      eventos.reduce((acc, item) => acc + Number(item.valor || 0), 0).toFixed(2)
    );

    return res.json({
      success: true,
      de,
      ate,
      totalRecebidoNoPeriodo,
      eventos,
      por_dia,
    });
  } catch (err) {
    console.error('[relatorio/recebidos] erro:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao listar recebidos.' });
  }
});

module.exports = router;
