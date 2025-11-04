const express = require('express');
const router = express.Router();
const calcularSaldoCapital = require('../utils/calcular_saldo_capital');

router.get('/:emprestimoId', async (req, res) => {
  try {
    const saldo = await calcularSaldoCapital(req.params.emprestimoId);
    res.json({ saldo });
  } catch (e) {
    console.error('[ERRO] ao calcular saldo:', e);
    res.status(500).json({ erro: 'Erro ao calcular saldo' });
  }
});

module.exports = router;