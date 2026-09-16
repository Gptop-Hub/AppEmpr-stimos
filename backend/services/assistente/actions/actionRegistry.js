const paymentCommand = require('./paymentCommand');
const interestPaymentCommand = require('./interestPaymentCommand');
const manualPaymentCommand = require('./manualPaymentCommand');
const discountNextPaymentCommand = require('./discountNextPaymentCommand');
const settleLoanCommand = require('./settleLoanCommand');
const renegotiationCommand = require('./renegotiationCommand');

function definition(name, command, requiredFields, description) {
  return Object.freeze({ name, command, required_fields: requiredFields, description,
    argument_schema: Object.freeze({ type: 'object', additionalProperties: false, required: ['action', ...requiredFields], properties: Object.freeze(Object.fromEntries(['action', ...requiredFields].map((field) => [field, { type: ['valor', 'parcelas', 'taxa_juros'].includes(field) ? 'number' : field.endsWith('_id') ? 'integer' : 'string' }]))) }),
    validate: command.normalizeIntent, createPreview: command.createPaymentPreview, execute: command.executePayment,
    confirmation: Object.freeze({ required: true, button_only: true }), revalidation: Object.freeze({ fingerprint: true }),
    sanitizeAuditPreview(preview = {}) { return { action: name, cliente_id: preview.cliente && Number(preview.cliente.id), emprestimo_id: preview.emprestimo && Number(preview.emprestimo.id), valor: preview.pagamento && Number(preview.pagamento.valor), componentes: preview.audit && preview.audit.componentes ? preview.audit.componentes : null, impacto: preview.impacto || null }; },
  });
}
function createActionRegistry({ normalCommand = paymentCommand, interestCommand = interestPaymentCommand, manualCommand = manualPaymentCommand, discountCommand = discountNextPaymentCommand, settleCommand = settleLoanCommand, renegotiationCommand: renegotiation = renegotiationCommand } = {}) {
  const entries = new Map([
    ['registrar_pagamento', definition('registrar_pagamento', normalCommand, ['cliente_id', 'emprestimo_id', 'valor', 'data', 'tipo_pagamento'], 'Registra pagamento normal em emprestimo parcelado.')],
    ['registrar_pagamento_juros', definition('registrar_pagamento_juros', interestCommand, ['cliente_id', 'emprestimo_id', 'valor', 'data'], 'Registra exclusivamente os juros atuais da proxima parcela em aberto e adia o cronograma conforme a regra oficial.')],
    ['registrar_pagamento_manual', definition('registrar_pagamento_manual', manualCommand, ['cliente_id', 'emprestimo_id', 'valor', 'data', 'abatimentos'], 'Registra pagamento manual com abatimentos explicitos por parcela; cada abatimento e distribuido pela regra oficial entre juros adicionais, juros pendentes, juros base e capital.')],
    ['desconto_proxima', definition('desconto_proxima', discountCommand, ['cliente_id', 'emprestimo_id', 'valor', 'data'], 'Registra um pagamento na parcela atual e aplica automaticamente qualquer excedente, em ordem, como desconto nas proximas parcelas abertas.')],
    ['quitar_emprestimo', definition('quitar_emprestimo', settleCommand, ['cliente_id', 'emprestimo_id', 'data'], 'Calcula no backend e registra a quitação do empréstimo: capital das parcelas abertas e juros da próxima parcela, encerrando as parcelas restantes conforme a regra oficial.')],
    ['renegociar_emprestimo', definition('renegociar_emprestimo', renegotiation, ['cliente_id', 'emprestimo_id', 'valor', 'parcelas', 'taxa_juros', 'data', 'data_pagamento'], 'Substitui o cronograma vigente por um novo acordo, preservando snapshot histórico e criando nova versão. Todos os termos financeiros devem ser informados explicitamente.')],
  ]);
  const get = (name) => entries.get(String(name || '')) || null;
  return Object.freeze({ get, list: () => [...entries.values()], preparePreview(intent) { const entry = get(intent && intent.action); if (!entry) { const e = new Error('Acao nao suportada.'); e.code = 'unsupported_action'; throw e; } return entry.createPreview(intent); }, execute(action, args, fingerprint, executionContext) { const entry = get(action); if (!entry) { const e = new Error('Acao nao suportada.'); e.code = 'unsupported_action'; throw e; } return entry.execute(args, fingerprint, executionContext); }, sanitizeAuditPreview(action, preview) { const entry = get(action); return entry ? entry.sanitizeAuditPreview(preview) : { action: null }; } });
}
const actionRegistry = createActionRegistry();
module.exports = { createActionRegistry, actionRegistry };
