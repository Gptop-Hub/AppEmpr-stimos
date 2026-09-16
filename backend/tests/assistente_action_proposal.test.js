const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createActionPreviewFromPlan, validateActionProposal } = require('../services/assistente/actions/actionProposal');

function proposal(overrides = {}) {
  return {
    action: 'registrar_pagamento', cliente_id: 1, emprestimo_id: 10,
    valor: 250, data: '2026-08-19', tipo_pagamento: 'normal', ...overrides,
  };
}

function context(overrides = {}) {
  return {
    screenContext: { selected_ids: { cliente: 1, emprestimo: 10 } },
    memoryContext: { active_context: {}, active_entities: {} },
    ...overrides,
  };
}

function fakeGateway() {
  let previews = 0;
  return {
    get previews() { return previews; },
    async createPreview({ sessionId, intent }) {
      previews += 1;
      return {
        confirmation_token: `opaque-${sessionId}`,
        expires_at: '2026-08-19T12:00:00.000Z',
        preview: {
          cliente: { id: intent.cliente_id, nome: 'Cliente de Teste' },
          emprestimo: { id: intent.emprestimo_id },
          pagamento: { valor: intent.valor, data: intent.data, tipo_pagamento: intent.tipo_pagamento },
          impacto: { parcela: { id: 100, numero: 1 }, valor_pago_posterior: intent.valor },
        },
      };
    },
  };
}

test('plano de leitura permanece leitura e nao chama gateway', async () => {
  const gateway = fakeGateway();
  const result = await createActionPreviewFromPlan({ plan: { strategy: 'financial_query' }, ...context(), sessionId: 's', gateway });
  assert.equal(result.kind, 'none');
  assert.equal(gateway.previews, 0);
});

test('plano estruturado valido gera somente preview sem executar escrita', async () => {
  const gateway = fakeGateway();
  const result = await createActionPreviewFromPlan({ plan: { action_proposal: proposal() }, ...context(), sessionId: 's', gateway });
  assert.equal(result.kind, 'preview');
  assert.equal(result.action_preview.action, 'registrar_pagamento');
  assert.equal(result.action_preview.preview.impacto.parcela.numero, 1);
  assert.equal(gateway.previews, 1);
  assert.deepEqual(Object.keys(result.action_preview).sort(), ['action', 'confirmation_token', 'expires_at', 'preview']);
});

test('contrato rejeita acao nao suportada, SQL e campos desconhecidos', async () => {
  assert.equal(validateActionProposal(proposal({ action: 'editar_emprestimo' }), context()).kind, 'unsupported');
  assert.equal(validateActionProposal({ ...proposal(), sql: 'DELETE FROM pagamentos' }, context()).kind, 'rejected');
  const gateway = fakeGateway();
  const withSql = await createActionPreviewFromPlan({
    plan: { action_proposal: proposal(), sql_query: 'INSERT INTO pagamentos VALUES (1)' },
    ...context(), sessionId: 's', gateway,
  });
  assert.equal(withSql.kind, 'rejected');
  assert.equal(gateway.previews, 0);
});

test('IDs sem contexto, incompatíveis ou ambiguos nunca chegam ao gateway', async () => {
  const gateway = fakeGateway();
  const missing = await createActionPreviewFromPlan({
    plan: { action_proposal: proposal() }, ...context({ screenContext: { selected_ids: {} } }), sessionId: 's', gateway,
  });
  assert.equal(missing.kind, 'clarification');
  const mismatch = await createActionPreviewFromPlan({
    plan: { action_proposal: proposal({ cliente_id: 2 }) }, ...context(), sessionId: 's', gateway,
  });
  assert.equal(mismatch.kind, 'clarification');
  const ambiguous = await createActionPreviewFromPlan({
    plan: { action_proposal: proposal() },
    ...context({ screenContext: { selected_ids: {} }, memoryContext: { active_entities: { cliente: [1, 2], emprestimo: [10, 11] } } }),
    sessionId: 's', gateway,
  });
  assert.equal(ambiguous.kind, 'clarification');
  assert.equal(gateway.previews, 0);
});

test('memoria de result_set ativa pode fornecer uma entidade exata sem PII', async () => {
  const gateway = fakeGateway();
  const result = await createActionPreviewFromPlan({
    plan: { action_proposal: proposal() },
    ...context({
      screenContext: { selected_ids: {} },
      memoryContext: { active_context: {}, active_entities: { cliente: [1], emprestimo: [10] } },
    }),
    sessionId: 's', gateway,
  });
  assert.equal(result.kind, 'preview');
  assert.doesNotMatch(JSON.stringify(result.action_preview), /cpf|telefone|endereco/i);
});

test('frontend confirma somente com session_id e confirmation_token', () => {
  const api = fs.readFileSync(path.join(__dirname, '../../frontend/src/assistant/assistantApi.js'), 'utf8');
  assert.match(api, /JSON\.stringify\(\{ session_id: sessionId \|\| '', confirmation_token: confirmationToken \|\| '' \}\)/);
  assert.doesNotMatch(api, /confirmation_token: confirmationToken[^\n]*valor/);
});

test('controller entrega preview na resposta da API sem expor estado interno', async () => {
  const orchestratorPath = require.resolve('../services/assistente/orchestrator');
  const controllerPath = require.resolve('../controllers/assistenteController');
  const orchestrator = require(orchestratorPath);
  const runnerKey = 'runAssistant' + 'Query';
  const originalRun = orchestrator[runnerKey];
  const cachedController = require.cache[controllerPath];
  const previousReadOnly = process.env.ASSISTANT_READONLY_TEST_MODE;
  delete require.cache[controllerPath];
  process.env.ASSISTANT_READONLY_TEST_MODE = '1';
  orchestrator[runnerKey] = async () => ({
    mode: 'action_preview', reasoning_mode: 'agent_loop_v2', session_id: 's', turn_id: 't',
    answer_text: 'Confira a prévia.', confidence: 0.9, resolved_context: {}, tool_trace: [], sources: [],
    action_preview: { action: 'registrar_pagamento', confirmation_token: 'opaque', expires_at: '2026-08-19T12:00:00.000Z', preview: { pagamento: { valor: 250 } } },
    usage_trace: {}, telemetry: {},
  });
  try {
    const controller = require(controllerPath);
    let body = null;
    const res = { json(value) { body = value; return this; }, status() { return this; } };
    await controller.query({ body: { session_id: 's', turn_id: 't', user_text: 'teste', voice_enabled: false } }, res);
    assert.equal(body.action_preview.action, 'registrar_pagamento');
    assert.equal(body.action_preview.confirmation_token, 'opaque');
    assert.doesNotMatch(JSON.stringify(body.action_preview), /fingerprint|sql/i);
  } finally {
    orchestrator[runnerKey] = originalRun;
    delete require.cache[controllerPath];
    if (cachedController) require.cache[controllerPath] = cachedController;
    if (previousReadOnly == null) delete process.env.ASSISTANT_READONLY_TEST_MODE;
    else process.env.ASSISTANT_READONLY_TEST_MODE = previousReadOnly;
  }
});
