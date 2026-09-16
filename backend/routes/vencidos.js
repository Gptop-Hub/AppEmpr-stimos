const express = require('express');
const router = express.Router();
const db = require('../models/database');

router.get('/', (req, res) => {
  const d = new Date();
  const hoje = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-'); // YYYY-MM-DD local

  db.all(
    `SELECT
       e.id AS emprestimo_id,
       e.cliente_id,
       c.nome AS cliente_nome,
       COALESCE(e.valor_atual, e.valor, 0) AS valor_emprestimo,
       p.id AS parcela_id,
       p.numero,
       p.valor_total,
       p.valor_capital,
       p.valor_juros,
       p.juros_adicionais,
       p.juros_pendentes,
       p.vencimento,
       p.vencimento AS data_pagamento
     FROM parcelas p
     JOIN emprestimos e ON e.id = p.emprestimo_id
     LEFT JOIN clientes c ON c.id = e.cliente_id
     WHERE (p.versao IS NULL OR p.versao = e.versao_atual)
       AND COALESCE(p.pago, 0) = 0
       AND (p.numero IS NULL OR p.numero != -1)
       AND DATE(p.vencimento) < DATE(?)
       AND p.id = (
         SELECT MAX(p2.id)
         FROM parcelas p2
         WHERE p2.emprestimo_id = p.emprestimo_id
           AND (p2.numero = p.numero OR (p2.numero IS NULL AND p.numero IS NULL))
           AND (p2.versao IS NULL OR p2.versao = e.versao_atual)
       )
     ORDER BY DATE(p.vencimento) ASC, c.nome ASC`,
    [hoje],
    (err, rows) => {
      if (err) {
        console.error('[ERRO] GET /vencidos:', err);
        return res.status(500).json({ erro: 'Erro ao buscar vencidos' });
      }
      res.json(rows);
    }
  );
});

module.exports = router;
