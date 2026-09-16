const db = require('../models/database'); 
const gerarParcelas = require('./gerarParcelas');
const { touchAtividade } = require('./touchAtividade');

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

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
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
  console.log('>> Entrou na funÃ§Ã£o renegociarEmprestimo');
  console.log('[DEBUG] emprestimoId:', emprestimoId);

  try {
    await runAsync('BEGIN TRANSACTION');

    const empRow = await getAsync(
      'SELECT versao_atual FROM emprestimos WHERE id = ?',
      [emprestimoId]
    );
    const versaoAtual = Number(
      empRow && empRow.versao_atual ? empRow.versao_atual : 1
    );

    // Buscar parcelas antigas nÃ£o pagas
    const parcelasAntigas = await allAsync(
      `SELECT p.id as parcela_id, p.emprestimo_id, p.numero, p.valor_total, p.valor_capital, p.valor_juros, p.valor_pago, p.valor_excedente, p.pago, p.data_pagamento
         FROM parcelas p
         JOIN emprestimos e ON e.id = p.emprestimo_id
        WHERE p.emprestimo_id = ?
          AND (p.versao IS NULL OR p.versao = e.versao_atual)
          AND p.pago = 0`,
      [emprestimoId]
    );

    console.log(`[INFO] Encontradas ${parcelasAntigas.length} parcelas nÃ£o pagas para renegociar.`);

    // Somar tudo que jÃ¡ foi pago nessas parcelas
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
      `DELETE FROM parcelas
       WHERE emprestimo_id = ?
         AND (versao IS NULL OR versao = (SELECT versao_atual FROM emprestimos WHERE id = ?))
         AND pago = 0`,
      [emprestimoId, emprestimoId]
    );

    console.log('[INFO] Parcelas antigas deletadas com sucesso.');

    // Atualiza o emprÃ©stimo
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

    for (const parcela of novasParcelas) {
      const valorPago = 0;
      const valorExcedente = 0;
      const pagoFlag = 0;

      await runAsync(
        `INSERT INTO parcelas 
          (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, parcela_origem_numero, valor_pago, valor_excedente, pago, versao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          pagoFlag,
          versaoAtual
        ]
      );
    }

    await runAsync('COMMIT');
    try {
      await touchAtividade({ emprestimoId });
    } catch (touchErr) {
      console.error('[touchAtividade] renegociar:', touchErr);
    }
    console.log('[SUCESSO] RenegociaÃ§Ã£o concluÃ­da com sucesso.');

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

