const express = require('express');
const cobrancaService = require('../services/relatorios/cobrancaService');
const homeResumoDiarioService = require('../services/relatorios/homeResumoDiarioService');
const painelPeriodoService = require('../services/relatorios/painelPeriodoService');
const { sendBadRequest, sendServerError } = require('../services/relatorios/common/response');

const router = express.Router();

function isCobrancaValidationError(err) {
  if (!err) return false;
  return (
    err.code === 'INVALID_DATE_RANGE_FORMAT' ||
    err.code === 'INVALID_DATE_RANGE_ORDER'
  );
}

router.get('/health', (_req, res) => {
  return res.json({
    success: true,
    modulo: 'relatorios',
    status: 'ok',
    when: new Date().toISOString(),
  });
});

async function handleCobranca(req, res) {
  try {
    const payload = await cobrancaService.listarCobranca(req.query);
    return res.json(payload);
  } catch (err) {
    if (isCobrancaValidationError(err)) {
      return sendBadRequest(
        res,
        (err && err.message) || 'Parametros invalidos para cobranca.'
      );
    }
    console.error('[relatorios/cobranca] erro:', err);
    return sendServerError(res, err, 'Erro ao gerar relatorio de cobranca.');
  }
}

async function handleCobrancaPrint(req, res) {
  try {
    const payload = await cobrancaService.listarCobrancaPrint(req.query);
    return res.json(payload);
  } catch (err) {
    if (isCobrancaValidationError(err)) {
      return sendBadRequest(
        res,
        (err && err.message) || 'Parametros invalidos para cobranca.'
      );
    }
    console.error('[relatorios/cobranca/print] erro:', err);
    return sendServerError(res, err, 'Erro ao gerar dataset de impressao de cobranca.');
  }
}

async function handleHomeResumoDiario(req, res) {
  try {
    const payload = await homeResumoDiarioService.getResumoDiarioHome({
      dataReferencia: req.query?.data,
    });
    return res.json(payload);
  } catch (err) {
    console.error('[relatorios/home/resumo-diario] erro:', err);
    return sendServerError(
      res,
      err,
      'Erro ao gerar resumo diário da Home.'
    );
  }
}

// Base nova do modulo relatorios
router.get('/cobranca', handleCobranca);
router.get('/cobranca/print', handleCobrancaPrint);
router.get('/home/resumo-diario', handleHomeResumoDiario);
router.get('/home/painel-financeiro/detalhes', async (req, res) => {
  try {
    return res.json(await painelPeriodoService.getDetalhamentoPainelPeriodo(req.query));
  } catch (err) {
    if (isCobrancaValidationError(err) || err?.code === 'INVALID_GROUPING' || err?.code === 'INVALID_DETAIL_METRIC') {
      return sendBadRequest(res, err.message || 'Parâmetros inválidos para o detalhamento financeiro.');
    }
    console.error('[relatorios/home/painel-financeiro/detalhes] erro:', err);
    return sendServerError(res, err, 'Erro ao detalhar o relatório financeiro da Home.');
  }
});
router.get('/home/painel-financeiro', async (req, res) => {
  try {
    return res.json(await painelPeriodoService.getRelatorioPainelPeriodo(req.query));
  } catch (err) {
    if (isCobrancaValidationError(err) || err?.code === 'INVALID_GROUPING') {
      return sendBadRequest(res, err.message || 'Parametros invalidos para o relatorio financeiro.');
    }
    console.error('[relatorios/home/painel-financeiro] erro:', err);
    return sendServerError(res, err, 'Erro ao gerar relatorio financeiro da Home.');
  }
});

module.exports = router;
