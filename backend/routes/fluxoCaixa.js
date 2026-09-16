const express = require('express');
const relatoriosService = require('../services/relatorios');
const { sendBadRequest, sendServerError } = require('../services/relatorios/common/response');

const router = express.Router();

function isRangeValidationError(err) {
  if (!err) return false;
  return (
    err.code === 'INVALID_DATE_RANGE_FORMAT' ||
    err.code === 'INVALID_DATE_RANGE_ORDER' ||
    String(err.message || '').toLowerCase().includes('periodo custom exige')
  );
}

async function handleResumo(req, res) {
  try {
    const payload = await relatoriosService.getFluxoCaixaResumoFromQuery(req.query);
    return res.json(payload);
  } catch (err) {
    if (isRangeValidationError(err)) {
      return sendBadRequest(
        res,
        (err && err.message) || 'Parametros invalidos para periodo de caixa.'
      );
    }
    console.error('[fluxo-caixa/resumo] erro:', err);
    return sendServerError(res, err, 'Erro ao gerar resumo de fluxo de caixa.');
  }
}

async function handleLinhas(req, res) {
  try {
    const payload = await relatoriosService.getFluxoCaixaLinhasFromQuery(req.query);
    return res.json(payload);
  } catch (err) {
    if (isRangeValidationError(err)) {
      return sendBadRequest(
        res,
        (err && err.message) || 'Parametros invalidos para periodo de caixa.'
      );
    }
    console.error('[fluxo-caixa/linhas] erro:', err);
    return sendServerError(res, err, 'Erro ao listar linhas de fluxo de caixa.');
  }
}

router.get('/resumo', handleResumo);
router.get('/linhas', handleLinhas);

module.exports = router;
