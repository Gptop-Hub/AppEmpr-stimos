const express = require('express');
const { exigirProtecao } = require('../middleware/protecao');
const {
  registrarSaidaDespesa,
  listarDespesas,
  toDateOnly,
  backfillMovimentosCaixa,
} = require('../services/caixaService');
const db = require('../models/database');
const { getAsync, runAsync } = require('../utils/sqliteAsync');

const router = express.Router();

function toMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

router.post('/despesa', async (req, res) => {
  try {
    const {
      data,
      descricao,
      valor,
      observacao,
    } = req.body || {};

    const valorDespesa = toMoney(valor);
    if (!valorDespesa || valorDespesa <= 0) {
      return res.status(400).json({
        success: false,
        error: 'valor deve ser maior que zero.',
      });
    }

    const anotacaoFinal = String(observacao || descricao || '').trim();
    if (!anotacaoFinal) {
      return res.status(400).json({
        success: false,
        error: 'anotacao e obrigatoria.',
      });
    }

    const dataEvento = toDateOnly(data || null, true);
    const descricaoFinal = anotacaoFinal;

    const movimento = await registrarSaidaDespesa({
      data: dataEvento,
      descricao: descricaoFinal,
      valor: valorDespesa,
      meta: {
        observacao: anotacaoFinal,
        origem: '/caixa/despesa',
      },
    });

    return res.json({
      success: true,
      movimento_id: movimento && movimento.id ? Number(movimento.id) : null,
      data: dataEvento,
      valor: valorDespesa,
      descricao: descricaoFinal,
      anotacao: anotacaoFinal,
    });
  } catch (err) {
    console.error('[caixa/despesa] erro:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao registrar despesa.',
    });
  }
});

router.get('/despesas', async (req, res) => {
  try {
    const de = req.query?.de || null;
    const ate = req.query?.ate || null;
    const rows = await listarDespesas({ de, ate });
    return res.json({
      success: true,
      total: rows.length,
      despesas: rows,
    });
  } catch (err) {
    console.error('[caixa/despesas] erro:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao listar despesas.',
    });
  }
});

router.delete('/despesa/:id', exigirProtecao('excluir_despesa'), async (req, res) => {
  try {
    const id = Number(req.params?.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'id de despesa invalido.',
      });
    }

    const row = await getAsync(
      db,
      `SELECT id
         FROM caixa_movimentos
        WHERE id = ?
          AND UPPER(COALESCE(categoria, '')) = 'DESPESA'`,
      [id]
    );

    if (!row) {
      return res.status(404).json({
        success: false,
        error: 'Despesa nao encontrada.',
      });
    }

    const result = await runAsync(
      db,
      `DELETE FROM caixa_movimentos
        WHERE id = ?
          AND UPPER(COALESCE(categoria, '')) = 'DESPESA'`,
      [id]
    );

    return res.json({
      success: true,
      id,
      removidos: Number(result?.changes || 0),
    });
  } catch (err) {
    console.error('[caixa/despesa/delete] erro:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao excluir despesa.',
    });
  }
});

router.post('/backfill', async (req, res) => {
  try {
    const limiteEmprestimosRaw = req.body?.limiteEmprestimos;
    const limitePagamentosRaw = req.body?.limitePagamentos;

    const limiteEmprestimos = Number.isFinite(Number(limiteEmprestimosRaw))
      ? Math.max(0, Math.trunc(Number(limiteEmprestimosRaw)))
      : null;
    const limitePagamentos = Number.isFinite(Number(limitePagamentosRaw))
      ? Math.max(0, Math.trunc(Number(limitePagamentosRaw)))
      : null;

    const resultado = await backfillMovimentosCaixa({
      limiteEmprestimos,
      limitePagamentos,
    });

    return res.json({
      success: true,
      ...resultado,
    });
  } catch (err) {
    console.error('[caixa/backfill] erro:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao sincronizar historico de caixa.',
    });
  }
});

module.exports = router;
