const express = require('express');
const database = require('../models/database');
const {
  listActionHistory,
  getActionHistoryDetail,
} = require('../services/actionHistoryReadService');

const router = express.Router();

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(await listActionHistory(req.query, { dbHandle: database }));
  } catch (error) {
    if (error?.status === 400 || error?.code === 'INVALID_ACTION_HISTORY_QUERY') {
      return res.status(400).json({ error: error.message });
    }
    console.error('[acoes/listar]', error);
    return res.status(500).json({ error: 'Não foi possível carregar o histórico de ações.' });
  }
});

router.get('/:acaoUid', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const detail = await getActionHistoryDetail(req.params.acaoUid, { dbHandle: database });
    if (!detail) return res.status(404).json({ error: 'Ação não encontrada.' });
    return res.json(detail);
  } catch (error) {
    if (error?.status === 400 || error?.code === 'INVALID_ACTION_HISTORY_QUERY') {
      return res.status(400).json({ error: error.message });
    }
    console.error('[acoes/detalhe]', error);
    return res.status(500).json({ error: 'Não foi possível carregar os detalhes da ação.' });
  }
});

module.exports = router;
