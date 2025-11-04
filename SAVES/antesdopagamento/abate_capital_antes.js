// backend/utils/pagamento_abate_capital.js 
const db = require('../models/database');

module.exports = async function pagamentoAbateCapital({ emprestimo_id, parcelaAtual, valorPago, data, observacao }) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM parcelas WHERE emprestimo_id = ? ORDER BY numero ASC`,
      [emprestimo_id],
      (err, parcelas) => {
        if (err) return reject(err);

        let atual = parcelas.find(p => p.id === parcelaAtual);
        if (!atual) return reject(new Error('Parcela atual não encontrada.'));

        const updates = [];

        // ✅ Modificado aqui: registra o valor total pago na parcela
        const novoPagoAtual = +valorPago.toFixed(2);  // <-- linha modificada
        let restante = +(valorPago - atual.valor_total).toFixed(2); // <-- linha modificada
        const quitouAtual = novoPagoAtual >= atual.valor_total;

        updates.push({
          ...atual,
          valor_pago: novoPagoAtual,
          pago: quitouAtual ? 1 : 0,
          data_pagamento: data,
          observacao: observacao || atual.observacao || '',
          valor_excedente: restante > 0 ? restante : 0,
          tipo_pagamento: 'abate_capital'
        });

        if (!quitouAtual || restante <= 0) {
          return aplicarUpdates(db, updates, resolve, reject);
        }

        // Abate capital nas últimas parcelas (de trás pra frente)
        const ultima = parcelas[parcelas.length - 1];
        const taxa = ultima.valor_capital > 0
          ? +(ultima.valor_juros / ultima.valor_capital).toFixed(6)
          : 0;

        for (let i = parcelas.length - 1; i >= 0 && restante > 0; i--) {
          const p = parcelas[i];
          if (p.id === atual.id || p.pago || p.valor_capital <= 0) continue;

          const abatimento = Math.min(restante, p.valor_capital);
          const capitalOriginal = p.valor_capital;
          const novoCapital = +(p.valor_capital - abatimento).toFixed(2);
          const novoJuros = +(novoCapital * taxa).toFixed(2);
          const novoTotal = +(novoCapital + novoJuros).toFixed(2);
          const totalOriginal = +(p.valor_total).toFixed(2);

          const dataFormatada = new Date(data).toLocaleDateString('pt-BR');
          const novaExplicacao =
            `📌 [${dataFormatada}] R$ ${abatimento.toFixed(2)} excedente da parcela ${atual.numero} foi abatido no capital da parcela ${p.numero}.\n` +
            `➡️ Capital antes: R$ ${capitalOriginal.toFixed(2)} | Capital atual: R$ ${novoCapital.toFixed(2)}\n` +
            `🧮 Total antes: R$ ${totalOriginal.toFixed(2)} | Total atual: R$ ${novoTotal.toFixed(2)}\n`;

          const explicacaoAnterior = p.explicacao || '';
          const explicacaoFinal = explicacaoAnterior
            ? `${explicacaoAnterior.trim()}\n\n${novaExplicacao.trim()}`
            : novaExplicacao.trim();

          updates.push({
            ...p,
            valor_capital: novoCapital,
            valor_juros: novoJuros,
            valor_total: novoTotal,
            observacao: '',
            explicacao: explicacaoFinal,
            tipo_pagamento: 'abate_capital'
          });

          restante = +(restante - abatimento).toFixed(2);
        }

        aplicarUpdates(db, updates, resolve, reject);
      }
    );
  });
};

function aplicarUpdates(db, updates, resolve, reject) {
  db.serialize(() => {
    const stmt = db.prepare(`
      UPDATE parcelas SET 
        valor_capital   = ?,
        valor_juros     = ?,
        valor_total     = ?,
        valor_pago      = ?,
        valor_excedente = ?,
        data_pagamento  = ?,
        pago            = ?,
        observacao      = ?,
        explicacao      = ?,
        tipo_pagamento  = ?
      WHERE id = ?
    `);

    for (const p of updates) {
      stmt.run([
        p.valor_capital,
        p.valor_juros,
        p.valor_total,
        p.valor_pago      || 0,
        p.valor_excedente || 0,
        p.data_pagamento  || null,
        p.pago            || 0,
        p.observacao      || '',
        p.explicacao      || '',
        p.tipo_pagamento  || '',
        p.id
      ]);
    }

    stmt.finalize(err => {
      if (err) return reject(err);
      resolve(updates);
    });
  });
}