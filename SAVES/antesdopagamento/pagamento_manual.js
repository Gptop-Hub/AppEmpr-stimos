// backend/routes/pagamento_manual.js
const express = require('express');
const router = express.Router();
const db = require('../../backend/models/database');

// helpers promisificados
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

/**
 * POST /pagamentos/manual
 * body: {
 *   emprestimo_id,
 *   valor_pago,                // número
 *   abatimentos: [            // lista na ordem feita pelo usuário
 *     { parcela_id, tipo, valor } // tipo: 'capital' | 'juros' | 'parcela'
 *   ],
 *   data (opcional ISO string),
 *   observacao (opcional)
 * }
 */
router.post('/', async (req, res) => {
  const { emprestimo_id, valor_pago, abatimentos, data, observacao } = req.body;

  if (!emprestimo_id || !valor_pago || !Array.isArray(abatimentos)) {
    return res.status(400).json({ erro: 'Parâmetros inválidos. Envie emprestimo_id, valor_pago e abatimentos[]' });
  }

  // soma dos abatimentos (numérico)
  const soma = abatimentos.reduce((s, a) => s + Number(a.valor || 0), 0);
  if (Math.abs(Number(soma.toFixed(2)) - Number(Number(valor_pago).toFixed(2))) > 0.01) {
    return res.status(400).json({ erro: 'Soma dos abatimentos não confere com valor_pago' });
  }

  const dataISO = data || new Date().toISOString();

  try {
    await runAsync('BEGIN TRANSACTION');

    // registra o pagamento
    const ins = await runAsync(
      'INSERT INTO pagamentos (emprestimo_id, valor, data, tipo_pagamento, observacao) VALUES (?, ?, ?, ?, ?)',
      [emprestimo_id, Number(valor_pago), dataISO, 'manual', observacao || '']
    );
    const pagamentoId = ins.lastID;

    // aplica cada abatimento
    for (const a of abatimentos) {
      const parcelaId = a.parcela_id;
      const tipo = a.tipo;
      const valorAbat = Number(a.valor || 0);

      const parcela = await getAsync('SELECT * FROM parcelas WHERE id = ?', [parcelaId]);
      if (!parcela) throw new Error(`Parcela ${parcelaId} não encontrada`);

      // valores atuais
      let capital = Number(parcela.valor_capital || 0);
      let juros = Number(parcela.valor_juros || 0);
      let valorPagoAnterior = Number(parcela.valor_pago || 0);

      if (tipo === 'capital') {
        capital = Number(Math.max(0, capital - valorAbat).toFixed(2));
      } else if (tipo === 'juros') {
        juros = Number(Math.max(0, juros - valorAbat).toFixed(2));
      } else {
        // tipo 'parcela' -> abate proporcional entre capital e juros conforme proporção original
        const totalOrig = Number(parcela.valor_capital || 0) + Number(parcela.valor_juros || 0);
        if (totalOrig > 0) {
          const capRatio = Number(parcela.valor_capital || 0) / totalOrig;
          const abatCap = Number((valorAbat * capRatio).toFixed(2));
          const abatJuros = Number((valorAbat - abatCap).toFixed(2));
          capital = Number(Math.max(0, capital - abatCap).toFixed(2));
          juros = Number(Math.max(0, juros - abatJuros).toFixed(2));
        } else {
          // se totalOrig == 0, tenta reduzir juros primeiro (defensivo)
          juros = Number(Math.max(0, juros - valorAbat).toFixed(2));
        }
      }

      const novoTotal = Number((capital + juros).toFixed(2));
      const novoValorPago = Number((valorPagoAnterior + valorAbat).toFixed(2));
      const pago = novoValorPago >= novoTotal ? 1 : 0;
      // define data_pagamento: se houve ao menos um pagamento, anotar data; se parcela ficou paga, usar data de pagamento
      const dataPagamento = novoValorPago > 0 ? dataISO : parcela.data_pagamento;

      await runAsync(
        `UPDATE parcelas 
         SET valor_capital = ?, valor_juros = ?, valor_total = ?, valor_pago = ?, pago = ?, data_pagamento = ?, valor_excedente = ?
         WHERE id = ?`,
        [capital, juros, novoTotal, novoValorPago, pago, dataPagamento, 0, parcelaId]
      );
    }

    await runAsync('COMMIT');
    return res.json({ success: true, pagamentoId });
  } catch (err) {
    try { await runAsync('ROLLBACK'); } catch (e) {}
    console.error('Erro pagamento manual:', err);
    return res.status(500).json({ erro: err.message || 'Erro ao aplicar pagamento manual' });
  }
});

module.exports = router;