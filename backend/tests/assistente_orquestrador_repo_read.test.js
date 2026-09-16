const test = require('node:test');
const assert = require('node:assert/strict');

const { runAssistantQuery, __internal } = require('../services/assistente/orchestrator');
const { decideKnowledgeSource } = require('../services/assistente/repoReadPolicy');

function newSession(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function nextWeekdayISO(baseISO, targetDay, includeToday = true) {
  const base = new Date(`${baseISO}T00:00:00`);
  const currentDay = base.getDay();
  let delta = (Number(targetDay) - currentDay + 7) % 7;
  if (!includeToday && delta === 0) delta = 7;
  const shifted = new Date(base);
  shifted.setDate(base.getDate() + delta);
  const local = new Date(shifted.getTime() - shifted.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

test('policy: pergunta operacional clara permanece domain_only', () => {
  const decision = decideKnowledgeSource({
    userText: 'Quais sao os cinco clientes com maior valor em atraso hoje?',
    requestClassification: { category: 'simples' },
    semanticProfile: { semantic_intent: 'estoque', primary_entity: 'parcela' },
  });

  assert.equal(decision.strategy, 'domain_only');
  assert.equal(Boolean(decision.should_use_repo_read), false);
});

test('policy: pergunta de origem de codigo vira repo_only', () => {
  const decision = decideKnowledgeSource({
    userText: 'Em qual arquivo esta a funcao runAssistantQuery no backend?',
    requestClassification: { category: 'simples' },
    semanticProfile: {},
  });

  assert.equal(decision.strategy, 'repo_only');
  assert.equal(Boolean(decision.should_use_repo_read), true);
});

test('policy: pergunta mista vira hybrid', () => {
  const decision = decideKnowledgeSource({
    userText: 'Quanto eu recebi em 2025 e em qual arquivo essa regra e calculada?',
    requestClassification: { category: 'complexa' },
    semanticProfile: { semantic_intent: 'resumo', primary_entity: 'caixa' },
  });

  assert.equal(decision.strategy, 'hybrid');
  assert.equal(Boolean(decision.should_use_repo_read), true);
});

test('runAssistantQuery: repo_only executa leitura sem passar por domain tool', async () => {
  const sessionId = newSession('repo_only');
  const turnId = 't1';
  const result = await runAssistantQuery({
    userText: 'Em qual arquivo esta a funcao runAssistantQuery?',
    screenContext: {},
    conversationContext: [],
    sessionId,
    turnId,
  });

  assert.equal(result.mode, 'answer');
  assert.equal(Array.isArray(result.repo_trace), true);
  assert.equal(result.repo_trace.length > 0, true);
  assert.equal(
    result.repo_trace.some((item) => String(item.tool || '').startsWith('repo_')),
    true
  );
});

test('runAssistantQuery: operacional deterministico nao aciona repo_read por padrao', async () => {
  const sessionId = newSession('domain_only');
  const turnId = 't1';
  const result = await runAssistantQuery({
    userText: 'Quanto eu recebi do comeco de 2024 ate o final de 2025? separa juros e capital',
    screenContext: {},
    conversationContext: [],
    sessionId,
    turnId,
  });

  assert.equal(result.mode, 'answer');
  assert.equal(Array.isArray(result.tool_trace), true);
  assert.equal(result.tool_trace.length > 0, true);
  assert.equal(String(result.tool_trace[0].tool || ''), 'caixa_resumo');
  assert.equal(Array.isArray(result.repo_trace), false);
});

test('parseDateRangeFromText: de hoje ate domingo gera intervalo hoje->domingo', () => {
  const parsed = __internal.parseDateRangeFromText(
    'Domingo agora eu quero sair, mas preciso saber quanto vou receber de hoje ate domingo.'
  );

  const expectedStart = todayISO();
  const expectedEnd = nextWeekdayISO(expectedStart, 0, true);
  assert.equal(parsed.reference, 'today_to_weekday');
  assert.equal(parsed.de, expectedStart);
  assert.equal(parsed.ate, expectedEnd);
});

test('runAssistantQuery: previsao de hoje ate domingo nao pede data de hoje e usa intervalo correto', async () => {
  const sessionId = newSession('forecast_today_to_sunday');
  const turnId = 't1';
  const result = await runAssistantQuery({
    userText:
      'Fala assistente, domingo agora eu quero sair pra gastar uma grana. Mas pra isso precisava saber quanto eu vou receber de hoje ate domingo pra mim saber quanto dinheiro eu vou ter pra gastar',
    screenContext: {},
    conversationContext: [],
    sessionId,
    turnId,
  });

  const expectedStart = todayISO();
  const expectedEnd = nextWeekdayISO(expectedStart, 0, true);
  assert.equal(result.mode, 'answer');
  assert.equal(String(result.intent || ''), 'previsao_recebimento_parcelas');
  assert.equal(Array.isArray(result.tool_trace), true);
  assert.equal(result.tool_trace.length > 0, true);
  assert.equal(String(result.tool_trace[0].tool || ''), 'parcelas_por_periodo');
  assert.equal(String(result.tool_trace[0].input && result.tool_trace[0].input.de), expectedStart);
  assert.equal(String(result.tool_trace[0].input && result.tool_trace[0].input.ate), expectedEnd);
  assert.equal(
    /qual\s+[ée]\s+a\s+data\s+de\s+hoje/i.test(String(result.answer_text || '')),
    false
  );
});

test('executeHybridFlow: factual primeiro, repo explicacao depois', async () => {
  const sourceDecision = __internal.normalizeKnowledgeSourceDecision({
    strategy: 'hybrid',
    should_use_repo_read: true,
    repo_goal: 'origin_calculation',
    repo_scope: 'backend',
    repo_budget: {
      search_calls: 1,
      open_calls: 2,
      max_snippets: 2,
      max_chars_total: 1200,
    },
  });

  const result = await __internal.executeHybridFlow({
    questionForAnswer: 'Quanto eu recebi em janeiro de 2025 e onde esta essa regra no codigo?',
    reasoningMode: 'simple',
    domainExecution: {
      validation: {
        tool_name: 'caixa_resumo',
        normalized_args: {
          periodo: 'custom',
          de: '2025-01-01',
          ate: '2025-01-31',
        },
      },
      resolvedContext: {},
      screenContext: {},
      sessionId: newSession('hybrid'),
      turnId: 't1',
      intent: 'resumo_caixa_recebimento',
      confidence: 0.9,
      conversationContext: [],
    },
    sourceDecision,
    semanticProfile: {
      semantic_intent: 'resumo',
      primary_entity: 'caixa',
    },
    requestClassification: {
      category: 'complexa',
    },
    planningUsageTrace: null,
    planningLatencyMs: 0,
  });

  assert.equal(Array.isArray(result.tool_trace), true);
  assert.equal(result.tool_trace.length > 1, true);
  assert.equal(String(result.tool_trace[0].tool || ''), 'caixa_resumo');
  assert.equal(
    result.tool_trace.slice(1).some((item) => String(item.tool || '').startsWith('repo_')),
    true
  );
  assert.equal(Array.isArray(result.repo_evidence), true);
  assert.equal(result.repo_evidence.length <= 2, true);
  assert.equal(String(result.answer_text || '').includes('Origem no sistema'), true);
});
