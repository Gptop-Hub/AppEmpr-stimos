const test = require('node:test');
const assert = require('node:assert/strict');

const memory = require('../services/assistente/conversationMemory');
const { callOpenAIChat } = require('../services/assistente/agent/planningLLM');
const { runAssistantQuery } = require('../services/assistente/orchestrator');
const { sanitizeScreenContext } = require('../services/assistente/contracts');

test('resetSessionMemory limpa somente a memoria semantica da sessao', () => {
  const sessionId = `fase3_reset_${Date.now()}`;
  memory.recordConversationTurn({
    sessionId,
    turnId: 'turn_1',
    userText: 'Pergunta de teste',
    answerText: 'Resposta de teste',
    resolvedContext: { cliente_id: 7 },
  });

  assert.equal(memory.getSessionConversationContext(sessionId).length, 2);
  assert.equal(memory.resetSessionMemory(sessionId), true);

  const snapshot = memory.getSessionMemorySnapshot(sessionId);
  assert.deepEqual(memory.getSessionConversationContext(sessionId), []);
  assert.deepEqual(snapshot.active_context, {});
  assert.deepEqual(snapshot.result_sets, []);
});

test('screen context aceita somente IDs e filtros financeiros conhecidos', () => {
  const safe = sanitizeScreenContext({
    route: '/clientes?cpf=111.222.333-44',
    query_params: { cliente: '7', periodo: 'mes', cpf: '111.222.333-44', telefone: '999999999' },
    active_filters: { nome_cliente: 'Ana', observacao: 'nota privada', endereco: 'rua privada' },
  });

  assert.equal(safe.route, '/clientes');
  assert.deepEqual(safe.query_params, { cliente: '7', periodo: 'mes' });
  assert.deepEqual(safe.active_filters, { nome_cliente: 'Ana' });
});

test('callOpenAIChat marca 429 como indisponibilidade do provedor', async () => {
  const originalFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'credit_balance_exhausted' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } }
  );

  try {
    const result = await callOpenAIChat({ model: 'test-model', messages: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.unavailable, true);
    assert.equal(result.provider_code, 'credit_balance_exhausted');
  } finally {
    global.fetch = originalFetch;
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('controller devolve 429 seguro quando o provedor esta sem creditos', async () => {
  const orchestratorPath = require.resolve('../services/assistente/orchestrator');
  const controllerPath = require.resolve('../controllers/assistenteController');
  const orchestrator = require(orchestratorPath);
  const originalRun = orchestrator.runAssistantQuery;
  const cachedController = require.cache[controllerPath];
  delete require.cache[controllerPath];

  orchestrator.runAssistantQuery = async () => {
    const error = new Error('credit_balance_exhausted');
    error.code = 'assistant_provider_unavailable';
    throw error;
  };

  try {
    const controller = require(controllerPath);
    let statusCode = 0;
    let responseBody = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return this; },
    };
    await controller.query({ body: { session_id: 's', turn_id: 't', user_text: 'teste' } }, res);
    assert.equal(statusCode, 429);
    assert.equal(responseBody.code, 'assistant_provider_unavailable');
    assert.match(responseBody.error, /temporariamente indisponivel/i);
    assert.doesNotMatch(responseBody.error, /credit_balance_exhausted/i);
  } finally {
    orchestrator.runAssistantQuery = originalRun;
    delete require.cache[controllerPath];
    if (cachedController) require.cache[controllerPath] = cachedController;
  }
});

test('orquestrador nao transforma 429 em resposta inventada', async () => {
  const originalFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'credit_balance_exhausted' } }),
    { status: 429, headers: { 'Content-Type': 'application/json' } }
  );

  try {
    await assert.rejects(
      () => runAssistantQuery({
        userText: 'Qual o saldo em aberto?',
        screenContext: {},
        conversationContext: [],
        sessionId: `fase3_429_${Date.now()}`,
        turnId: 'turn_429',
      }),
      (error) => error && error.code === 'assistant_provider_unavailable'
    );
  } finally {
    global.fetch = originalFetch;
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
