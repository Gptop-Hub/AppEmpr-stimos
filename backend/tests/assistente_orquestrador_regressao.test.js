const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../services/assistente/orchestrator');
const { resolveToolCallWithContext } = require('../services/assistente/contextResolver');
const {
  clearPendingClarification,
  resolvePendingClarificationSelection,
  setPendingClarification,
} = require('../services/assistente/conversationMemory');

function currentYear() {
  return new Date().getFullYear();
}

function currentMonth() {
  return new Date().getMonth() + 1;
}

function todayISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function nextMonthDayISO(dayRaw) {
  const day = Number(dayRaw);
  const d = new Date();
  let year = d.getFullYear();
  let month = d.getMonth() + 2;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.max(1, Math.min(day, lastDay));
  return `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

test('rota deterministica: recebimento com periodo + juros/capital vai direto para caixa_resumo', () => {
  const route = __internal.detectDeterministicRoute({
    userText: 'Quanto eu recebi do comeco de 2024 ate o final de 2025? separa juros e capital por favor',
    screenContext: {},
  });

  assert.equal(route.matched, true);
  assert.equal(route.tool_name, 'caixa_resumo');
  assert.deepEqual(route.tool_args, {
    periodo: 'custom',
    de: '2024-01-01',
    ate: '2025-12-31',
  });
});

test('remove fallback hoje: parcelas_por_periodo sem de/ate exige clarificacao', () => {
  const resolved = resolveToolCallWithContext({
    toolName: 'parcelas_por_periodo',
    toolArgs: { tipo: 'vencidas' },
    entities: {},
    screenContext: {},
  });

  assert.equal(resolved.needs_clarification, true);
  assert.match(
    String(resolved.clarification_question || ''),
    /periodo|data/i
  );
});

test('remove fallback hoje: caixa_resumo sem periodo explicito exige clarificacao', () => {
  const resolved = resolveToolCallWithContext({
    toolName: 'caixa_resumo',
    toolArgs: {},
    entities: {},
    screenContext: {},
  });

  assert.equal(resolved.needs_clarification, true);
  assert.match(
    String(resolved.clarification_question || ''),
    /periodo|data/i
  );
});

test('bloqueio semantico: corrige tool errada para caixa_resumo em pergunta de recebimento', () => {
  const guard = __internal.applySemanticSafetyGuard({
    userText: 'Quanto eu recebi de 2024 ate 2025, separa juros e capital',
    planning: {
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: 'vencendo',
        de: '2024-01-01',
        ate: '2025-12-31',
      },
      intent: 'resumo',
    },
    semanticProfile: {
      temporal_scope: {
        reference: 'intervalo_explicito',
        de: '2024-01-01',
        ate: '2025-12-31',
      },
    },
  });

  assert.equal(guard.blocked, false);
  assert.equal(guard.corrected, true);
  assert.equal(guard.planning.tool_name, 'caixa_resumo');
  assert.deepEqual(guard.planning.tool_args, {
    periodo: 'custom',
    de: '2024-01-01',
    ate: '2025-12-31',
  });
});

test('opcao 1/2 executa candidata direta sem reinterpretacao', () => {
  const sessionId = `sess_test_${Date.now()}`;
  setPendingClarification(sessionId, {
    original_question: 'Quanto eu recebi?',
    original_intent: 'resumo_caixa_recebimento',
    options: ['total de entradas no caixa', 'total de parcelas/pagamentos recebidos'],
    candidates: [
      {
        label: 'total de entradas no caixa',
        tool_name: 'caixa_resumo',
        tool_args: {
          periodo: 'custom',
          de: '2024-01-01',
          ate: '2025-12-31',
        },
      },
      {
        label: 'total de parcelas/pagamentos recebidos',
        tool_name: 'parcelas_por_periodo',
        tool_args: {
          tipo: 'todas',
          de: '2024-01-01',
          ate: '2025-12-31',
          incluirPagas: true,
        },
      },
    ],
  });

  const resolved = resolvePendingClarificationSelection({
    sessionId,
    userText: '1',
  });

  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.candidate);
  assert.equal(resolved.candidate.tool_name, 'caixa_resumo');
  assert.deepEqual(resolved.candidate.tool_args, {
    periodo: 'custom',
    de: '2024-01-01',
    ate: '2025-12-31',
  });
  clearPendingClarification(sessionId);
});

test('sem periodo nao gera candidata automatica com fallback de hoje para evento/estoque', () => {
  const candidates = __internal.buildPendingClarificationCandidates({
    planning: {
      question_type: 'ambiguous_event_vs_stock',
      tool_args: {},
      entities: {},
    },
    decision: {
      ambiguity_options: [
        'parcelas que vencem no periodo (evento)',
        'parcelas ja vencidas/em aberto (estoque)',
      ],
    },
    requestClassification: {
      possible_event_vs_stock: true,
    },
    screenContext: {},
    resolvedContext: {},
  });

  assert.equal(Array.isArray(candidates), true);
  assert.equal(candidates.length, 0);
});

test('parser natural: "28 de outubro" vira data explicita no ano corrente', () => {
  const scope = __internal.inferTemporalScope({
    userText: 'quais clientes vao vencer no dia 28 de outubro?',
    planning: {},
    screenContext: {},
  });

  const year = currentYear();
  assert.equal(scope.reference, 'data_explicita');
  assert.equal(scope.de, `${year}-10-28`);
  assert.equal(scope.ate, `${year}-10-28`);
});

test('parser natural: "dia 15" assume mes/ano correntes', () => {
  const scope = __internal.inferTemporalScope({
    userText: 'quais clientes vencem no dia 15?',
    planning: {},
    screenContext: {},
  });

  const year = currentYear();
  const month = String(currentMonth()).padStart(2, '0');
  assert.equal(scope.reference, 'data_explicita');
  assert.equal(scope.de, `${year}-${month}-15`);
  assert.equal(scope.ate, `${year}-${month}-15`);
});

test('parser natural: "semana que vem" gera intervalo valido', () => {
  const scope = __internal.inferTemporalScope({
    userText: 'quero ver quem vence semana que vem',
    planning: {},
    screenContext: {},
  });

  assert.equal(scope.reference, 'semana_que_vem');
  assert.match(String(scope.de || ''), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(scope.ate || ''), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(scope.de <= scope.ate, true);
});

test('multi-intent: rota deterministica de vencimento usa parcelas_por_periodo no dia explicito', () => {
  const route = __internal.detectDeterministicRoute({
    userText: 'quantos clientes e quais clientes vao vencer no dia 28 de outubro? e quanto eu vou receber se eles pagarem certinho',
    screenContext: {},
  });

  const year = currentYear();
  assert.equal(route.matched, true);
  assert.equal(route.reason, 'deterministic_event_multi_intent');
  assert.equal(route.tool_name, 'parcelas_por_periodo');
  assert.deepEqual(route.tool_args, {
    tipo: 'vencendo',
    de: `${year}-10-28`,
    ate: `${year}-10-28`,
    incluirPagas: false,
  });
  assert.equal(Boolean(route.multi_intent && route.multi_intent.count), true);
  assert.equal(Boolean(route.multi_intent && route.multi_intent.list), true);
  assert.equal(Boolean(route.multi_intent && route.multi_intent.sum), true);
});

test('resposta local multi-intent retorna contagem, lista e soma de valor_total', () => {
  const answer = __internal.buildSimpleNaturalAnswerFromTool({
    toolName: 'parcelas_por_periodo',
    toolArgs: {
      tipo: 'vencendo',
      de: '2026-10-28',
      ate: '2026-10-28',
      incluirPagas: false,
    },
    toolResult: {
      tipo: 'vencendo',
      de: '2026-10-28',
      ate: '2026-10-28',
      total: 3,
      parcelas: [
        { cliente_id: 10, cliente_nome: 'Ana', valor_total: 100 },
        { cliente_id: 11, cliente_nome: 'Bruno', valor_total: 250.5 },
        { cliente_id: 10, cliente_nome: 'Ana', valor_total: 49.5 },
      ],
    },
    intent: 'evento_parcelas_multi_intent',
    requestClassification: {
      deterministic_route: {
        matched: true,
        multi_intent: { count: true, list: true, sum: true },
      },
    },
  });

  assert.match(answer, /2 cliente\(s\)/i);
  assert.match(answer, /Clientes:/i);
  assert.match(answer, /Ana/);
  assert.match(answer, /Bruno/);
  assert.match(answer, /Soma prevista \(valor_total\):/i);
  assert.match(answer, /R\$\s*400,00/i);
});

test('perfil semantico: pergunta de top clientes em atraso nao dispara ReferenceError', () => {
  const profile = __internal.buildSemanticDecisionProfile({
    userText: 'Quais sao os clientes que tem o maior valor em atraso? Os cinco maiores clientes.',
    planning: {},
    requestClassification: {},
    screenContext: {},
  });

  assert.equal(typeof profile, 'object');
  assert.equal(Boolean(profile && profile.semantic_intent), true);
  assert.equal(Boolean(profile && profile.multi_intent), true);
  assert.equal(typeof profile.is_multi_intent, 'boolean');
});

test('parser relativo: "do dia de hoje ate o dia 15 do mes que vem" monta intervalo correto', () => {
  const scope = __internal.inferTemporalScope({
    userText: 'quanto eu vou receber do dia de hoje ate o dia 15 do mes que vem?',
    planning: {},
    screenContext: {},
  });

  assert.equal(scope.reference, 'intervalo_relativo');
  assert.equal(scope.de, todayISO());
  assert.equal(scope.ate, nextMonthDayISO(15));
});

test('parser relativo tolera texto com acentuacao corrompida (at�/m�s)', () => {
  const scope = __internal.inferTemporalScope({
    userText: 'quanto eu vou receber do dia de hoje at\uFFFD o dia 15 do m\uFFFDs que vem?',
    planning: {},
    screenContext: {},
  });

  assert.equal(scope.reference, 'intervalo_relativo');
  assert.equal(scope.de, todayISO());
  assert.equal(scope.ate, nextMonthDayISO(15));
});

test('deterministico: previsao de recebimento em intervalo roteia para parcelas_por_periodo', () => {
  const route = __internal.detectDeterministicRoute({
    userText: 'quanto eu vou receber do dia de hoje ate o dia 15 do mes que vem',
    screenContext: {},
  });

  assert.equal(route.matched, true);
  assert.equal(route.reason, 'deterministic_forecast_receivable_summary');
  assert.equal(route.tool_name, 'parcelas_por_periodo');
  assert.deepEqual(route.tool_args, {
    tipo: 'vencendo',
    de: todayISO(),
    ate: nextMonthDayISO(15),
    incluirPagas: false,
  });
});

test('deterministico: previsao com texto corrompido ainda roteia para parcelas_por_periodo', () => {
  const route = __internal.detectDeterministicRoute({
    userText: 'quanto eu vou receber do dia de hoje at\uFFFD o dia 15 do m\uFFFDs que vem',
    screenContext: {},
  });

  assert.equal(route.matched, true);
  assert.equal(route.reason, 'deterministic_forecast_receivable_summary');
  assert.equal(route.tool_name, 'parcelas_por_periodo');
  assert.deepEqual(route.tool_args, {
    tipo: 'vencendo',
    de: todayISO(),
    ate: nextMonthDayISO(15),
    incluirPagas: false,
  });
});

test('guard semantico: previsao de recebimento nao forca caixa_resumo', () => {
  const guard = __internal.applySemanticSafetyGuard({
    userText: 'quanto eu vou receber do dia de hoje ate o dia 15 do mes que vem se pagarem certinho',
    planning: {
      tool_name: 'parcelas_por_periodo',
      tool_args: {
        tipo: 'vencendo',
        de: todayISO(),
        ate: nextMonthDayISO(15),
      },
      intent: 'previsao_recebimento_parcelas',
    },
    semanticProfile: {
      semantic_intent: 'evento',
      temporal_scope: {
        reference: 'intervalo_relativo',
        de: todayISO(),
        ate: nextMonthDayISO(15),
      },
    },
  });

  assert.equal(guard.blocked, false);
  assert.equal(guard.corrected, false);
  assert.equal(guard.planning.tool_name, 'parcelas_por_periodo');
});

test('resposta local de previsao retorna soma + contagem + clientes unicos', () => {
  const answer = __internal.buildSimpleNaturalAnswerFromTool({
    toolName: 'parcelas_por_periodo',
    toolArgs: {
      tipo: 'vencendo',
      de: '2026-03-30',
      ate: '2026-04-15',
      incluirPagas: false,
    },
    toolResult: {
      tipo: 'vencendo',
      de: '2026-03-30',
      ate: '2026-04-15',
      total: 3,
      parcelas: [
        { cliente_id: 10, cliente_nome: 'Ana', valor_total: 100 },
        { cliente_id: 11, cliente_nome: 'Bruno', valor_total: 250.5 },
        { cliente_id: 10, cliente_nome: 'Ana', valor_total: 49.5 },
      ],
    },
    intent: 'previsao_recebimento_parcelas',
    requestClassification: {
      deterministic_route: {
        matched: true,
        reason: 'deterministic_forecast_receivable_summary',
      },
    },
  });

  assert.match(answer, /voce deve receber/i);
  assert.match(answer, /Parcelas previstas:\s*3/i);
  assert.match(answer, /Clientes unicos:\s*2/i);
  assert.match(answer, /R\$\s*400,00/i);
});
