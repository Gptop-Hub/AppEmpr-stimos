// backend/utils/desconto_proxima.js
const db = require('../models/database');

/**
 * Aplica desconto em TODAS as próximas parcelas até consumir o excedente.
 * Retorna updates para a tabela parcelas.
 * Agora mantém valor_capital e valor_juros intactos.
 */
module.exports = async function aplicarDescontoProxima(parcelas, atualIndex, valor, data, observacao) {
  const updates = [];

  const valorNum = typeof valor === 'number' ? valor : parseFloat(String(valor).replace(',', '.')) || 0;
  const valorPagoAtual = Number(valorNum.toFixed(2));

  const atual = parcelas[atualIndex];
  if (!atual) return updates;

  const valorTotalAtual = Number(atual.valor_total || 0);
  const excedenteInicial = Number((valorPagoAtual - valorTotalAtual).toFixed(2));
  const excedenteAplicavel = excedenteInicial > 0 ? excedenteInicial : 0;

  // Atualiza parcela atual
  updates.push({
    id: atual.id,
    valor_pago: valorPagoAtual,
    valor_excedente: excedenteAplicavel,
    data_pagamento: data,
    pago: valorPagoAtual >= valorTotalAtual ? 1 : 0,
    valor_total: valorTotalAtual,
    valor_capital: atual.valor_capital, // mantém intacto
    valor_juros: atual.valor_juros,     // mantém intacto
    observacao: observacao || atual.observacao || '',
    explicacao: null,
    tipo_pagamento: 'desconto_proxima'
  });

  if (excedenteAplicavel <= 0) return updates;

  // Formata data para explicação
  let dataFormatada = '';
  try {
    dataFormatada = data ? new Date(data).toLocaleDateString('pt-BR') : '';
  } catch {
    dataFormatada = data || '';
  }

  // Aplica excedente nas próximas parcelas
  let excedente = excedenteAplicavel;

  for (let i = atualIndex + 1; i < parcelas.length && excedente > 0; i++) {
    const prox = parcelas[i];
    if (!prox) continue;

    const valorTotalOrig = Number(prox.valor_total || 0);
    const valorPagoOrig = Number(prox.valor_pago || 0);
    if (valorPagoOrig >= valorTotalOrig) continue; // já quitada

    const novoValorTotalRaw = Number((valorTotalOrig - excedente).toFixed(2));
    const novoValorTotal = novoValorTotalRaw < 0 ? 0 : novoValorTotalRaw;
    const descontoAplicado = Number((valorTotalOrig - novoValorTotal).toFixed(2));

    const pagoDepois = (valorPagoOrig >= novoValorTotal) ? 1 : 0;
    const dataPagamentoDepois = pagoDepois ? data : prox.data_pagamento;

    const valorDescontoStr = descontoAplicado.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
    const explicacao = `📌 Desconto de ${valorDescontoStr} aplicado nesta parcela devido ao excedente da parcela ${atual.numero}${dataFormatada ? ` (pagamento em ${dataFormatada})` : ''}.`;

    updates.push({
      id: prox.id,
      valor_total: novoValorTotal,
      valor_capital: prox.valor_capital, // mantém intacto
      valor_juros: prox.valor_juros,     // mantém intacto
      observacao: prox.observacao || '',
      explicacao,
      valor_pago: prox.valor_pago || 0,
      pago: pagoDepois,
      data_pagamento: dataPagamentoDepois,
      valor_excedente: 0,
      tipo_pagamento: null
    });

    excedente = novoValorTotalRaw < 0 ? Number(Math.abs(novoValorTotalRaw).toFixed(2)) : 0;
  }

  return updates;
};