const express = require('express');
const router = express.Router();
const {
  gerarNotificacoesParaData,
  listarNotificacoesPendentes,
  marcarComoLida,
} = require('../services/notificacoesService');
const {
  lerConfig,
  DEFAULT_CONFIG,
} = require('../config/notificacoesConfig');
const {
  gerarNotificacoesExplicitamente,
  salvarConfiguracaoNotificacoesComAcao,
} = require('../services/notificacoesActionService');

// ✅ NOVO: auditoria por data
const { auditarVencimentosPorData } = require('../services/auditoriaService');

const isISODate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// Roda o “motor” de notificações.
// Opcional: ?data=YYYY-MM-DD para máquina do tempo.
router.post('/run', async (req, res) => {
  try {
    const dataBaseISO = req.body?.data || req.query?.data;

    if (dataBaseISO && !isISODate(dataBaseISO)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de data invalido. Use YYYY-MM-DD.',
      });
    }

    const resultado = await gerarNotificacoesExplicitamente(dataBaseISO);
    res.json({ success: true, ...resultado });
  } catch (err) {
    console.error('[notificacoes/run] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ NOVO: Auditoria - listar parcelas que vencem na data informada
// GET /notificacoes/parcelas-por-data?data=YYYY-MM-DD&mostrarPagas=1
router.get('/parcelas-por-data', async (req, res) => {
  try {
    const dataISO = req.query?.data;

    if (!dataISO || !isISODate(dataISO)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de data invalido. Use YYYY-MM-DD.',
      });
    }

    const incluirPagas = String(req.query?.incluirPagas || '0') === '1';

    const resultado = await auditarVencimentosPorData(dataISO, { incluirPagas });

    res.json({
      success: true,
      ...resultado,
    });
  } catch (err) {
    console.error('[notificacoes/parcelas-por-data] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lista notificações pendentes
router.get('/', async (req, res) => {
  try {
    const incluirClientesComNotificacoesDesligadas =
      String(req.query?.incluirDesligadas || '') === '1';
    if (incluirClientesComNotificacoesDesligadas) {
      await gerarNotificacoesParaData(undefined, {
        incluirClientesComNotificacoesDesligadas: true,
      });
    }
    const lista = await listarNotificacoesPendentes({
      incluirClientesComNotificacoesDesligadas,
    });
    res.json({ success: true, notificacoes: lista });
  } catch (err) {
    console.error('[notificacoes/list] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Configurações de notificações
router.get('/config', async (req, res) => {
  try {
    const config = await lerConfig();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[notificacoes/config GET] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/config', async (req, res) => {
  try {
    const body = req.body || {};

    const venceEmBreveDias = Number(body.venceEmBreveDias);

    if (!Number.isFinite(venceEmBreveDias) || venceEmBreveDias <= 0) {
      return res.status(400).json({
        success: false,
        error: 'venceEmBreveDias deve ser um número maior que zero.',
      });
    }

    const salvo = await salvarConfiguracaoNotificacoesComAcao(
      { venceEmBreveDias },
      'salvar'
    );

    res.json({ success: true, config: salvo });
  } catch (err) {
    console.error('[notificacoes/config POST] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/config/default', async (req, res) => {
  try {
    const salvo = await salvarConfiguracaoNotificacoesComAcao(
      { ...DEFAULT_CONFIG },
      'restaurar_padrao'
    );
    res.json({ success: true, config: salvo });
  } catch (err) {
    console.error('[notificacoes/config/default] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Marca como lida
router.post('/:id/lida', async (req, res) => {
  try {
    const ok = await marcarComoLida(req.params.id);
    if (!ok) {
      return res
        .status(404)
        .json({ success: false, error: 'Notificação não encontrada' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[notificacoes/lida] erro:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
