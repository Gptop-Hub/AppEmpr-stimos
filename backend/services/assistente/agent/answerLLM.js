const { buildAnswerSystemPrompt } = require('../systemPrompt');
const { callOpenAIChat, getOpenAIConfig } = require('./planningLLM');

function sanitizeText(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function summarizeValue(value, options = {}) {
  const depth = Number(options.depth || 0);
  const maxArrayItems = Number(options.maxArrayItems || 10);
  const maxObjectKeys = Number(options.maxObjectKeys || 20);
  const maxString = Number(options.maxString || 320);

  if (value == null) return value;

  if (typeof value === 'string') {
    if (value.length <= maxString) return value;
    return `${value.slice(0, maxString)}... [truncado ${value.length - maxString} chars]`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth <= 0) {
      return {
        _kind: 'array',
        _length: value.length,
      };
    }
    const items = value
      .slice(0, maxArrayItems)
      .map((item) => summarizeValue(item, {
        ...options,
        depth: depth - 1,
      }));

    if (value.length > maxArrayItems) {
      items.push({
        _truncated_items: value.length - maxArrayItems,
      });
    }

    return items;
  }

  if (typeof value === 'object') {
    if (depth <= 0) {
      return {
        _kind: 'object',
        _keys: Object.keys(value).slice(0, maxObjectKeys),
      };
    }

    const out = {};
    const keys = Object.keys(value).slice(0, maxObjectKeys);
    for (const key of keys) {
      out[key] = summarizeValue(value[key], {
        ...options,
        depth: depth - 1,
      });
    }
    if (Object.keys(value).length > maxObjectKeys) {
      out._truncated_keys = Object.keys(value).length - maxObjectKeys;
    }
    return out;
  }

  return sanitizeText(value, '');
}

function compactSources(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  return list.slice(0, 8).map((src) => ({
    source_type: sanitizeText(src && src.source_type, 'unknown'),
    label: sanitizeText(src && (src.label || src.reference || src.tool || src.path), 'source'),
    tool: sanitizeText(src && src.tool, ''),
  }));
}

async function generateAnswerWithLLM({
  userText,
  route,
  requestClassification,
  domainPlan,
  resolvedContext,
  selectedTool,
  domainSummary,
  codeSummary,
  logSummary,
  repoEvidence,
  sources,
  verification,
  notes,
}) {
  const cfg = getOpenAIConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_api_key',
      answer_text: '',
      model: null,
      usage: null,
      latency_ms: 0,
    };
  }

  const payload = {
    user_text: sanitizeText(userText),
    request_classification: summarizeValue(requestClassification, {
      depth: 2,
      maxArrayItems: 6,
      maxObjectKeys: 20,
      maxString: 160,
    }),
    route: summarizeValue(route, {
      depth: 2,
      maxArrayItems: 6,
      maxObjectKeys: 18,
      maxString: 160,
    }),
    selected_plan: {
      intent: sanitizeText(domainPlan && domainPlan.intent, ''),
      tool_name: sanitizeText(selectedTool && selectedTool.name, ''),
      tool_args: summarizeValue(selectedTool && selectedTool.args, {
        depth: 2,
        maxArrayItems: 8,
        maxObjectKeys: 20,
        maxString: 180,
      }),
    },
    tool_result: summarizeValue(selectedTool && selectedTool.result, {
      depth: 2,
      maxArrayItems: 10,
      maxObjectKeys: 30,
      maxString: 240,
    }),
    resolved_context: summarizeValue(resolvedContext, {
      depth: 2,
      maxArrayItems: 8,
      maxObjectKeys: 18,
      maxString: 160,
    }),
    summaries: {
      domain: sanitizeText(domainSummary),
      code: sanitizeText(codeSummary),
      logs: sanitizeText(logSummary),
    },
    verification: summarizeValue(verification, {
      depth: 2,
      maxArrayItems: 10,
      maxObjectKeys: 20,
      maxString: 160,
    }),
    repo_evidence: summarizeValue(Array.isArray(repoEvidence) ? repoEvidence.slice(0, 4) : [], {
      depth: 2,
      maxArrayItems: 4,
      maxObjectKeys: 12,
      maxString: 220,
    }),
    sources: compactSources(sources),
    notes: Array.isArray(notes)
      ? notes.map((n) => sanitizeText(n)).filter(Boolean).slice(0, 8)
      : [],
    constraints: {
      read_only: true,
      never_hallucinate: true,
      acknowledge_limitations: true,
      concise_default: true,
      language: 'pt-BR',
    },
  };

  const system = [
    buildAnswerSystemPrompt(),
    '',
    'INSTRUCOES ADICIONAIS:',
    '- Voce recebera dados estruturados da orquestracao.',
    '- Responda APENAS com o texto final para o usuario (sem JSON).',
    '- Nao repita payload bruto; sintetize com precisao.',
    '- Se houver conflito/baixa confianca, explicite de forma curta.',
    '- Nao afirme acao de escrita. Ambiente read-only.',
  ].join('\n');

  const startedAt = Date.now();
  const llm = await callOpenAIChat({
    model: cfg.modelAnswer,
    temperature: 0.1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });
  const latencyMs = Date.now() - startedAt;

  if (!llm.ok) {
    return {
      ok: false,
      skipped: false,
      reason: llm.error || 'answer_llm_failed',
      answer_text: '',
      model: llm.model || cfg.modelAnswer,
      usage: llm.usage || null,
      latency_ms: latencyMs,
      unavailable: Boolean(llm.unavailable),
    };
  }

  const answerText = sanitizeText(llm.content);
  if (!answerText) {
    return {
      ok: false,
      skipped: false,
      reason: 'empty_answer_content',
      answer_text: '',
      model: llm.model || cfg.modelAnswer,
      usage: llm.usage || null,
      latency_ms: latencyMs,
    };
  }

  return {
    ok: true,
    skipped: false,
    reason: null,
    answer_text: answerText,
    model: llm.model || cfg.modelAnswer,
    usage: llm.usage || null,
    latency_ms: latencyMs,
  };
}

module.exports = {
  generateAnswerWithLLM,
  __internal: {
    summarizeValue,
    compactSources,
  },
};
