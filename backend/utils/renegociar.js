const db = require('../models/database'); 
const gerarParcelas = require('./gerarParcelas');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function renegociarEmprestimo({
  emprestimoId,
  novoCapital,
  novaQtdParcelas,
  novaTaxaJuros,
  dataInicio,
  diaPagamento
}) {
  console.log('>> Entrou na função renegociarEmprestimo');
  console.log('[DEBUG] emprestimoId:', emprestimoId);

  try {
    await runAsync('BEGIN TRANSACTION');

    // Buscar parcelas antigas não pagas
    const parcelasAntigas = await allAsync(
      `SELECT id as parcela_id, emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, pago, data_pagamento
       FROM parcelas
       WHERE emprestimo_id = ? AND pago = 0`,
      [emprestimoId]
    );

    console.log(`[INFO] Encontradas ${parcelasAntigas.length} parcelas não pagas para renegociar.`);

    // Somar tudo que já foi pago nessas parcelas
    let totalPago = 0;
    let totalExcedente = 0;

    for (const p of parcelasAntigas) {
      totalPago += p.valor_pago || 0;
      totalExcedente += p.valor_excedente || 0;

      await runAsync(
        `INSERT INTO parcelas_originais
         (parcela_id, emprestimo_id, numero, valor_total, valor_capital, valor_juros, valor_pago, valor_excedente, pago, data_pagamento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.parcela_id,
          p.emprestimo_id,
          p.numero,
          p.valor_total,
          p.valor_capital,
          p.valor_juros,
          p.valor_pago,
          p.valor_excedente,
          p.pago,
          p.data_pagamento || null
        ]
      );
    }

    const menorNumeroOriginal = parcelasAntigas.length > 0
      ? Math.min(...parcelasAntigas.map(p => p.numero))
      : null;

    // Deletar as parcelas antigas
    await runAsync(
      `DELETE FROM parcelas WHERE emprestimo_id = ? AND pago = 0`,
      [emprestimoId]
    );

    console.log('[INFO] Parcelas antigas deletadas com sucesso.');

    // Atualiza o empréstimo
    const novoCapitalAposPagos = novoCapital - totalPago;

    await runAsync(
      `UPDATE emprestimos
       SET valor = ?, capital_restante = ?, taxa_juros = ?
       WHERE id = ?`,
      [novoCapital, novoCapitalAposPagos, novaTaxaJuros, emprestimoId]
    );

    // Gerar novas parcelas com base no valor total
    const novasParcelas = gerarParcelas({
      capital: novoCapital,
      taxa_juros: novaTaxaJuros,
      qtdParcelas: novaQtdParcelas,
      dataInicio,
      diaPagamento
    });

    console.log(`[INFO] Geradas ${novasParcelas.length} novas parcelas.`);

    let saldoPago = totalPago;

    for (const parcela of novasParcelas) {
      let valorPago = 0;
      let valorExcedente = 0;

      if (saldoPago > 0) {
        if (saldoPago >= parcela.valor_total) {
          valorPago = parcela.valor_total;
          valorExcedente = 0;
          saldoPago -= parcela.valor_total;
        } else {
          valorPago = saldoPago;
          valorExcedente = 0;
          saldoPago = 0;
        }
      }

      await runAsync(
        `INSERT INTO parcelas 
          (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, parcela_origem_numero, valor_pago, valor_excedente, pago)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          emprestimoId,
          parcela.numero,
          parcela.valor_total,
          parcela.valor_capital,
          parcela.valor_juros,
          parcela.vencimento,
          menorNumeroOriginal,
          valorPago,
          valorExcedente,
          valorPago >= parcela.valor_total ? 1 : 0
        ]
      );
    }

    await runAsync('COMMIT');
    console.log('[SUCESSO] Renegociação concluída com sucesso.');

    return { sucesso: true, novasParcelas };
  } catch (e) {
    await runAsync('ROLLBACK');
    console.error('[ERRO] renegociarEmprestimo:', e);
    throw e;
  }
}

module.exports = {
  renegociarEmprestimo
};