// utils/pagamento_juros.js
const db = require('../models/database');

const { formatISODate, addMonthsSafe } = (() => {
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatISODate(d) {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
      dt.getDate()
    )}`;
  }

  function addMonthsSafe(dateLike, months, desiredDay) {
    if (!dateLike) return null;
    const base = new Date(dateLike);
    if (isNaN(base.getTime())) return null;

    const targetYear =
      base.getFullYear() + Math.floor((base.getMonth() + months) / 12);
    const targetMonth = (base.getMonth() + months) % 12;
    const day = Number.isFinite(desiredDay) ? desiredDay : base.getDate();

    let candidate = new Date(targetYear, targetMonth, day);
    if (candidate.getMonth() !== ((targetMonth + 12) % 12)) {
      const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
      candidate = new Date(targetYear, targetMonth, lastDay);
    }

    return candidate;
  }

  return { formatISODate, addMonthsSafe };
})();

// array com nomes dos meses em português
const mesesPt = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

function getAsync(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function allAsync(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function getFixedDayFromParcelas(parcelas = []) {
  const primeira = parcelas.find((p) => p && p.vencimento);
  if (!primeira || !primeira.vencimento) return null;
  const parts = String(primeira.vencimento).split('-').map(Number);
  if (parts.length >= 3 && Number.isFinite(parts[2])) {
    const d = parts[2];
    return d >= 1 && d <= 31 ? d : null;
  }
  const dt = new Date(primeira.vencimento);
  if (isNaN(dt.getTime())) return null;
  return dt.getDate();
}

async function getFixedDayFromOriginais(emprestimoId, dbHandle = db) {
  if (emprestimoId == null) return null;
  const cols = await allAsync(dbHandle, 'PRAGMA table_info(parcelas_originais)', []);
  const names = (cols || []).map((c) => c.name);
  const dateCol = names.includes('vencimento')
    ? 'vencimento'
    : names.includes('data_vencimento')
    ? 'data_vencimento'
    : null;
  if (!dateCol) return null;

  const row = await getAsync(dbHandle,
    `SELECT ${dateCol} AS vencimento
       FROM parcelas_originais
      WHERE emprestimo_id = ?
      ORDER BY numero ASC, id ASC
      LIMIT 1`,
    [emprestimoId]
  );
  if (!row || !row.vencimento) return null;
  const parts = String(row.vencimento).split('-').map(Number);
  if (parts.length >= 3 && Number.isFinite(parts[2])) {
    const d = parts[2];
    return d >= 1 && d <= 31 ? d : null;
  }
  const dt = new Date(row.vencimento);
  if (isNaN(dt.getTime())) return null;
  return dt.getDate();
}

async function resolveFixedDay(emprestimoId, parcelas = [], dbHandle = db) {
  if (emprestimoId != null) {
    try {
      const row = await getAsync(dbHandle,
        'SELECT dia_pagamento FROM emprestimos WHERE id = ?',
        [emprestimoId]
      );
      const dia = Number(row && row.dia_pagamento);
      if (Number.isFinite(dia) && dia >= 1 && dia <= 31) return dia;
    } catch {
      // fallback abaixo
    }
  }
  try {
    const dOrig = await getFixedDayFromOriginais(emprestimoId, dbHandle);
    if (Number.isFinite(dOrig)) return dOrig;
  } catch {
    // fallback abaixo
  }
  return getFixedDayFromParcelas(parcelas);
}

module.exports = async function aplicarPagamentoJuros(
  parcelas = [],
  atualIndex = 0,
  valor = 0,
  dataPagoISO = null,
  observacao = '',
  { dbHandle = db } = {}
) {
  const p = parcelas[atualIndex];
  if (!p) return [];

  const valorNum = Number(valor || 0);

  // juros "atuais" = juros base + pendentes + adicionais manuais
  const jurosBase = Number(p.valor_juros ?? 0);
  const jurosPendentes = Number(p.juros_pendentes || 0);
  const jurosAdicionais = Number(p.juros_adicionais || 0);
  const jurosAtuais = jurosBase + jurosPendentes + jurosAdicionais;

  const jurosPagos = Math.min(valorNum, jurosAtuais);

  const dataFormatada = (() => {
    try {
      if (!dataPagoISO) return new Date().toLocaleDateString('pt-BR');
      const dt = new Date(dataPagoISO);
      return isNaN(dt.getTime())
        ? new Date().toLocaleDateString('pt-BR')
        : dt.toLocaleDateString('pt-BR');
    } catch {
      return new Date().toLocaleDateString('pt-BR');
    }
  })();

  const novaExplicacao = `📌 No dia ${dataFormatada}, foram pagos os juros de R$ ${jurosPagos.toFixed(
    2
  )} da parcela ${p.numero}. Parcela adiada 1 mês e parcelas futuras ajustadas. Juros adicionais remanescentes foram somados aos juros pendentes.`;

  const explicacaoAcumulada = p.explicacao
    ? `${p.explicacao}\n${novaExplicacao}`
    : novaExplicacao;

  const updates = [];

  // Regra importante:
  // Aqui, por definicao do fluxo, o frontend garantiu que valorNum == jurosAtuais
  // (juros base + pendentes + adicionais). Depois do pagamento:
  // - abate na ordem: adicionais -> pendentes -> base
  // - o resto de (pendentes + base) volta para juros_pendentes
  // - o resto do manual permanece em juros_adicionais
  // - o valor_total volta para capital + juros_base (sem inflar por adicionais)
  const capitalAtual = Number(p.valor_capital || 0);
  let restante = Number(valorNum || 0);
  const novoJurosAdicionais = Math.max(0, Number(jurosAdicionais) - restante);
  restante = Math.max(0, restante - Number(jurosAdicionais || 0));
  const pendentesDepois = Math.max(0, Number(jurosPendentes || 0) - restante);
  restante = Math.max(0, restante - Number(jurosPendentes || 0));
  const baseDepois = Math.max(0, Number(jurosBase || 0) - restante);
  const novoJurosPendentes = Number(
    (pendentesDepois + baseDepois + novoJurosAdicionais).toFixed(2)
  );
  const novoValorTotal = Number((capitalAtual + jurosBase).toFixed(2));

  const emprestimoId = p.emprestimo_id || (parcelas[0] && parcelas[0].emprestimo_id) || null;
  const fixedDay = await resolveFixedDay(emprestimoId, parcelas, dbHandle);
  let baseDateForCurrent = p.vencimento ? new Date(p.vencimento) : new Date();
  if (isNaN(baseDateForCurrent.getTime())) baseDateForCurrent = new Date();
  const desiredDayCurrent = Number.isFinite(fixedDay) ? fixedDay : baseDateForCurrent.getDate();
  const novaDataAtual = addMonthsSafe(baseDateForCurrent, 1, desiredDayCurrent);
  const novaISOAtual = formatISODate(novaDataAtual);

  // Parcela atual: juros base mantido, pendentes/adicionais ajustados, total ajustado
  updates.push({
    id: p.id,
    valor_pago:
      p.valor_pago != null ? Number(Number(p.valor_pago).toFixed(2)) : 0,
    valor_excedente: p.valor_excedente || 0,
    data_pagamento: null, // continua sem "pagar" a parcela em si
    pago: false,
    valor_total: novoValorTotal,
    valor_capital: capitalAtual,
    valor_juros: jurosBase,
    juros_pendentes: novoJurosPendentes,
    juros_adicionais: 0,
    observacao: observacao || null,
    explicacao: explicacaoAcumulada,
    tipo_pagamento: 'pagamento_juros',
    vencimento: novaISOAtual,
  });

  let previousNewDate = novaDataAtual;

  const desiredDayPerParcela = (parcel) => {
    if (!parcel || !parcel.vencimento) return null;
    const d = new Date(parcel.vencimento);
    return isNaN(d.getTime()) ? null : d.getDate();
  };

  // Demais parcelas: só empurrar vencimento + explicar
  for (let i = atualIndex + 1; i < parcelas.length; i++) {
    const q = parcelas[i];
    if (!q) continue;

    if (q.pago === 1 || q.pago === true) {
      updates.push({
        id: q.id,
        valor_pago: q.valor_pago,
        valor_excedente: q.valor_excedente || 0,
        data_pagamento: q.data_pagamento || null,
        pago: q.pago,
        valor_total: q.valor_total,
        valor_capital: q.valor_capital,
        valor_juros: q.valor_juros,
        juros_pendentes: q.juros_pendentes, // mantém o que já tinha
        juros_adicionais: q.juros_adicionais,
        observacao: q.observacao || null,
        explicacao: q.explicacao || null,
        tipo_pagamento: q.tipo_pagamento || null,
        vencimento: q.vencimento || null,
      });
      continue;
    }

    const desiredDay = Number.isFinite(fixedDay)
      ? fixedDay
      : (desiredDayPerParcela(q) || previousNewDate.getDate());
    const novaDate = addMonthsSafe(previousNewDate, 1, desiredDay);
    const novaISO = formatISODate(novaDate);

    const vencOriginalStr = `${previousNewDate.getDate()} ${
      mesesPt[previousNewDate.getMonth()]
    } ${previousNewDate.getFullYear()}`;
    const novaVencStr = `${novaDate.getDate()} ${
      mesesPt[novaDate.getMonth()]
    } ${novaDate.getFullYear()}`;

    const explicacaoAdj =
      q.explicacao && q.explicacao.length > 0
        ? `${q.explicacao}\n➡️ Vencimento adiado de ${vencOriginalStr} para ${novaVencStr} devido ao pagamento de juros da parcela ${p.numero}.`
        : `➡️ Vencimento adiado de ${vencOriginalStr} para ${novaVencStr} devido ao pagamento de juros da parcela ${p.numero}.`;

    updates.push({
      id: q.id,
      valor_pago: q.valor_pago,
      valor_excedente: q.valor_excedente || 0,
      data_pagamento: q.data_pagamento || null,
      pago: q.pago,
      valor_total: q.valor_total,
      valor_capital: q.valor_capital,
      valor_juros: q.valor_juros,
      juros_pendentes: q.juros_pendentes,
      juros_adicionais: q.juros_adicionais,
      observacao: q.observacao || null,
      explicacao: explicacaoAdj,
      tipo_pagamento: q.tipo_pagamento || null,
      vencimento: novaISO,
    });

    previousNewDate = novaDate;
  }

  return updates;
};
