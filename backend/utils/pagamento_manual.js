// backend/utils/pagamento_manual.js
const db = require('../models/database');

/**
 * Aplica pagamentos manuais nas parcelas de um empréstimo.
 *
 * Aceita abatimentos no formato:
 *  - { parcelaId, abatidoCapital, abatidoJuros, abatidoTotal }
 * ou
 *  - { parcelaId, abatCapital, abatJuros, abatParcela }
 *
 * Regras:
 *  - Se abatidoTotal (abatParcela) > 0, ele é aplicado sozinho (ignora abatCapital/abatJuros).
 *  - Caso contrário, aplica abatCapital e abatJuros separadamente.
 */
async function pagamentoManual(emprestimoId, valorPagamento, abatimentos, dataPagamento) {
  if (!Array.isArray(abatimentos)) abatimentos = [];

  let saldoCliente = Number(Number(valorPagamento || 0).toFixed(2));
  const updates = [];

  for (const itemRaw of abatimentos) {
    if (saldoCliente <= 0) break;

    const parcelaId = itemRaw.parcelaId || itemRaw.id;
    if (!parcelaId) continue;

    // Normaliza campos vindos do frontend
    const rawAbatParcela = Number(itemRaw.abatParcela ?? itemRaw.abatidoTotal ?? itemRaw.total ?? 0);
    const rawAbatCapital = Number(itemRaw.abatCapital ?? itemRaw.abatidoCapital ?? itemRaw.capital ?? 0);
    const rawAbatJuros = Number(itemRaw.abatJuros ?? itemRaw.abatidoJuros ?? itemRaw.juros ?? 0);

    const parcela = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM parcelas WHERE id = ? AND emprestimo_id = ?`, [parcelaId, emprestimoId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!parcela) continue;

    let novoCapital = Number(parcela.valor_capital || 0);
    let novoJuros = Number(parcela.valor_juros || 0);
    let novoTotal = Number(parcela.valor_total || 0);
    let valorPagoParcela = Number(parcela.valor_pago || 0);

    // Limita cada abatimento ao que faz sentido
    const abatParcReal = Math.min(rawAbatParcela, saldoCliente, novoTotal);
    const abatCapReal = Math.min(rawAbatCapital, saldoCliente, novoCapital);
    const abatJurReal = Math.min(rawAbatJuros, saldoCliente, novoJuros);

    // DECISÃO IMPORTANTE: se abatParcReal > 0, vamos aplicá-lo *apenas* (não somar também capital+juros)
    let aplicadoParcela = 0;
    let aplicadoCapital = 0;
    let aplicadoJuros = 0;

    if (abatParcReal > 0) {
      aplicadoParcela = abatParcReal;
    } else {
      aplicadoCapital = abatCapReal;
      aplicadoJuros = abatJurReal;
    }

    const totalAplicado = Number((aplicadoParcela + aplicadoCapital + aplicadoJuros).toFixed(2));

    // Deduz do saldo do cliente
    saldoCliente = Number((saldoCliente - totalAplicado).toFixed(2));

    // Aplica nas somas da parcela
    if (aplicadoParcela > 0) {
      novoTotal -= aplicadoParcela;
      valorPagoParcela += aplicadoParcela;
    }
    if (aplicadoCapital > 0) {
      novoCapital -= aplicadoCapital;
      novoTotal -= aplicadoCapital;
      valorPagoParcela += aplicadoCapital;
    }
    if (aplicadoJuros > 0) {
      novoJuros -= aplicadoJuros;
      novoTotal -= aplicadoJuros;
      valorPagoParcela += aplicadoJuros;
    }

    // nunca deixar negativo
    novoCapital = Number(Math.max(0, Number(novoCapital)).toFixed(2));
    novoJuros = Number(Math.max(0, Number(novoJuros)).toFixed(2));
    novoTotal = Number(Math.max(0, Number(novoTotal)).toFixed(2));
    valorPagoParcela = Number(Math.min(valorPagoParcela, (parcela.valor_total || 0)).toFixed(2));

    const pago = novoTotal <= 0 ? 1 : 0;

    // Atualiza banco
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE parcelas 
         SET valor_total = ?, valor_capital = ?, valor_juros = ?, valor_pago = ?, pago = ?, data_pagamento = ? 
         WHERE id = ?`,
        [novoTotal.toFixed(2), novoCapital.toFixed(2), novoJuros.toFixed(2), valorPagoParcela.toFixed(2), pago, dataPagamento, parcelaId],
        (err) => (err ? reject(err) : resolve())
      );
    });

    updates.push({
      id: parcelaId,
      valor_total: novoTotal,
      valor_capital: novoCapital,
      valor_juros: novoJuros,
      valor_pago: valorPagoParcela,
      pago
    });
  }

  return { saldoRestante: Number(saldoCliente.toFixed(2)), parcelasAtualizadas: updates };
}

module.exports = pagamentoManual;