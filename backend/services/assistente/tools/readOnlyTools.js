const db = require('../../../models/database');
const { getAsync, allAsync } = require('../../../utils/sqliteAsync');
const emprestimoService = require('../../servicoemprestimo');
const { listarNotificacoesPendentes } = require('../../notificacoesService');
const { resolvePeriodoRange, todayLocalISO } = require('../../caixaService');

function toMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function toPositiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function isParcelaAberta(row) {
  const pagoFlag = Number(row && row.pago_flag ? row.pago_flag : 0) === 1;
  const valorPago = Number(row && row.valor_pago ? row.valor_pago : 0);
  const totalDevido = Number(row && row.total_devido_calculado ? row.total_devido_calculado : 0);
  if (pagoFlag) return false;
  if (!Number.isFinite(totalDevido) || totalDevido <= 0) return true;
  return valorPago + 0.009 < totalDevido;
}

async function caixaResumo(args = {}) {
  const range = resolvePeriodoRange({
    periodo: args.periodo,
    de: args.de,
    ate: args.ate,
  });

  const row = await getAsync(
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
    [range.de, range.ate]
  );

  const totalRecebido = toMoney(row && row.total_recebido);
  const totalJuros = toMoney(row && row.total_juros_recebido);
  const totalCapital = toMoney(row && row.total_capital_recebido);
  const totalEmprestimos = toMoney(row && row.total_emprestimos);
  const totalDespesas = toMoney(row && row.total_despesas);
  const saldo = toMoney(totalRecebido - totalEmprestimos - totalDespesas);

  return {
    periodo: range.periodo,
    de: range.de,
    ate: range.ate,
    total_recebido: totalRecebido,
    total_juros_recebido: totalJuros,
    total_capital_recebido: totalCapital,
    total_emprestimos: totalEmprestimos,
    total_despesas: totalDespesas,
    saldo,
  };
}

async function parcelasPorPeriodo(args = {}) {
  const de = args.de || todayLocalISO();
  const ate = args.ate || todayLocalISO();
  const tipo = String(args.tipo || 'todas').toLowerCase();
  const incluirPagas = Boolean(args.incluirPagas);

  const params = [];
  let whereByTipo = '';

  if (tipo === 'vencidas') {
    whereByTipo = 'DATE(p.vencimento) < DATE(?)';
    params.push(de);
  } else {
    whereByTipo = 'DATE(p.vencimento) BETWEEN DATE(?) AND DATE(?)';
    params.push(de, ate);
  }

  const sql = `
    SELECT
      p.id AS parcela_id,
      p.emprestimo_id,
      e.cliente_id,
      c.nome AS cliente_nome,
      p.numero,
      p.vencimento,
      COALESCE(p.valor_total, 0) AS valor_total,
      COALESCE(p.valor_capital, 0) AS valor_capital,
      COALESCE(p.valor_juros, 0) AS valor_juros,
      COALESCE(p.juros_adicionais, 0) AS juros_adicionais,
      COALESCE(p.juros_pendentes, 0) AS juros_pendentes,
      COALESCE(p.valor_pago, 0) AS valor_pago,
      COALESCE(p.pago, 0) AS pago_flag,
      CASE
        WHEN COALESCE(p.valor_total, 0) > 0
          THEN COALESCE(p.valor_total, 0) + COALESCE(p.juros_adicionais, 0)
        ELSE COALESCE(p.valor_capital, 0)
             + COALESCE(p.valor_juros, 0)
             + COALESCE(p.juros_adicionais, 0)
             + COALESCE(p.juros_pendentes, 0)
      END AS total_devido_calculado
    FROM parcelas p
    JOIN emprestimos e
      ON e.id = p.emprestimo_id
    LEFT JOIN clientes c
      ON c.id = e.cliente_id
    WHERE (p.numero IS NULL OR p.numero != -1)
      AND (p.versao IS NULL OR p.versao = e.versao_atual)
      AND p.id = (
        SELECT MAX(p2.id)
        FROM parcelas p2
        WHERE p2.emprestimo_id = p.emprestimo_id
          AND p2.numero = p.numero
          AND (p2.versao IS NULL OR p2.versao = e.versao_atual)
      )
      AND ${whereByTipo}
    ORDER BY DATE(p.vencimento) ASC, c.nome COLLATE NOCASE ASC, p.emprestimo_id ASC
    LIMIT 600
  `;

  const rows = await allAsync(db, sql, params);
  const nowISO = todayLocalISO();

  const filtered = (rows || []).filter((row) => {
    if (incluirPagas) return true;
    return isParcelaAberta(row);
  });

  const parcelas = filtered.map((row) => {
    const vencimento = row.vencimento ? String(row.vencimento).slice(0, 10) : null;
    let status = 'ABERTA';
    if (!isParcelaAberta(row)) status = 'PAGA';
    else if (vencimento && vencimento < nowISO) status = 'VENCIDA';
    else if (vencimento && vencimento === nowISO) status = 'VENCE_HOJE';
    else if (vencimento && vencimento > nowISO) status = 'VENCE_EM_BREVE';

    return {
      parcela_id: toPositiveInteger(row.parcela_id),
      emprestimo_id: toPositiveInteger(row.emprestimo_id),
      cliente_id: toPositiveInteger(row.cliente_id),
      cliente_nome: row.cliente_nome || null,
      numero: row.numero != null ? Number(row.numero) : null,
      vencimento,
      valor_total: toMoney(row.valor_total),
      valor_capital: toMoney(row.valor_capital),
      valor_juros: toMoney(row.valor_juros),
      juros_adicionais: toMoney(row.juros_adicionais),
      juros_pendentes: toMoney(row.juros_pendentes),
      valor_pago: toMoney(row.valor_pago),
      total_devido_calculado: toMoney(row.total_devido_calculado),
      status,
    };
  });

  return {
    tipo,
    de,
    ate,
    incluirPagas,
    total: parcelas.length,
    parcelas,
  };
}

async function emprestimoDetalhe(args = {}) {
  const emprestimoId = toPositiveInteger(args.emprestimo_id);
  if (!emprestimoId) throw new Error('emprestimo_id invalido.');

  const emprestimo = await emprestimoService.buscarEmprestimoPorId(emprestimoId);
  if (!emprestimo) {
    throw new Error(`Emprestimo #${emprestimoId} nao encontrado.`);
  }

  let clienteNome = emprestimo.cliente_nome || null;
  if (!clienteNome && emprestimo.cliente_id) {
    const cliente = await getAsync(db, 'SELECT nome FROM clientes WHERE id = ?', [emprestimo.cliente_id]);
    clienteNome = cliente && cliente.nome ? cliente.nome : null;
  }

  const parcelas = Array.isArray(emprestimo.parcelasDetalhes) ? emprestimo.parcelasDetalhes : [];
  const parcelasResumo = parcelas
    .filter((p) => p && Number(p.numero) !== -1)
    .map((p) => ({
      id: toPositiveInteger(p.id),
      numero: p.numero != null ? Number(p.numero) : null,
      vencimento: p.vencimento ? String(p.vencimento).slice(0, 10) : null,
      pago: Number(p.pago || 0) === 1,
      valor_total: toMoney(p.valor_total),
      valor_pago: toMoney(p.valor_pago),
      valor_capital: toMoney(p.valor_capital),
      valor_juros: toMoney(p.valor_juros),
      juros_adicionais: toMoney(p.juros_adicionais),
      juros_pendentes: toMoney(p.juros_pendentes),
    }));

  const parcelasAbertas = parcelasResumo.filter((p) => !p.pago).length;

  return {
    id: emprestimoId,
    cliente_id: toPositiveInteger(emprestimo.cliente_id),
    cliente_nome: clienteNome,
    modalidade: emprestimo.modalidade || null,
    taxa_juros: Number(emprestimo.taxa_juros || 0),
    valor_emprestado: toMoney(emprestimo.valor_emprestado || emprestimo.valor),
    valor_atual: toMoney(emprestimo.valor_atual || emprestimo.valor),
    capital_restante: toMoney(emprestimo.capital_restante),
    total_pago: toMoney(emprestimo.total_pago),
    parcelas_total: parcelasResumo.length,
    parcelas_em_aberto: parcelasAbertas,
    parcelas: parcelasResumo.slice(0, 150),
  };
}

async function notificacoesPendentes() {
  const lista = await listarNotificacoesPendentes();
  const notificacoes = (lista || []).map((n) => ({
    id: toPositiveInteger(n.id),
    tipo: n.tipo || null,
    titulo: n.titulo || null,
    mensagem: n.mensagem || null,
    data_referencia: n.data_referencia || null,
    cliente_id: toPositiveInteger(n.cliente_id),
    cliente_nome: n.cliente_nome || null,
    emprestimo_id: toPositiveInteger(n.emprestimo_id),
    parcela_id: toPositiveInteger(n.parcela_id),
    parcela_numero: n.parcela_numero != null ? Number(n.parcela_numero) : null,
    parcela_vencimento: n.parcela_vencimento || null,
  }));

  return {
    total: notificacoes.length,
    notificacoes: notificacoes.slice(0, 200),
  };
}

async function clienteBusca(args = {}) {
  const id = toPositiveInteger(args.id);
  const nome = String(args.nome || '').trim();

  if (id != null) {
    const row = await getAsync(
      db,
      `SELECT id, nome
         FROM clientes
        WHERE id = ?`,
      [id]
    );
    return {
      criterio: { id },
      total: row ? 1 : 0,
      clientes: row ? [row] : [],
    };
  }

  const rows = await allAsync(
    db,
    `SELECT id, nome
       FROM clientes
      WHERE nome LIKE ?
      ORDER BY nome COLLATE NOCASE ASC
      LIMIT 30`,
    [`${nome}%`]
  );

  return {
    criterio: { nome },
    total: rows.length,
    clientes: rows,
  };
}

async function executeReadOnlyTool(toolName, args = {}) {
  if (toolName === 'caixa_resumo') return caixaResumo(args);
  if (toolName === 'parcelas_por_periodo') return parcelasPorPeriodo(args);
  if (toolName === 'emprestimo_detalhe') return emprestimoDetalhe(args);
  if (toolName === 'notificacoes_pendentes') return notificacoesPendentes(args);
  if (toolName === 'cliente_busca') return clienteBusca(args);
  throw new Error(`Tool ${toolName} nao suportada.`);
}

module.exports = {
  executeReadOnlyTool,
};
