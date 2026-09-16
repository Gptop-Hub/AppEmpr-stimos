const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../services/assistente/conversationMemory');
const { safeDraft, resolutionEntitiesFromRows } = require('../services/assistente/actions/actionDraft');
const { createActionPreviewFromPlan } = require('../services/assistente/actions/actionProposal');
const { createActionGateway, createMemoryAuditStore } = require('../services/assistente/actions/actionGateway');
const { __internal: agentInternal } = require('../services/assistente/agent/agentLoop');
const { runAgentLoop } = require('../services/assistente/agent/agentLoop');

function update(overrides = {}) {
  return { decision: 'create', action: 'registrar_pagamento', tipo_pagamento: 'normal', ...overrides };
}

function context(overrides = {}) {
  return {
    screenContext: { selected_ids: { cliente: 1, emprestimo: 10 } },
    memoryContext: { active_context: {}, active_entities: {} }, resolutionEntities: {},
    ...overrides,
  };
}

function gateway() {
  let writes = 0;
  return {
    get writes() { return writes; },
    async createPreview({ intent }) {
      return {
        confirmation_token: 'opaque-token', expires_at: '2026-08-19T12:00:00.000Z',
        preview: { cliente: { id: intent.cliente_id, nome: 'Cliente' }, emprestimo: { id: intent.emprestimo_id }, pagamento: intent, impacto: { parcela: { id: 100, numero: 1 } } },
      };
    },
    async executePayment() { writes += 1; },
  };
}

test('cria rascunho incompleto e completa campo em turno posterior sem PII', () => {
  const first = safeDraft(update({ valor: 300 }), null, context());
  assert.equal(first.ok, true);
  assert.equal(first.draft.valor, 300);
  assert.equal(first.draft.cliente_id, null);
  const second = safeDraft(update({ decision: 'update', data: '2026-08-19' }), first.draft, context());
  assert.equal(second.ok, true);
  assert.equal(second.draft.valor, 300);
  assert.equal(second.draft.data, '2026-08-19');
  assert.doesNotMatch(JSON.stringify(second.draft), /cpf|telefone|endereco/i);
});

test('draft e isolado por sessao, descartavel e expira por TTL', () => {
  const a = `draft_a_${Date.now()}`;
  const b = `draft_b_${Date.now()}`;
  memory.savePendingActionDraft(a, safeDraft(update({ valor: 30 }), null, context()).draft);
  assert.equal(memory.getPendingActionDraft(a).valor, 30);
  assert.equal(memory.getPendingActionDraft(b), null);
  memory.clearPendingActionDraft(a);
  assert.equal(memory.getPendingActionDraft(a), null);
  memory.savePendingActionDraft(a, safeDraft(update({ valor: 30 }), null, context()).draft);
  const stored = memory.getPendingActionDraft(a);
  const ttl = memory.__internal.PENDING_ACTION_DRAFT_TTL_MS;
  assert.equal(memory.getPendingActionDraft(a, stored.updated_at + ttl + 1), null);
  memory.savePendingActionDraft(a, safeDraft(update({ valor: 30 }), null, context()).draft);
  memory.resetSessionMemory(a);
  assert.equal(memory.getPendingActionDraft(a), null);
});

test('resultado read-only fornece candidato exato; IDs inventados e ambiguidades sao bloqueados', () => {
  const resolved = resolutionEntitiesFromRows([{ cliente_id: 7, emprestimo_id: 70 }]);
  const valid = safeDraft(update({ cliente_id: 7, emprestimo_id: 70 }), null, context({ screenContext: { selected_ids: {} }, resolutionEntities: resolved }));
  assert.equal(valid.ok, true);
  const invented = safeDraft(update({ cliente_id: 99, emprestimo_id: 70 }), null, context({ screenContext: { selected_ids: {} }, resolutionEntities: resolved }));
  assert.equal(invented.ok, false);
  const ambiguousClients = safeDraft(update({ cliente_id: 7 }), null, context({ screenContext: { selected_ids: {} }, resolutionEntities: { cliente: [7, 8], emprestimo: [70] } }));
  const ambiguousLoans = safeDraft(update({ emprestimo_id: 70 }), null, context({ screenContext: { selected_ids: {} }, resolutionEntities: { cliente: [7], emprestimo: [70, 71] } }));
  assert.equal(ambiguousClients.ok, false);
  assert.equal(ambiguousLoans.ok, false);
});

test('draft completo gera preview sem escrita e contrato nao habilita outra acao', async () => {
  const draft = safeDraft(update({ cliente_id: 1, emprestimo_id: 10, valor: 200, data: '2026-08-19' }), null, context()).draft;
  const fake = gateway();
  const result = await createActionPreviewFromPlan({
    plan: { action_proposal: { action: 'registrar_pagamento', cliente_id: 1, emprestimo_id: 10, valor: 200, data: '2026-08-19', tipo_pagamento: 'normal' } },
    ...context(), pendingDraft: draft, sessionId: 'draft-preview', gateway: fake,
  });
  assert.equal(result.kind, 'preview');
  assert.equal(fake.writes, 0);
  assert.equal(safeDraft(update({ action: 'quitar_emprestimo' }), null, context()).ok, false);
});

test('invalida preview pendente por sessao sem executar pagamento', async () => {
  const service = {
    async createPaymentPreview(intent) { return { action: intent.action, arguments: intent, state_fingerprint: 'state', preview: { cliente: { id: 1, nome: 'Cliente' }, emprestimo: { id: 10 }, impacto: {} } }; },
    async executePayment() { throw new Error('nao deve executar'); },
  };
  const actionGateway = createActionGateway({ paymentService: service, auditStore: createMemoryAuditStore() });
  const preview = await actionGateway.createPreview({ sessionId: 'draft-session', intent: { action: 'registrar_pagamento', cliente_id: 1, emprestimo_id: 10, valor: 20, data: '2026-08-19', tipo_pagamento: 'normal' } });
  assert.equal(await actionGateway.invalidatePendingForSession('draft-session'), 1);
  await assert.rejects(() => actionGateway.confirm({ sessionId: 'draft-session', confirmationToken: preview.confirmation_token }), { code: 'token_unavailable' });
});

test('loop tem limite seguro e nao ha interpretacao local no modulo de draft', () => {
  assert.equal(agentInternal.MAX_ACTION_RESOLUTION_ITERATIONS, 5);
  const source = require('node:fs').readFileSync(require.resolve('../services/assistente/actions/actionDraft'), 'utf8');
  assert.doesNotMatch(source, /pagou|recebi|FOLLOW_UP|match\(/i);
});

test('loop de resolucao faz novo planejamento apos uma tool read-only', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  const sessionId = `draft_loop_${Date.now()}`;
  let calls = 0;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => {
    calls += 1;
    const plan = calls === 1
      ? {
          action_draft: update({ valor: 50 }), tool_name: 'query_financial_data',
          wants_runtime_sql: true,
          sql_query: 'SELECT c.id AS cliente_id, e.id AS emprestimo_id FROM clientes c JOIN emprestimos e ON e.cliente_id = c.id LIMIT 1',
        }
      : { action_draft: update({ decision: 'keep' }) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], model: 'mock', usage: {} }), { status: 200 });
  };
  try {
    const result = await runAgentLoop({ userText: 'mensagem livre', screenContext: {}, conversationContext: [], memoryContext: {}, sessionId, turnId: 't' });
    assert.equal(calls, 2);
    assert.equal(result.tool_trace.length, 1);
    assert.ok(result.pending_action_draft);
  } finally {
    memory.clearPendingActionDraft(sessionId);
    global.fetch = originalFetch;
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
