// backend/utils/pagamento_manual.js
const db = require('../models/database');

// Promises helpers
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

/**
 * pagamentoManual
 * Aplica abatimentos manualmente nas parcelas de um empréstimo.
 * Regras:
 *  - Se vier "abatParcela" (>0): aplica primeiro nos JUROS remanescentes, depois no CAPITAL.
 *  - Caso contrário, usa "abatJuros" e "abatCapital" respeitando saldos.
 *  - Atualiza data_pagamento somente quando a parcela for quitada (pago=1).
 *  - Nunca deixa números negativos.
 *
 * IMPORTANTE (novo comportamento):
 *  - O valor TOTAL pago pelo cliente (valorPagamento) é registrado em valor_pago
 *    APENAS NA PRIMEIRA PARCELA AFETADA.
 *  - As demais parcelas têm apenas capital/juros/valor_total ajustados, sem
 *    receber valor_pago extra. Assim:
 *      • a parcela de origem mostra o valor completo (ex.: 2.000)
 *      • as próximas apenas têm capital reduzido (adiantamento), sem "Valor Pago".
 *
 * @param {number} emprestimoId
 * @param {number} valorPagamento - valor total entregue pelo cliente
 * @param {Array<{parcelaId:number, abatParcela?:number, abatJuros?:number, abatCapital?:number}>} abatimentos
 * @param {string} dataPagamento - "YYYY-MM-DD"
 * @returns {Promise<{ saldoRestante:number, parcelasAtualizadas:Array }>}
 */
async function pagamentoManual(emprestimoId, valorPagamento, abatimentos, dataPagamento) {
  if (!emprestimoId) throw new Error('emprestimoId inválido');
  if (!Array.isArray(abatimentos)) abatimentos = [];

  // valor TOTAL que o cliente entregou (usado para registrar na parcela de origem)
  const valorTotalCliente = f2(valorPagamento || 0);

  let saldoCliente = valorTotalCliente;
  const updates = [];
  let origemRegistrada = false; // marca se já registramos o valor_total em alguma parcela

  await runAsync('BEGIN');

  try {
    // Valida existência do empréstimo
    const emp = await getAsync('SELECT id FROM emprestimos WHERE id = ?', [emprestimoId]);
    if (!emp) throw new Error('Empréstimo não encontrado');

    // Para não quebrar caso o front mande parcelas fora de ordem
    for (const item of abatimentos) {
      if (saldoCliente <= 0) break;

      const parcelaId = Number(item?.parcelaId || item?.id || 0);
      if (!parcelaId) continue;

      const row = await getAsync(
        'SELECT * FROM parcelas WHERE id = ? AND emprestimo_id = ?',
        [parcelaId, emprestimoId]
      );
      if (!row) continue;

      let valor_total   = f2(row.valor_total);
      let valor_capital = f2(row.valor_capital);
      let valor_juros   = f2(row.valor_juros);
      let valor_pago    = f2(row.valor_pago);
      const original_total = f2(row.valor_total);

      // Saldos que realmente podem ser abatidos (juros/capital remanescentes)
      const saldoJ = Math.max(0, valor_juros);
      const saldoC = Math.max(0, valor_capital);

      // Normalização do payload vindo do front
      const reqParc = f2(item.abatParcela || item.abatidoTotal || item.total || 0);
      const reqJ    = f2(item.abatJuros   || item.abatidoJuros   || item.juros  || 0);
      const reqC    = f2(item.abatCapital || item.abatidoCapital || item.capital|| 0);

      let aplicadoJ = 0;
      let aplicadoC = 0;

      if (reqParc > 0) {
        // Aplica na ordem: primeiro JUROS, depois CAPITAL
        const usarJ = Math.min(reqParc, saldoCliente, saldoJ);
        aplicadoJ = f2(usarJ);

        const aindaSobra = f2(reqParc - aplicadoJ);
        const usarC = Math.min(aindaSobra, f2(saldoCliente - aplicadoJ), saldoC);
        aplicadoC = f2(usarC);
      } else {
        // Aplica campos separados
        const usarJ = Math.min(reqJ, saldoCliente, saldoJ);
        aplicadoJ = f2(usarJ);

        const usarC = Math.min(reqC, f2(saldoCliente - aplicadoJ), saldoC);
        aplicadoC = f2(usarC);
      }

      const aplicadoTotal = f2(aplicadoJ + aplicadoC);
      if (aplicadoTotal <= 0) continue;

      // Deduz do saldo do cliente (apenas o que realmente foi usado em abatimento)
      saldoCliente = f2(saldoCliente - aplicadoTotal);

      // Efetiva nas colunas de JUROS / CAPITAL / TOTAL
      if (aplicadoJ > 0) {
        valor_juros = f2(valor_juros - aplicadoJ);
        valor_total = f2(valor_total - aplicadoJ);
      }
      if (aplicadoC > 0) {
        valor_capital = f2(valor_capital - aplicadoC);
        valor_total   = f2(valor_total   - aplicadoC);
      }

      // Nunca negativos
      valor_juros   = f2(Math.max(0, valor_juros));
      valor_capital = f2(Math.max(0, valor_capital));
      valor_total   = f2(Math.max(0, valor_total));

      // 🔵 REGISTRO DO VALOR PAGO (NOVO COMPORTAMENTO)
      //
      // Apenas a PRIMEIRA parcela que recebe algum abatimento registra
      // o valor TOTAL pago pelo cliente em valor_pago.
      // As demais NÃO recebem valor_pago adicional (apenas capital/juros ajustados),
      // para não aparecer "500" na próxima parcela.
      if (!origemRegistrada && aplicadoTotal > 0) {
        valor_pago = f2(valor_pago + valorTotalCliente);
        origemRegistrada = true;
      }
      // Importante: NÃO limitamos mais valor_pago ao original_total aqui.
      // Isso permite que a parcela de origem mostre, por exemplo:
      //  Valor total: 1.500
      //  Valor pago : 2.000 (inclui 500 de excedente)
      // O excedente é inferido no front como valor_pago - valor_total.

      const quitada = valor_total <= 0 ? 1 : 0;

      // Atualiza a parcela
      await runAsync(
        `UPDATE parcelas
           SET valor_total = ?,
               valor_capital = ?,
               valor_juros = ?,
               valor_pago = ?,
               pago = ?,
               data_pagamento = CASE
                                  WHEN ? IS NOT NULL AND ? = 1 THEN ?
                                  ELSE data_pagamento
                                END
         WHERE id = ?`,
        [
          valor_total,
          valor_capital,
          valor_juros,
          valor_pago,
          quitada,
          dataPagamento,
          quitada,
          dataPagamento,
          parcelaId
        ]
      );

      updates.push({
        id: parcelaId,
        valor_total,
        valor_capital,
        valor_juros,
        valor_pago,
        pago: quitada
      });
    }

    // Recalcula e grava o capital_restante do empréstimo (somatório do capital das parcelas ainda abertas)
    const abertas = await allAsync(
      'SELECT valor_capital FROM parcelas WHERE emprestimo_id = ? AND (pago IS NULL OR pago = 0)',
      [emprestimoId]
    );
    const novoCapitalRestante = f2(
      (abertas || []).reduce((s, p) => s + f2(p.valor_capital), 0)
    );

    await runAsync(
      'UPDATE emprestimos SET capital_restante = ? WHERE id = ?',
      [novoCapitalRestante, emprestimoId]
    );

    await runAsync('COMMIT');
    return { saldoRestante: f2(saldoCliente), parcelasAtualizadas: updates };
  } catch (e) {
    try { await runAsync('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = pagamentoManual;