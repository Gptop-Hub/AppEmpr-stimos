function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function hasAny(text, terms) {
  if (!text || !Array.isArray(terms) || !terms.length) return false;
  return terms.some((term) => text.includes(term));
}

const ACTION_TERMS = Object.freeze([
  'altere',
  'alterar',
  'mude',
  'mudar',
  'edite',
  'editar',
  'refatore',
  'refatorar',
  'implemente',
  'implementar',
  'crie',
  'criar',
  'aplique patch',
  'gera patch',
  'gere patch',
  'codifique',
  'corrija',
]);

const DATA_TERMS = Object.freeze([
  'quanto',
  'quantos',
  'total',
  'soma',
  'saldo',
  'caixa',
  'recebi',
  'receber',
  'vou receber',
  'entrou',
  'juros',
  'capital',
  'parcela',
  'parcelas',
  'vencid',
  'vencendo',
  'cliente',
  'emprestimo',
  'notific',
  'pagamento',
  'dados reais',
  'banco',
  'sqlite',
]);

const CODE_TERMS = Object.freeze([
  'arquivo',
  'funcao',
  'codigo',
  'regra',
  'fonte',
  'onde esta',
  'onde fica',
  'controller',
  'service',
  'rota',
  'orchestrator',
  'migration',
  'schema',
  'sql',
  'arquitetura',
  'fluxo',
]);

const LOG_TERMS = Object.freeze([
  'log',
  'logs',
  'erro',
  'exception',
  'stack',
  'runtime',
  'trace',
  'crash',
]);

const RUNTIME_SQL_TERMS = Object.freeze([
  'sql direto',
  'query sql',
  'consulta sql',
  'sqlite_master',
  'pragma',
  'schema do banco',
]);

function inferCategory(text, flags) {
  if (flags.isAction) return 'action_modification';
  if (flags.wantsLogs && !flags.wantsData && !flags.wantsCode) return 'investigation_diagnostic';
  if (flags.wantsData && flags.wantsCode) return 'investigation_diagnostic';
  if (flags.wantsData) return 'question_real_data';

  const asksRule = hasAny(text, ['regra', 'calculo', 'formula', 'como calcula', 'de onde vem']);
  if (flags.wantsCode && asksRule) return 'question_business_rule';
  if (flags.wantsCode) return 'question_architecture_code';

  return 'investigation_diagnostic';
}

function buildSourcePriority(flags, category) {
  if (category === 'question_real_data') {
    return ['database', 'endpoint', 'code', 'logs', 'inference'];
  }
  if (category === 'question_business_rule') {
    return ['code', 'database', 'logs', 'inference'];
  }
  if (category === 'question_architecture_code') {
    return ['code', 'logs', 'inference'];
  }
  if (category === 'action_modification') {
    return ['code', 'database', 'logs', 'inference'];
  }
  if (flags.wantsData && flags.wantsCode) {
    return ['database', 'code', 'logs', 'inference'];
  }
  return ['database', 'code', 'logs', 'inference'];
}

function routeAssistantIntent(userText) {
  const text = normalizeText(userText);

  const isAction = hasAny(text, ACTION_TERMS);
  const wantsData = hasAny(text, DATA_TERMS);
  const wantsCode = hasAny(text, CODE_TERMS);
  const wantsLogs = hasAny(text, LOG_TERMS);
  const wantsRuntimeSql = hasAny(text, RUNTIME_SQL_TERMS);
  const wantsEndpoint = hasAny(text, ['endpoint', 'api interna', 'rota get', 'health']);

  const category = inferCategory(text, {
    isAction,
    wantsData,
    wantsCode,
    wantsLogs,
  });

  const hybrid = Boolean(wantsData && wantsCode);

  const reasons = [];
  if (isAction) reasons.push('action_terms_detected');
  if (wantsData) reasons.push('data_terms_detected');
  if (wantsCode) reasons.push('code_terms_detected');
  if (wantsLogs) reasons.push('log_terms_detected');
  if (wantsRuntimeSql) reasons.push('runtime_sql_terms_detected');
  if (wantsEndpoint) reasons.push('endpoint_terms_detected');
  if (!reasons.length) reasons.push('default_diagnostic_fallback');

  let confidence = 0.65;
  if (hybrid) confidence = 0.8;
  else if (category === 'question_real_data') confidence = 0.86;
  else if (category === 'question_business_rule') confidence = 0.84;
  else if (category === 'question_architecture_code') confidence = 0.82;
  else if (category === 'action_modification') confidence = 0.9;

  return {
    category,
    hybrid,
    confidence,
    reasons,
    flags: {
      isAction,
      wantsData,
      wantsCode,
      wantsLogs,
      wantsRuntimeSql,
      wantsEndpoint,
    },
    source_priority: buildSourcePriority(
      {
        wantsData,
        wantsCode,
        wantsLogs,
      },
      category
    ),
  };
}

module.exports = {
  normalizeText,
  routeAssistantIntent,
};
