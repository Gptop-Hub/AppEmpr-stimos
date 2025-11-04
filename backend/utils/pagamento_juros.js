// utils/pagamento_juros.js
const { formatISODate, addMonthsSafe } = (() => {
  function pad(n) { return String(n).padStart(2, '0'); }

  function formatISODate(d) {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  function addMonthsSafe(dateLike, months, desiredDay) {
    if (!dateLike) return null;
    const base = new Date(dateLike);
    if (isNaN(base.getTime())) return null;

    const targetYear = base.getFullYear() + Math.floor((base.getMonth() + months) / 12);
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
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

module.exports = async function aplicarPagamentoJuros(parcelas = [], atualIndex = 0, valor = 0, dataPagoISO = null, observacao = '') {
  const p = parcelas[atualIndex];
  if (!p) return [];

  const valorNum = Number(valor || 0);
  const jurosOriginais = Number(p.original_valor_juros ?? p.valor_juros ?? 0);
  const jurosPagos = Math.min(valorNum, jurosOriginais);

  const dataFormatada = (() => {
    try {
      if (!dataPagoISO) return new Date().toLocaleDateString('pt-BR');
      const dt = new Date(dataPagoISO);
      return isNaN(dt.getTime()) ? new Date().toLocaleDateString('pt-BR') : dt.toLocaleDateString('pt-BR');
    } catch {
      return new Date().toLocaleDateString('pt-BR');
    }
  })();

  const novaExplicacao = `📌 No dia ${dataFormatada}, foram pagos os juros de R$ ${jurosPagos.toFixed(2)} da parcela ${p.numero}. Parcela adiada 1 mês e parcelas futuras ajustadas.`;

  const explicacaoAcumulada = p.explicacao
    ? `${p.explicacao}\n${novaExplicacao}`
    : novaExplicacao;

  const updates = [];

  let baseDateForCurrent = p.vencimento ? new Date(p.vencimento) : new Date();
  if (isNaN(baseDateForCurrent.getTime())) baseDateForCurrent = new Date();
  const desiredDayCurrent = baseDateForCurrent.getDate();
  const novaDataAtual = addMonthsSafe(baseDateForCurrent, 1, desiredDayCurrent);
  const novaISOAtual = formatISODate(novaDataAtual);

  // 🔹 Aqui mantemos o valor de juros original para exibição
  updates.push({
    id: p.id,
    valor_pago: p.valor_pago != null ? Number(Number(p.valor_pago).toFixed(2)) : 0,
    valor_excedente: p.valor_excedente || 0,
    data_pagamento: null,
    pago: false,
    valor_total: p.valor_total,
    valor_capital: p.valor_capital,
    valor_juros: jurosOriginais, // mantém o valor original para visualização
    observacao: observacao || null,
    explicacao: explicacaoAcumulada,
    tipo_pagamento: 'pagamento_juros',
    vencimento: novaISOAtual
  });

  let previousNewDate = novaDataAtual;

  const desiredDayPerParcela = (parcel) => {
    if (!parcel || !parcel.vencimento) return null;
    const d = new Date(parcel.vencimento);
    return isNaN(d.getTime()) ? null : d.getDate();
  };

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
        valor_juros: q.valor_juros ?? q.original_valor_juros, // mantém visível
        observacao: q.observacao || null,
        explicacao: q.explicacao || null,
        tipo_pagamento: q.tipo_pagamento || null,
        vencimento: q.vencimento || null
      });
      continue;
    }

    const desiredDay = desiredDayPerParcela(q) || previousNewDate.getDate();
    const novaDate = addMonthsSafe(previousNewDate, 1, desiredDay);
    const novaISO = formatISODate(novaDate);

    const vencOriginalStr = `${previousNewDate.getDate()} ${mesesPt[previousNewDate.getMonth()]} ${previousNewDate.getFullYear()}`;
    const novaVencStr = `${novaDate.getDate()} ${mesesPt[novaDate.getMonth()]} ${novaDate.getFullYear()}`;

    const explicacaoAdj = (q.explicacao && q.explicacao.length > 0)
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
      valor_juros: q.valor_juros ?? q.original_valor_juros, // mantém visível
      observacao: q.observacao || null,
      explicacao: explicacaoAdj,
      tipo_pagamento: q.tipo_pagamento || null,
      vencimento: novaISO
    });

    previousNewDate = novaDate;
  }

  return updates;
};