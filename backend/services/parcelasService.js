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
         p.id, p.emprestimo_id, p.numero, p.valor_total, p.valor_capital, p.valor_juros, p.pago, 
         p.valor_pago, p.data_pagamento, p.juros_adicionais, p.juros_pendentes, p.observacao, p.explicacao,
         p.vencimento,
         po.valor_total AS valor_original,
         p.tipo_pagamento
       FROM parcelas p
       JOIN emprestimos e
         ON e.id = p.emprestimo_id
       LEFT JOIN parcelas_originais po 
         ON po.emprestimo_id = p.emprestimo_id 
        AND po.numero = p.numero
       WHERE p.emprestimo_id = ?
         AND (p.versao IS NULL OR p.versao = e.versao_atual)
       ORDER BY p.numero ASC`,
      [emprestimoId],
      (err, parcelas) => {
        if (err) return reject(err);

        db.all(
          `SELECT id, valor, data, tipo_pagamento, parcela_origem, renegociacao_id
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
                  const pagoFlag = p.pago === 1 || p.pago === '1' || p.pago === true;
                  const valorPagoNum = Number(p.valor_pago || 0);
                  const temPagamentoReal = pagoFlag || valorPagoNum > 0;
                  const dataPagamentoISO = temPagamentoReal ? toISO(p.data_pagamento) : null;

                  return {
                    ...p,
                    origem: 'atual',
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
  getParcelasData,
  async getPagamentosPorEmprestimo(emprestimoId) {
    const data = await getParcelasData(emprestimoId);
    const parcelas = data.parcelas || [];
    const pagamentos = (data.pagamentos || []).map((p, idx) => ({
      ...p,
      numero_parcela:
        typeof p.parcela_origem === 'number'
          ? (parcelas.find((parc) => parc.numero === p.parcela_origem + 1)?.numero ??
            p.parcela_origem + 1)
          : null,
      ordem: idx,
    }));
    const total_pago = pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0);
    return { pagamentos, total_pago };
  },
};
