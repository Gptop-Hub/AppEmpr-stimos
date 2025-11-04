module.exports = function aplicarPagamentoNormal(parcelas, atualIndex, valor, data, observacao) {
  let restante = valor;
  const updates = [];

  for (let i = atualIndex; i < parcelas.length && restante > 0; i++) {
    const p = parcelas[i];
    const novoValorPago = (p.valor_pago || 0) + restante;
    const pago = novoValorPago >= p.valor_total ? 1 : 0;

    updates.push({
      id: p.id,
      valor_pago: novoValorPago,
      valor_excedente: 0,
      data_pagamento: data,
      pago,
      valor_total: p.valor_total,
      valor_capital: p.valor_capital,
      valor_juros: p.valor_juros,
      observacao: observacao || p.observacao || '',
      tipo_pagamento: 'normal'
    });

    restante = 0; // Encerra o loop pois já usamos o valor todo
    break;
  }

  return updates;
};