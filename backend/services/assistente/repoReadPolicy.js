function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function hasAny(text, terms) {
  if (!text || !Array.isArray(terms)) return false;
  return terms.some((term) => text.includes(term));
}

function inferRepoGoal(text) {
  if (hasAny(text, ['calculo', 'calcula', 'formula', 'regra'])) return 'origin_calculation';
  if (hasAny(text, ['rota', 'controller', 'service', 'fluxo', 'orquestrador'])) return 'trace_flow';
  return 'origin_rule';
}

function inferRepoScope(text, semanticProfile = null) {
  if (hasAny(text, ['frontend', 'react', 'jsx', 'css', 'componente', 'tela'])) return 'frontend';
  if (hasAny(text, ['backend', 'controller', 'service', 'rota', 'sql', 'orquestrador'])) return 'backend';
  const semantic = semanticProfile && typeof semanticProfile === 'object' ? semanticProfile : {};
  const primary = String(semantic.primary_entity || '').toLowerCase();
  if (['caixa', 'emprestimo', 'parcela', 'pagamento', 'notificacao', 'cliente'].includes(primary)) {
    return 'backend';
  }
  return 'project';
}

function decideKnowledgeSource({
  userText,
  requestClassification,
  semanticProfile,
}) {
  const text = normalizeText(userText);
  const rc = requestClassification && typeof requestClassification === 'object'
    ? requestClassification
    : {};
  const semantic = semanticProfile && typeof semanticProfile === 'object'
    ? semanticProfile
    : {};

  const repoSignals = hasAny(text, [
    'arquivo',
    'arquivos',
    'funcao',
    'funcao',
    'codigo',
    'repositorio',
    'repo',
    'projeto',
    'linha',
    'controller',
    'service',
    'rota',
    'orquestrador',
    'onde esta',
    'onde fica',
    'fonte da verdade',
    'de onde vem',
  ]);

  const asksOrigin = hasAny(text, [
    'onde esta',
    'onde fica',
    'de onde vem',
    'em qual arquivo',
    'qual funcao',
    'qual linha',
    'como isso e calculado',
    'como calcula',
  ]);

  const asksOperationalMetrics = hasAny(text, [
    'quanto',
    'quantos',
    'quais',
    'total',
    'soma',
    'top',
    'maiores',
    'lista',
    'clientes',
    'parcelas',
    'juros',
    'capital',
    'recebi',
    'vencendo',
    'vencidas',
    'atraso',
  ]);

  const semanticIntent = String(semantic.semantic_intent || '').toLowerCase();
  const semanticOperational = [
    'evento',
    'estoque',
    'resumo',
    'detalhe',
    'busca_cliente',
    'fila_alertas',
  ].includes(semanticIntent);

  const isOperationalClear =
    (!repoSignals && asksOperationalMetrics) ||
    (semanticOperational && !asksOrigin);

  if (isOperationalClear) {
    return {
      strategy: 'domain_only',
      reason: 'operational_question_prioritizes_domain_tools',
      confidence: 0.95,
      repo_goal: 'none',
      should_use_repo_read: false,
      repo_scope: inferRepoScope(text, semantic),
      repo_budget: {
        search_calls: 0,
        open_calls: 0,
        max_snippets: 0,
        max_chars_total: 0,
      },
    };
  }

  if ((asksOrigin || repoSignals) && asksOperationalMetrics) {
    return {
      strategy: 'hybrid',
      reason: 'mixed_operational_and_origin_request',
      confidence: 0.9,
      repo_goal: inferRepoGoal(text),
      should_use_repo_read: true,
      repo_scope: inferRepoScope(text, semantic),
      repo_budget: {
        search_calls: 1,
        open_calls: 2,
        max_snippets: 2,
        max_chars_total: 1800,
      },
    };
  }

  if (asksOrigin || repoSignals) {
    return {
      strategy: 'repo_only',
      reason: 'explicit_repository_origin_request',
      confidence: 0.9,
      repo_goal: inferRepoGoal(text),
      should_use_repo_read: true,
      repo_scope: inferRepoScope(text, semantic),
      repo_budget: {
        search_calls: 2,
        open_calls: 3,
        max_snippets: 3,
        max_chars_total: 3200,
      },
    };
  }

  if (String(rc.category || '').toLowerCase() === 'ambigua' && semanticOperational) {
    return {
      strategy: 'domain_only',
      reason: 'ambiguous_operational_defaults_to_domain_tools',
      confidence: 0.75,
      repo_goal: 'none',
      should_use_repo_read: false,
      repo_scope: inferRepoScope(text, semantic),
      repo_budget: {
        search_calls: 0,
        open_calls: 0,
        max_snippets: 0,
        max_chars_total: 0,
      },
    };
  }

  return {
    strategy: 'domain_only',
    reason: 'default_domain_priority',
    confidence: 0.7,
    repo_goal: 'none',
    should_use_repo_read: false,
    repo_scope: inferRepoScope(text, semantic),
    repo_budget: {
      search_calls: 0,
      open_calls: 0,
      max_snippets: 0,
      max_chars_total: 0,
    },
  };
}

module.exports = {
  decideKnowledgeSource,
};
