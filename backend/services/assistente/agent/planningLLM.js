const { actionRegistry } = require('../actions/actionRegistry');

function getOpenAIConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
  const fallbackModel = String(process.env.OPENAI_ASSISTANT_MODEL || 'gpt-4o-mini').trim();
  const modelPlanning = String(
    process.env.OPENAI_ASSISTANT_MODEL_PLANNING || fallbackModel
  ).trim();
  const modelAnswer = String(
    process.env.OPENAI_ASSISTANT_MODEL_ANSWER || fallbackModel
  ).trim();
  return {
    apiKey,
    baseUrl,
    modelPlanning,
    modelAnswer,
  };
}

function extractMessageContent(completionPayload) {
  const choices = Array.isArray(completionPayload && completionPayload.choices)
    ? completionPayload.choices
    : [];
  if (!choices.length) return '';

  const first = choices[0] && choices[0].message ? choices[0].message : {};
  const content = first.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getProviderErrorMetadata(status, errorText) {
  let providerCode = '';
  try {
    const parsed = JSON.parse(errorText);
    providerCode = String(
      parsed && parsed.error && (parsed.error.code || parsed.error.type) ?
        (parsed.error.code || parsed.error.type) : ''
    ).trim();
  } catch {}
  return {
    status: Number(status) || 0,
    provider_code: providerCode,
    unavailable: Number(status) === 429,
  };
}

async function callOpenAIChat({ model, messages, temperature = 0.1, responseFormat = null }) {
  const cfg = getOpenAIConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      error: 'OPENAI_API_KEY nao configurada.',
      model,
      usage: null,
      content: '',
    };
  }

  const payload = {
    model,
    messages,
    temperature,
  };
  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '');
    const provider = getProviderErrorMetadata(resp.status, errorText);
    return {
      ok: false,
      error: `Falha na API OpenAI (${resp.status}) ${errorText}`.trim(),
      model,
      usage: null,
      content: '',
      ...provider,
    };
  }

  const data = await resp.json();
  return {
    ok: true,
    error: null,
    model: data && typeof data.model === 'string' ? data.model : model,
    usage: data && data.usage ? data.usage : null,
    content: extractMessageContent(data),
  };
}

function normalizePlan(rawPlan) {
  const raw = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
  const toolArgs = raw.tool_args && typeof raw.tool_args === 'object' && !Array.isArray(raw.tool_args)
    ? raw.tool_args
    : {};
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name.trim() : '';
  const sqlQuery = typeof raw.sql_query === 'string' ? raw.sql_query.trim() : '';
  const resultSetId = typeof raw.result_set_id === 'string' ? raw.result_set_id.trim().slice(0, 120) : '';
  const resultSetType = typeof raw.result_set_type === 'string' ? raw.result_set_type.trim().toLowerCase() : '';
  const resultSetFilters = raw.result_set_filters && typeof raw.result_set_filters === 'object' && !Array.isArray(raw.result_set_filters)
    ? raw.result_set_filters
    : {};
  const scopeSql = typeof raw.scope_sql === 'string' ? raw.scope_sql.trim() : '';
  const actionProposal = raw.action_proposal && typeof raw.action_proposal === 'object' && !Array.isArray(raw.action_proposal)
    ? { ...raw.action_proposal }
    : null;
  const actionDraft = raw.action_draft && typeof raw.action_draft === 'object' && !Array.isArray(raw.action_draft)
    ? { ...raw.action_draft }
    : null;

  return {
    intent: typeof raw.intent === 'string' ? raw.intent.trim() : '',
    strategy: typeof raw.strategy === 'string' ? raw.strategy.trim().toLowerCase() : '',
    tool_name: toolName,
    tool_args: toolArgs,
    needs_clarification: Boolean(raw.needs_clarification),
    clarification_question: typeof raw.clarification_question === 'string'
      ? raw.clarification_question.trim()
      : '',
    confidence: Number.isFinite(Number(raw.confidence))
      ? Math.max(0, Math.min(1, Number(raw.confidence)))
      : null,
    wants_code_evidence: Boolean(raw.wants_code_evidence),
    wants_logs: Boolean(raw.wants_logs),
    wants_runtime_sql: Boolean(raw.wants_runtime_sql) || (toolName === 'query_financial_data' && Boolean(sqlQuery)),
    sql_query: sqlQuery,
    result_set_id: resultSetId,
    result_set_type: resultSetType,
    result_set_description: typeof raw.result_set_description === 'string'
      ? raw.result_set_description.trim().slice(0, 240)
      : '',
    result_set_filters: resultSetFilters,
    semantic_intent: typeof raw.semantic_intent === 'string' ? raw.semantic_intent.trim().slice(0, 120) : '',
    aggregation: typeof raw.aggregation === 'string' ? raw.aggregation.trim().slice(0, 120) : '',
    temporal_scope: typeof raw.temporal_scope === 'string' ? raw.temporal_scope.trim().slice(0, 120) : '',
    period_reference: typeof raw.period_reference === 'string' ? raw.period_reference.trim().slice(0, 120) : '',
    scope_entity_type: typeof raw.scope_entity_type === 'string'
      ? raw.scope_entity_type.trim().toLowerCase()
      : '',
    scope_sql: scopeSql,
    action_proposal: actionProposal,
    action_draft: actionDraft,
  };
}

async function planWithLLM({
  userText,
  screenContext,
  conversationContext,
  toolCatalog,
  runtimeToolCatalog,
  financialSchema,
  semanticMemory,
  actionResolution = null,
}) {
  const cfg = getOpenAIConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_api_key',
      plan: null,
      usage: null,
      model: null,
    };
  }

  const actionCatalog = actionRegistry.list().map((action) => ({ action: action.name, required_fields: action.required_fields, description: action.description }));
  const systemPrompt = [
    'Voce planeja consultas para um assistente interno de sistema financeiro.',
    `Acoes estruturadas disponiveis: ${JSON.stringify(actionCatalog)}.`,
    'Nunca invente dados. Nunca proponha escrita no banco nem SQL de escrita.',
    'Voce tambem pode propor uma unica acao financeira, mas somente retornando action_proposal estruturada. Nunca execute a acao, nunca retorne URL, endpoint ou SQL para ela.',
    'Somente proponha acoes presentes no catalogo estruturado. Escolha semanticamente pelo significado do pedido; se houver ambiguidade entre modalidades financeiras, deixe action_proposal nula e peca esclarecimento. Para qualquer outra acao, explique que ela nao esta disponivel.',
    'Somente produza action_proposal quando todos os campos forem explicitos e os IDs exatos estiverem no screen_context ou semantic_memory.active_context/active_entities. Se houver mais de uma entidade ou faltar algum dado, deixe action_proposal nula e peca somente o dado faltante.',
    'Nao use data atual por padrao: data precisa estar explicita em YYYY-MM-DD. Nunca invente valor, cliente, emprestimo ou tipo.',
    'Quando houver pending_action_draft, decida semanticamente se deve criar/atualizar/manter/abandonar o draft, responder uma pergunta paralela ou consultar dados. Nao use regras por palavras.',
    'Para um rascunho de acao, use action_draft somente com decision, action e os campos definidos no catalogo. decision e create, update, keep ou abandon.',
    'Se precisar resolver entidades fora do contexto, use apenas query_financial_data com SELECT/WITH de leitura. O resultado seguro voltara em action_resolution_context para um novo planejamento. Nunca escreva SQL de acao.',
    'Se a consulta encontrar mais de um cliente ou emprestimo, nao escolha um ID: deixe o campo ausente e faca uma pergunta de desambiguacao sem CPF, telefone ou endereco.',
    'Para perguntas financeiras livres, priorize query_financial_data e escreva uma unica consulta SELECT ou WITH.',
    'Nao dependa de intents fixas: escolha a consulta a partir da pergunta, do contexto e do schema recebido.',
    'Use somente tabelas e colunas do schema recebido. Nao consulte cpf, telefone, endereco, foto_cliente ou referencia.',
    'Nao use PRAGMA, EXPLAIN, comentarios SQL, subconsultas recursivas ou qualquer comando de escrita.',
    'Se receber result_sets de memoria semantica relevantes, interprete a pergunta atual livremente com esse contexto; nao use listas de frases ou intents de follow-up.',
    'Para reutilizar um result_set, retorne seu result_set_id e escreva SQL que faca JOIN ou IN com semantic_result_set(entity_id). O backend injeta essa CTE com IDs parametrizados e ela so existe quando result_set_id for valido.',
    'Se a pergunta nao depender de um conjunto anterior, deixe result_set_id vazio. Nao presuma que o conjunto mais recente seja relevante.',
    'Quando a resposta analitica representar um conjunto identificavel de entidades, declare scope_entity_type e scope_sql. scope_sql deve conter TODOS os filtros do universo e usar exatamente SELECT DISTINCT scope_root.id AS entity_id FROM <tabela> AS scope_root ....',
    'Quando scope_sql existir, sql_query deve obrigatoriamente usar exatamente FROM <tabela> AS scope_root JOIN semantic_result_set AS scope_ids ON scope_ids.entity_id = scope_root.id. Nao use WHERE, HAVING, WITH, subconsulta ou CROSS JOIN em sql_query: todos os filtros pertencem a scope_sql.',
    'O backend executa scope_sql primeiro e injeta semantic_result_set; se sql_query nao usar esse vinculo estrutural, a analise sera recusada.',
    'Nao declare scope_sql para uma entidade que nao esteja semanticamente definida. Se o resultado principal ja listar IDs, scope_sql continua opcional.',
    'Use repo_read para responder sobre codigo/arquitetura/regra.',
    'Peca esclarecimento apenas quando a pergunta realmente nao tiver periodo ou criterio necessario; nao peca esclarecimento se o banco puder responder diretamente.',
    'Retorne apenas JSON valido com as chaves exatas solicitadas.',
  ].join('\n');

  const userPayload = {
    user_text: String(userText || ''),
    screen_context: screenContext || {},
    conversation_context: Array.isArray(conversationContext) ? conversationContext.slice(-10) : [],
    available_domain_tools: Array.isArray(toolCatalog) ? toolCatalog : [],
    available_runtime_tools: Array.isArray(runtimeToolCatalog) ? runtimeToolCatalog : [],
    financial_schema: financialSchema && typeof financialSchema === 'object' ? financialSchema : { tables: [] },
    semantic_memory: semanticMemory && typeof semanticMemory === 'object' ? semanticMemory : { result_sets: [] },
    action_resolution_context: actionResolution && typeof actionResolution === 'object' ? actionResolution : null,
    output_schema: {
      intent: 'string',
      strategy: 'financial_query | domain_only | repo_only | hybrid | diagnostic | clarification',
      tool_name: 'string',
      tool_args: 'object',
      needs_clarification: 'boolean',
      clarification_question: 'string',
      confidence: 'number_0_1',
      wants_code_evidence: 'boolean',
      wants_logs: 'boolean',
      wants_runtime_sql: 'boolean',
      sql_query: 'string',
      result_set_id: 'string_optional',
      result_set_type: 'cliente | emprestimo | parcela | pagamento | agregado',
      result_set_description: 'string_short_without_pii',
      result_set_filters: 'object_without_pii',
      scope_entity_type: 'cliente | emprestimo | parcela | pagamento | empty',
      scope_sql: 'single_select_or_with_returning_only_entity_id',
      action_proposal: 'object seguindo exatamente uma acao do catalogo, ou null',
      action_draft: '{ decision: create|update|keep|abandon, action: registrar_pagamento|registrar_pagamento_juros, cliente_id: integer_optional, emprestimo_id: integer_optional, valor: number_optional, data: YYYY-MM-DD_optional, tipo_pagamento: normal_optional } | null',
    },
  };

  const llm = await callOpenAIChat({
    model: cfg.modelPlanning,
    temperature: 0.05,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  if (!llm.ok) {
    return {
      ok: false,
      skipped: false,
      reason: llm.error || 'llm_call_failed',
      plan: null,
      usage: null,
      model: cfg.modelPlanning,
      status: llm.status || 0,
      provider_code: llm.provider_code || '',
      unavailable: Boolean(llm.unavailable),
    };
  }

  const parsed = safeJsonParse(llm.content);
  if (!parsed) {
    return {
      ok: false,
      skipped: false,
      reason: 'invalid_json_from_llm',
      plan: null,
      usage: llm.usage || null,
      model: llm.model || cfg.modelPlanning,
    };
  }

  return {
    ok: true,
    skipped: false,
    reason: null,
    plan: normalizePlan(parsed),
    usage: llm.usage || null,
    model: llm.model || cfg.modelPlanning,
  };
}

module.exports = {
  getOpenAIConfig,
  callOpenAIChat,
  planWithLLM,
  getProviderErrorMetadata,
};
