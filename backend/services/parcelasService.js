// backend/services/parcelasService.js
const db = require('../models/database');
const { toISO, toExtenso } = require('./dateUtils');

/**
 * Retorna um objeto com:
 *  - parcelas: array de parcelas (JOIN com parcelas_originais já)
 *  - pagamentos: array de pagamentos do empréstimo
 *  - parcelasOriginais: array de parcelas_originais
 *
 * Normaliza campos importantes (vencimento/data_pagamento em ISO).
 */
function getParcelasData(emprestimoId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT 
         p.id, p.numero, p.valor_total, p.valor_capital, p.valor_juros, p.pago, 
         p.valor_pago, p.data_pagamento, p.juros_adicionais, p.observacao, p.explicacao,
         p.vencimento,
         po.valor_total AS valor_original,
         p.tipo_pagamento
       FROM parcelas p
       LEFT JOIN parcelas_originais po 
         ON po.emprestimo_id = p.emprestimo_id 
        AND po.numero = p.numero
       WHERE p.emprestimo_id = ?
       ORDER BY p.numero ASC`,
      [emprestimoId],
      (err, parcelas) => {
        if (err) return reject(err);

        db.all(
          `SELECT valor, data, tipo_pagamento, parcela_origem 
             FROM pagamentos 
            WHERE emprestimo_id = ? 
         ORDER BY data ASC`,
          [emprestimoId],
          (err2, pagamentos) => {
            if (err2) pagamentos = [];

            db.all(
              `SELECT numero, valor_total, valor_capital, valor_juros
               FROM parcelas_originais
               WHERE emprestimo_id = ?
               ORDER BY numero ASC`,
              [emprestimoId],
              (err3, parcelasOriginais) => {
                if (err3) parcelasOriginais = [];

                // Normalização
                const parcelasNorm = (parcelas || []).map(p => {
                  const pgParaExplicacao = pagamentos.find(pg => (pg.parcela_origem + 1) === p.numero);
                  const pgParaTipo = pagamentos.find(pg => pg.parcela_origem === p.numero);

                  const vencISO = toISO(p.vencimento);
                  const dataPagamentoISO = toISO(p.data_pagamento);

                  return {
                    ...p,
                    vencimento: vencISO,
                    data_pagamento: dataPagamentoISO,
                    vencimento_extenso: toExtenso(vencISO),
                    data_pagamento_extenso: dataPagamentoISO ? toExtenso(dataPagamentoISO) : '-',
                    explicacao: pgParaExplicacao ? p.explicacao : p.explicacao,
                    tipo_pagamento: pgParaTipo ? pgParaTipo.tipo_pagamento : null
                  };
                });

                resolve({
                  parcelas: parcelasNorm,
                  pagamentos: pagamentos || [],
                  parcelasOriginais: parcelasOriginais || []
                });
              }
            );
          }
        );
      }
    );
  });
}

module.exports = {
  getParcelasData
};