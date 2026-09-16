// routes/renegociar.js
const express = require('express');
const router = express.Router();
const { renegociarEmprestimo } = require('../utils/renegociar');
const { touchAtividade } = require('../utils/touchAtividade');

router.post('/', async (req, res) => {
  try {
    // extrai do body nos nomes que vêm do frontend
    const {
      emprestimo_id,
      novo_capital,
      qtd_parcelas,
      taxa_juros,
      data_inicio,
      dia_pagamento,
      observacao
    } = req.body;

    console.log('[DEBUG] Rota /renegociar recebeu:', req.body);

    // chama o util com o que ele de fato espera
    const resultado = await renegociarEmprestimo({
      emprestimoId: emprestimo_id,
      novoCapital: novo_capital,
      novaQtdParcelas: qtd_parcelas,
      novaTaxaJuros: taxa_juros,
      dataInicio: data_inicio,
      diaPagamento: dia_pagamento,
      observacao // se você quiser usar depois
    });

    try {
      await touchAtividade({ emprestimoId: emprestimo_id });
    } catch (touchErr) {
      console.error('[touchAtividade] renegociar-route:', touchErr);
    }
    res.json(resultado);
  } catch (error) {
    console.error('Erro na rota renegociar:', error);
    res.status(500).json({ error: 'Erro ao processar renegociação' });
  }
});

module.exports = router;
