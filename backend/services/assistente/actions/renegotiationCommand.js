const renegociacaoService = require('../../../services/renegociacaoService');

function defaultDb() { return require('../../../models/database'); }

function normalizeIntent(intent = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || String(intent.action || '') !== 'renegociar_emprestimo') {
    const error = new Error('Ação não suportada.'); error.code = 'unsupported_action'; throw error;
  }
  return { action: 'renegociar_emprestimo', ...renegociacaoService.normalizeTerms(intent, { strictAction: true }) };
}

async function createPaymentPreview(intent, { dbHandle = defaultDb() } = {}) {
  const args = normalizeIntent(intent);
  return renegociacaoService.calcularPreviewRenegociacao({
    action: args.action, cliente_id: args.cliente_id, emprestimo_id: args.emprestimo_id,
    valor: args.valor, parcelas: args.parcelas, taxa_juros: args.taxa_juros,
    data: args.data, data_pagamento: args.data_pagamento,
  }, { dbHandle });
}

async function executePayment(normalized, expectedFingerprint, { dbHandle = defaultDb(), idempotencyKey = null } = {}) {
  const args = normalizeIntent(normalized);
  return renegociacaoService.aplicarRenegociacao({
    action: args.action, cliente_id: args.cliente_id, emprestimo_id: args.emprestimo_id,
    valor: args.valor, parcelas: args.parcelas, taxa_juros: args.taxa_juros,
    data: args.data, data_pagamento: args.data_pagamento,
  }, expectedFingerprint, { dbHandle, idempotencyKey });
}

module.exports = { normalizeIntent, createPaymentPreview, executePayment };
