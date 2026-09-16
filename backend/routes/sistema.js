const express = require('express');
const { exigirProtecao } = require('../middleware/protecao');

const database = require('../models/database');
const paths = require('../utils/paths');
const {
  purgeAllSystemData,
} = require('../services/systemPurgeService');

const router = express.Router();
const CONFIRMATION_PHRASE = 'EXCLUIR TUDO';
let purgeInProgress = false;

router.post('/excluir-tudo', exigirProtecao('apagar_todos_dados'), async (req, res) => {
  const confirmation = String((req.body && req.body.confirmation) || '').trim().toUpperCase();

  res.set('Cache-Control', 'no-store');

  if (confirmation !== CONFIRMATION_PHRASE) {
    return res.status(400).json({
      success: false,
      error: `Digite ${CONFIRMATION_PHRASE} para confirmar a exclusao total.`,
    });
  }

  if (purgeInProgress) {
    return res.status(409).json({
      success: false,
      error: 'Uma exclusao total ja esta em andamento.',
    });
  }

  purgeInProgress = true;
  try {
    const result = await purgeAllSystemData({ database, pathsApi: paths });
    return res.json({
      success: true,
      message: 'Todos os dados internos do sistema foram excluidos.',
      tablesCleared: result.tablesCleared,
    });
  } catch (error) {
    console.error('[sistema/excluir-tudo]', error);
    return res.status(500).json({
      success: false,
      databaseCleared: error && error.code === 'PURGE_FILES_INCOMPLETE',
      error: error && error.message ? error.message : 'Falha ao excluir todos os dados.',
    });
  } finally {
    purgeInProgress = false;
  }
});

module.exports = router;
