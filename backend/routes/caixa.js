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
const actionService = require('../services/actionService');
const { ensureActionContractReady } = require('../services/actionIdentityService');
const { ACTION_TYPES } = require('../services/actionTypeContract');

const router = express.Router();

function toMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function formatMoneyBRL(value) {
  return `R$ ${toMoney(value).toFixed(2).replace('.', ',')}`;
}

async function withImmediateTransaction(execute) {
  // A migracao legada precisa ocorrer antes do BEGIN do fluxo de negocio.
  // A reserva da sequencia, por sua vez, continua dentro desta transacao.
  await ensureActionContractReady(db);
  await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await execute();
    await runAsync(db, 'COMMIT');
    return result;
  } catch (error) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw error;
  }
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

    const movimento = await withImmediateTransaction(async () => {
      const contextoAcao = await actionService.iniciarAcao({
        tipo: ACTION_TYPES.DESPESA_CRIADA,
        origem: 'interface',
        resumo: `Despesa de ${formatMoneyBRL(valorDespesa)} criada no Fluxo de Caixa.`,
        metadata: { categoria: 'DESPESA', data: dataEvento, valor: valorDespesa, descricao: descricaoFinal },
      }, { dbHandle: db });
      const criado = await registrarSaidaDespesa({
        data: dataEvento,
        descricao: descricaoFinal,
        valor: valorDespesa,
        meta: {
          observacao: anotacaoFinal,
          origem: '/caixa/despesa',
        },
      }, db);
      const linhaCriada = await getAsync(db, 'SELECT * FROM caixa_movimentos WHERE id = ?', [criado.id]);
      if (!linhaCriada) throw new Error('Movimento de despesa nao foi encontrado apos a criacao.');
      await actionService.registrarEntidade(contextoAcao, {
        entidade: 'caixa_movimento', entidade_id: criado.id, papel: 'criado',
      });
      // Criacao nao possui estado anterior persistido: o snapshot "depois" e a linha criada.
      await actionService.registrarSnapshot(contextoAcao, {
        momento: 'depois', entidade: 'caixa_movimento', entidade_id: criado.id, dados: linhaCriada,
      });
      await actionService.finalizarAcaoAplicada(contextoAcao);
      return criado;
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

    let result;
    try {
      result = await withImmediateTransaction(async () => {
        const row = await getAsync(
          db,
          `SELECT *
             FROM caixa_movimentos
            WHERE id = ?
              AND UPPER(COALESCE(categoria, '')) = 'DESPESA'`,
          [id]
        );
        if (!row) {
          const error = new Error('Despesa nao encontrada.');
          error.code = 'DESPESA_NOT_FOUND';
          throw error;
        }
        const valor = toMoney(row.valor_despesa || row.valor_total);
        const contextoAcao = await actionService.iniciarAcao({
          tipo: ACTION_TYPES.DESPESA_EXCLUIDA,
          origem: 'interface',
          resumo: `Despesa de ${formatMoneyBRL(valor)} excluida do Fluxo de Caixa.`,
          metadata: { categoria: row.categoria, data: row.data, valor, descricao: row.descricao || null },
        }, { dbHandle: db });
        await actionService.registrarEntidade(contextoAcao, {
          entidade: 'caixa_movimento', entidade_id: id, papel: 'removido',
        });
        await actionService.registrarSnapshot(contextoAcao, {
          momento: 'antes', entidade: 'caixa_movimento', entidade_id: id, dados: row,
        });
        const deletion = await runAsync(
          db,
          `DELETE FROM caixa_movimentos
            WHERE id = ?
              AND UPPER(COALESCE(categoria, '')) = 'DESPESA'`,
          [id]
        );
        if (Number(deletion?.changes || 0) !== 1) throw new Error('A despesa nao foi removida.');
        // Exclusao e representada pela ausencia apos o DELETE; nao ha linha para snapshot depois.
        await actionService.finalizarAcaoAplicada(contextoAcao);
        return deletion;
      });
    } catch (err) {
      if (err && err.code === 'DESPESA_NOT_FOUND') {
        return res.status(404).json({ success: false, error: err.message });
      }
      throw err;
    }

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
