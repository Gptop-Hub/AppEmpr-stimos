const { getToolCatalog, sanitizeScreenContext } = require('./contracts');
const {
  applyActiveContextToScreenContext,
  getSessionConversationContext,
  getSessionMemorySnapshot,
  maybeResetSessionContext,
  mergeConversationContexts,
  recordConversationTurn,
} = require('./conversationMemory');
const {
  buildPlanningSystemPrompt,
  buildAnswerSystemPrompt,
} = require('./systemPrompt');
const { getOpenAIConfig } = require('./agent/planningLLM');
const { runAgentLoop, __internal: agentInternal } = require('./agent/agentLoop');
// O legado so e necessario para os helpers de regressao. No modo de teste
// read-only ele nao deve inicializar as dependencias antigas que abrem o DB.
const legacyOrchestrator = process.env.ASSISTANT_READONLY_TEST_MODE === '1'
  ? null
  : require('./orchestrator.legacy');

const MAX_MEMORY_TURNS_HINT = 5;

function normalizeConversationContext(rawContext) {
  if (!Array.isArray(rawContext)) return [];
  const cleaned = [];

  for (const item of rawContext) {
    if (!item || typeof item !== 'object') continue;
    const role = String(item.role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const text = String(item.text || '').trim();
    if (!text) continue;

    const quality = String(item.quality || 'unknown').trim().toLowerCase();
    if (quality === 'rejected') continue;

    cleaned.push({
      role,
      text: text.slice(0, 1000),
      quality: quality === 'approved' ? 'approved' : 'unknown',
      turn_id: item.turn_id ? String(item.turn_id).trim() : null,
      mode: String(item.mode || 'answer').trim().toLowerCase(),
    });
  }

  if (cleaned.length <= 10) return cleaned;
  return cleaned.slice(cleaned.length - 10);
}

function mergeTelemetry(baseTelemetry, extraTelemetry) {
  const base = baseTelemetry && typeof baseTelemetry === 'object' ? baseTelemetry : {};
  const extra = extraTelemetry && typeof extraTelemetry === 'object' ? extraTelemetry : {};
  return {
    ...base,
    ...extra,
  };
}

function appendRuntimeTelemetry(resultPayload, runStartedAt) {
  const payload = resultPayload && typeof resultPayload === 'object' ? { ...resultPayload } : {};
  payload.telemetry = mergeTelemetry(payload.telemetry, {
    run_total_ms: Date.now() - runStartedAt,
  });
  return payload;
}

function registerMemoryTurn({ sessionId, turnId, question, payload }) {
  try {
    const firstToolTrace = Array.isArray(payload.tool_trace) && payload.tool_trace.length
      ? payload.tool_trace[0]
      : null;

    return recordConversationTurn({
      sessionId,
      turnId,
      userText: question,
      answerText: payload.answer_text,
      mode: payload.mode || 'answer',
      intent: payload.intent || '',
      questionType:
        payload && payload.request_classification && payload.request_classification.route
          ? String(payload.request_classification.route.category || '')
          : '',
      entities: {},
      resolvedContext: payload.resolved_context || {},
      toolName: firstToolTrace && firstToolTrace.tool ? firstToolTrace.tool : '',
      toolArgs: firstToolTrace && firstToolTrace.input ? firstToolTrace.input : {},
      financialResult: payload && payload.semantic_memory_candidate
        ? payload.semantic_memory_candidate
        : null,
    });
  } catch (err) {
    console.error('[assistente/memory] erro ao registrar turno:', err);
    return null;
  }
}

async function runAssistantQuery({
  userText,
  screenContext,
  conversationContext,
  sessionId,
  turnId,
}) {
  const runStartedAt = Date.now();
  const question = String(userText || '').trim();
  if (!question) {
    throw new Error('Pergunta vazia.');
  }

  maybeResetSessionContext(sessionId, question);

  const memorySnapshot = getSessionMemorySnapshot(sessionId);
  const safeScreenContext = applyActiveContextToScreenContext(
    sanitizeScreenContext(screenContext),
    memorySnapshot && memorySnapshot.active_context ? memorySnapshot.active_context : {}
  );
  const safeConversationContext = normalizeConversationContext(conversationContext);
  const memoryConversationContext = getSessionConversationContext(sessionId);
  const mergedConversationContext = mergeConversationContexts(
    safeConversationContext,
    memoryConversationContext
  );

  const memoryContext = {
    active_context: memorySnapshot && memorySnapshot.active_context
      ? memorySnapshot.active_context
      : {},
    recent_turns: memorySnapshot && Array.isArray(memorySnapshot.recent_turns)
      ? memorySnapshot.recent_turns.slice(-MAX_MEMORY_TURNS_HINT)
      : [],
    active_entities: memorySnapshot && memorySnapshot.active_entities
      ? memorySnapshot.active_entities
      : {},
    result_sets: memorySnapshot && Array.isArray(memorySnapshot.result_sets)
      ? memorySnapshot.result_sets
      : [],
    last_financial_query: memorySnapshot && memorySnapshot.last_financial_query
      ? memorySnapshot.last_financial_query
      : null,
    pending_action_draft: memorySnapshot && memorySnapshot.pending_action_draft
      ? memorySnapshot.pending_action_draft
      : null,
  };

  try {
    const result = await runAgentLoop({
      userText: question,
      screenContext: safeScreenContext,
      conversationContext: mergedConversationContext,
      memoryContext,
      sessionId,
      turnId,
    });

    const payload = appendRuntimeTelemetry(result, runStartedAt);
    const memoryUpdate = registerMemoryTurn({
      sessionId,
      turnId,
      question,
      payload,
    });
    if (memoryUpdate && memoryUpdate.result_set) {
      payload.semantic_memory = {
        result_set: memoryUpdate.result_set,
      };
    }
    delete payload.semantic_memory_candidate;

    return payload;
  } catch (err) {
    if (err && err.code === 'assistant_provider_unavailable') {
      throw err;
    }
    console.error('[assistente/agent_loop_v2] erro:', err);

    const fallback = appendRuntimeTelemetry(
      {
        mode: 'error',
        reasoning_mode: 'agent_loop_v2',
        request_classification: {
          category: 'complexa',
          route: {
            category: 'investigation_diagnostic',
            confidence: 0.2,
            reasons: ['agent_loop_exception'],
          },
        },
        answer_text:
          'Falhei ao executar o novo fluxo do assistente. Tente novamente com mais contexto ou verifique logs do backend.',
        intent: 'erro_execucao',
        confidence: 0.2,
        resolved_context: {},
        tool_trace: [],
        repo_trace: [],
        repo_evidence: [],
        sources: [
          {
            source_type: 'logs',
            label: 'agent_loop_exception',
            details: err && err.message ? String(err.message) : 'erro_sem_mensagem',
          },
        ],
        verification: {
          validated: false,
          confidence: 0.2,
          source_stats: {
            database: 0,
            code: 0,
            logs: 1,
            endpoint: 0,
            inference: 0,
            other: 0,
          },
          conflicts: [],
          execution_errors: [err && err.message ? String(err.message) : 'erro_sem_mensagem'],
        },
        session_id: sessionId || null,
        turn_id: turnId || null,
        follow_up: null,
        usage_trace: {
          planning: {
            model: null,
            usage: null,
            metadata: {
              planner: 'fallback_error',
            },
          },
          answer: {
            model: null,
            usage: null,
            metadata: {
              generation: 'fallback_error',
            },
          },
        },
        telemetry: {
          flow: 'agent_loop_v2',
          planning_ms: 0,
          tool_execution_ms: 0,
          response_generation_ms: 0,
          orchestration_ms: 0,
        },
      },
      runStartedAt
    );

    registerMemoryTurn({
      sessionId,
      turnId,
      question,
      payload: fallback,
    });

    return fallback;
  }
}

function warmupAssistantPipeline() {
  const cfg = getOpenAIConfig();
  const domainCatalog = getToolCatalog({ includeRepoRead: false });
  const fullCatalog = getToolCatalog({ includeRepoRead: true });

  buildPlanningSystemPrompt();
  buildAnswerSystemPrompt();

  return {
    ready: true,
    has_api_key: Boolean(cfg.apiKey),
    model_planning: cfg.modelPlanning,
    model_answer: cfg.modelAnswer,
    tools_domain_count: domainCatalog.length,
    tools_total_count: fullCatalog.length + 5,
    warmup_mode: 'agent_loop_v2',
    warmed_at: new Date().toISOString(),
  };
}

module.exports = {
  runAssistantQuery,
  warmupAssistantPipeline,
  __internal: {
    normalizeConversationContext,
    ...((legacyOrchestrator && legacyOrchestrator.__internal) || {}),
    ...agentInternal,
  },
};
