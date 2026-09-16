// backend/services/auditoriaService.js
const db = require('../models/database');

/**
 * Auditoria de parcelas por data de vencimento
 * Retorna as parcelas no formato compatível com ParcelaList,
 * enriquecidas com dados do cliente/emprestimo.
 *
 * @param {string} dataISO - YYYY-MM-DD
 * @param {object} opts
 * @param {boolean} opts.incluirPagas - se true, inclui parcelas pagas também
 */
function auditarVencimentosPorData(dataISO, opts = {}) {
  const incluirPagas = !!opts.incluirPagas;

  return new Promise((resolve, reject) => {
    if (!dataISO || !/^\d{4}-\d{2}-\d{2}$/.test(dataISO)) {
      return reject(new Error('Data inválida. Use YYYY-MM-DD.'));
    }

    // Observação:
    // - Base do SELECT espelhada do parcelasService.js
    // - JOIN em emprestimos/clientes para trazer cliente_nome e cliente_id
    // - Filtro por DATE(p.vencimento) = DATE(?)
    // - Se incluirPagas=false, filtra somente não pagas
    const sql = `
      SELECT
        p.id,
        p.emprestimo_id,
        p.numero,
        p.valor_total,
        p.valor_capital,
        p.valor_juros,
        p.pago,
        p.valor_pago,
        p.data_pagamento,
        p.juros_adicionais,
        p.juros_pendentes,
        p.observacao,
        p.explicacao,
        p.vencimento,
        po.valor_total AS valor_original,
        p.tipo_pagamento,

        e.cliente_id,
        c.nome AS cliente_nome,
        c.telefone AS cliente_telefone,
        c.endereco AS cliente_endereco

      FROM parcelas p
      LEFT JOIN parcelas_originais po
        ON po.emprestimo_id = p.emprestimo_id
       AND po.numero = p.numero

      INNER JOIN emprestimos e
        ON e.id = p.emprestimo_id

      INNER JOIN clientes c
        ON c.id = e.cliente_id

      WHERE DATE(p.vencimento) = DATE(?)
        AND (p.versao IS NULL OR p.versao = e.versao_atual)
        ${incluirPagas ? '' : 'AND COALESCE(p.pago, 0) = 0'}

      ORDER BY c.nome ASC, p.emprestimo_id ASC, p.numero ASC
    `;

    db.all(sql, [dataISO], (err, rows) => {
      if (err) {
        console.error('[auditoriaService] erro SQL:', err);
        return reject(err);
      }

      resolve({
        data_consultada: dataISO,
        total_encontradas: rows.length,
        parcelas: rows,
      });
    });
  });
}

module.exports = {
  auditarVencimentosPorData,
};
