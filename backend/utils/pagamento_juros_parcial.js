// backend/utils/pagamento_juros_parcial.js
const db = require('../models/database');

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

const f2 = (n) => Number(Number(n || 0).toFixed(2));

module.exports = async function pagarJurosParcial(
  emprestimoId,
  valorPagamento,
  dataPagamentoISO,
  observacaoParcela = ''
) {
  if (!emprestimoId) throw new Error('emprestimoId inválido');

  const valor = f2(valorPagamento || 0);
  if (valor <= 0) throw new Error('Valor de pagamento inválido');

  await runAsync('BEGIN');

  try {
    // 1 — pegar primeiro parcela aberta
    const parcela = await getAsync(
      `SELECT * FROM parcelas 
       WHERE emprestimo_id = ? AND (pago IS NULL OR pago = 0)
       ORDER BY numero ASC
       LIMIT 1`,
      [emprestimoId]
    );

    if (!parcela) throw new Error('Nenhuma parcela aberta para juros parcial.');

    const id = parcela.id;
    const jurosAtual = f2(parcela.valor_juros || 0);
    const capitalAtual = f2(parcela.valor_capital || 0);
    const valor_total = f2(parcela.valor_total || 0);

    if (valor >= jurosAtual)
      throw new Error('Valor não é juros parcial (>= juros da parcela).');

    // 2 — calcular juros pendentes
    const jurosPagos = valor;
    const jurosFaltantes = f2(jurosAtual - jurosPagos);

    // 3 — atualizar parcela
    const novoValorJuros = f2(jurosAtual); // juros base permanece
    const novoJurosAdicional = f2(
      (parcela.juros_adicionais || 0) + jurosFaltantes
    );
    const novoValorTotal = f2(capitalAtual + novoValorJuros + novoJurosAdicional);

    const dataFormatada = (() => {
      try {
        const dt = new Date(dataPagamentoISO);
        return isNaN(dt.getTime())
          ? new Date().toLocaleDateString('pt-BR')
          : dt.toLocaleDateString('pt-BR');
      } catch {
        return new Date().toLocaleDateString('pt-BR');
      }
    })();

    const explic = `Pagamento parcial de juros: cliente pagou R$ ${jurosPagos} em ${dataFormatada}. Restaram R$ ${jurosFaltantes}, somados como juros adicionais.`;

    await runAsync(
      `UPDATE parcelas
         SET valor_juros = ?,
             juros_adicionais = ?,
             valor_total = ?,
             pago = 0,
             data_pagamento = NULL,
             tipo_pagamento = 'manual_juros_parcial',
             explicacao = CASE 
                 WHEN explicacao IS NULL OR explicacao = '' THEN ?
                 ELSE explicacao || '\n' || ?
             END
       WHERE id = ?`,
      [
        novoValorJuros,
        novoJurosAdicional,
        novoValorTotal,
        explic,
        explic,
        id
      ]
    );

    // 4 — recalcular capital_restante do empréstimo
    const abertas = await allAsync(
      `SELECT valor_capital FROM parcelas 
       WHERE emprestimo_id = ? AND (pago IS NULL OR pago = 0)`,
      [emprestimoId]
    );

    const novoCapitalRestante = f2(
      abertas.reduce((s, p) => s + f2(p.valor_capital), 0)
    );

    await runAsync(
      `UPDATE emprestimos SET capital_restante = ? WHERE id = ?`,
      [novoCapitalRestante, emprestimoId]
    );

    await runAsync('COMMIT');

    return {
      ok: true,
      parcelaAtualizada: {
        id,
        valor_juros: novoValorJuros,
        juros_adicionais: novoJurosAdicional,
        valor_total: novoValorTotal,
        capital: capitalAtual,
        juros_pagados: jurosPagos,
        juros_pendentes: jurosFaltantes
      }
    };
  } catch (e) {
    try { await runAsync('ROLLBACK'); } catch {}
    throw e;
  }
};