const express = require('express');
const router = express.Router();
const db = require('../models/database');

router.get('/', (req, res) => {
  const hoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  db.all(
    `SELECT e.id AS emprestimo_id, e.cliente_id, e.valor AS valor_emprestimo, p.id AS parcela_id, p.numero, p.valor_total, p.data_pagamento
     FROM parcelas p
     JOIN emprestimos e ON e.id = p.emprestimo_id
     WHERE p.pago = 0 AND p.data_pagamento < ?`,
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