const DOMAIN_TOOL_NAMES = Object.freeze([
  'caixa_resumo',
  'parcelas_por_periodo',
  'emprestimo_detalhe',
  'notificacoes_pendentes',
  'cliente_busca',
]);
const REPO_READ_TOOL_NAMES = Object.freeze([
  'repo_list',
  'repo_search',
  'repo_open',
  'repo_snippets',
]);
const TOOL_NAMES = Object.freeze([
  ...DOMAIN_TOOL_NAMES,
  ...REPO_READ_TOOL_NAMES,
]);

const TOOL_DESCRIPTIONS = Object.freeze({
  caixa_resumo:
    'Consulta resumo de entradas/saidas no caixa para um periodo (dia, semana, mes, ano, total ou custom).',
  parcelas_por_periodo:
    'Consulta parcelas por janela de datas, com tipo (vencidas, vencendo, todas) e opcao de incluir parcelas pagas.',
  emprestimo_detalhe:
    'Consulta detalhes completos de um emprestimo especifico.',
  notificacoes_pendentes:
    'Lista notificacoes pendentes e seus detalhes.',
  cliente_busca:
    'Busca cliente por id exato ou por nome aproximado.',
  repo_list:
    'Lista arquivos/pastas permitidos no escopo read-only do projeto.',
  repo_search:
    'Busca texto no repositório em modo read-only e retorna ocorrencias limitadas.',
  repo_open:
    'Abre trecho de arquivo permitido em modo read-only com limites de linhas.',
  repo_snippets:
    'Monta snippets curtos e relevantes a partir de hits de busca no repositório.',
});
const REPO_SCOPES = new Set(['project', 'backend', 'frontend']);
const SCREEN_CONTEXT_KEYS = new Set([
  'cliente', 'cliente_id', 'clienteId',
  'emprestimo', 'emprestimo_id', 'emprestimoId',
  'parcela', 'parcela_id', 'parcelaId',
  'periodo', 'periodo_caixa', 'de', 'ate', 'data_de', 'data_ate',
  'tipo_parcelas', 'nome_cliente',
]);

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPositiveInteger(value) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function toBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (!s) return !!defaultValue;
    if (s === 'true' || s === '1' || s === 'sim' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'nao' || s === 'no') {
      return false;
    }
  }
  return !!defaultValue;
}

function isISODate(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;

  const parts = text.split('-');
  if (parts.length !== 3) return false;

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(dt.getTime())) return false;
  if (dt.getUTCFullYear() !== year) return false;
  if (dt.getUTCMonth() + 1 !== month) return false;
  if (dt.getUTCDate() !== day) return false;
  return true;
}

function sanitizeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function sanitizeStringMap(mapLike) {
  if (!isPlainObject(mapLike)) return {};
  const entries = Object.entries(mapLike);
  const out = {};
  for (const [key, value] of entries) {
    if (value == null) continue;
    const k = sanitizeString(key);
    if (!k) continue;
    out[k] = sanitizeString(value);
  }
  return out;
}

function sanitizeScreenContextMap(mapLike) {
  if (!isPlainObject(mapLike)) return {};
  const out = {};
  for (const [key, value] of Object.entries(mapLike)) {
    const cleanKey = sanitizeString(key);
    if (!SCREEN_CONTEXT_KEYS.has(cleanKey) || value == null) continue;
    const cleanValue = sanitizeString(value);
    if (cleanValue) out[cleanKey] = cleanValue.slice(0, 120);
  }
  return out;
}

function sanitizeRoute(value) {
  const route = sanitizeString(value, '/').split(/[?#]/, 1)[0];
  return /^\/[a-zA-Z0-9_/-]{0,160}$/.test(route) ? route : '/';
}

function sanitizeScreenContext(rawContext) {
  const ctx = isPlainObject(rawContext) ? rawContext : {};
  const route = sanitizeRoute(ctx.route || ctx.pathname);
  const queryParams = sanitizeScreenContextMap(ctx.query_params || ctx.query);
  const selected = isPlainObject(ctx.selected_ids)
    ? ctx.selected_ids
    : isPlainObject(ctx.selected)
      ? ctx.selected
      : {};
  const activeFilters = sanitizeScreenContextMap(ctx.active_filters || ctx.ui_filters || ctx.filters);

  const selectedIds = {};
  const cliente = toPositiveInteger(selected.cliente || selected.cliente_id || selected.clienteId);
  const emprestimo = toPositiveInteger(
    selected.emprestimo || selected.emprestimo_id || selected.emprestimoId
  );
  const parcela = toPositiveInteger(selected.parcela || selected.parcela_id || selected.parcelaId);

  if (cliente != null) selectedIds.cliente = cliente;
  if (emprestimo != null) selectedIds.emprestimo = emprestimo;
  if (parcela != null) selectedIds.parcela = parcela;

  return {
    route,
    query_params: queryParams,
    selected_ids: selectedIds,
    active_filters: activeFilters,
  };
}

function normalizePeriod(periodRaw) {
  const p = sanitizeString(periodRaw, 'dia').toLowerCase();
  const allowed = new Set(['dia', 'semana', 'mes', 'ano', 'total', 'custom']);
  return allowed.has(p) ? p : 'dia';
}

function normalizeParcelasTipo(tipoRaw) {
  const t = sanitizeString(tipoRaw, 'todas').toLowerCase();
  const allowed = new Set(['vencidas', 'vencendo', 'todas']);
  return allowed.has(t) ? t : 'todas';
}

function normalizeRepoScope(scopeRaw) {
  const scope = sanitizeString(scopeRaw, 'project').toLowerCase();
  return REPO_SCOPES.has(scope) ? scope : 'project';
}

function clampInteger(rawValue, min, max, fallback) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function getToolCatalog(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const includeRepoRead = Boolean(opts.includeRepoRead);
  const source = includeRepoRead ? TOOL_NAMES : DOMAIN_TOOL_NAMES;
  return source.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name] || '',
  }));
}

function validateToolCall(toolName, rawArgs) {
  const errors = [];
  const name = sanitizeString(toolName);
  if (!TOOL_NAMES.includes(name)) {
    return {
      ok: false,
      tool_name: name,
      normalized_args: {},
      errors: ['Tool nao permitida.'],
    };
  }

  const args = isPlainObject(rawArgs) ? { ...rawArgs } : {};
  const normalized = {};

  if (name === 'caixa_resumo') {
    const periodo = normalizePeriod(args.periodo);
    normalized.periodo = periodo;

    if (periodo === 'custom') {
      const de = sanitizeString(args.de);
      const ate = sanitizeString(args.ate);
      if (!isISODate(de) || !isISODate(ate)) {
        errors.push('Para periodo custom, de e ate devem estar no formato YYYY-MM-DD.');
      } else if (de > ate) {
        errors.push('Intervalo invalido: de deve ser menor ou igual a ate.');
      } else {
        normalized.de = de;
        normalized.ate = ate;
      }
    } else {
      const de = sanitizeString(args.de);
      const ate = sanitizeString(args.ate);
      if (de && isISODate(de)) normalized.de = de;
      if (ate && isISODate(ate)) normalized.ate = ate;
    }
  }

  if (name === 'parcelas_por_periodo') {
    const tipo = normalizeParcelasTipo(args.tipo);
    normalized.tipo = tipo;
    normalized.incluirPagas = toBoolean(args.incluirPagas, false);

    const de = sanitizeString(args.de);
    const ate = sanitizeString(args.ate);
    if (!isISODate(de) || !isISODate(ate)) {
      errors.push('Ferramenta parcelas_por_periodo exige de e ate no formato YYYY-MM-DD.');
    } else if (de > ate) {
      errors.push('Intervalo invalido: de deve ser menor ou igual a ate.');
    } else {
      normalized.de = de;
      normalized.ate = ate;
    }
  }

  if (name === 'emprestimo_detalhe') {
    const emprestimoId = toPositiveInteger(args.emprestimo_id);
    if (emprestimoId == null) {
      errors.push('Ferramenta emprestimo_detalhe exige emprestimo_id valido.');
    } else {
      normalized.emprestimo_id = emprestimoId;
    }
  }

  if (name === 'notificacoes_pendentes') {
    // Sem argumentos obrigatorios.
  }

  if (name === 'cliente_busca') {
    const id = toPositiveInteger(args.id);
    const nome = sanitizeString(args.nome);
    if (id == null && !nome) {
      errors.push('Ferramenta cliente_busca exige id ou nome.');
    }
    if (id != null) normalized.id = id;
    if (nome) normalized.nome = nome;
  }

  if (name === 'repo_list') {
    normalized.scope = normalizeRepoScope(args.scope);
    const relPath = sanitizeString(args.rel_path || args.path);
    if (relPath) normalized.rel_path = relPath;
    normalized.max_depth = clampInteger(args.max_depth, 0, 5, 2);
    normalized.max_entries = clampInteger(args.max_entries, 1, 200, 120);
    const globInclude = sanitizeString(args.glob_include);
    if (globInclude) normalized.glob_include = globInclude;
  }

  if (name === 'repo_search') {
    normalized.scope = normalizeRepoScope(args.scope);
    const query = sanitizeString(args.query);
    if (!query) {
      errors.push('Ferramenta repo_search exige query nao vazia.');
    } else {
      normalized.query = query.slice(0, 220);
    }
    normalized.is_regex = toBoolean(args.is_regex, false);
    normalized.case_sensitive = toBoolean(args.case_sensitive, false);
    normalized.max_matches = clampInteger(args.max_matches, 1, 100, 50);
    const globInclude = sanitizeString(args.glob_include);
    if (globInclude) normalized.glob_include = globInclude;
  }

  if (name === 'repo_open') {
    normalized.scope = normalizeRepoScope(args.scope);
    const filePath = sanitizeString(args.path || args.rel_path);
    if (!filePath) {
      errors.push('Ferramenta repo_open exige path do arquivo.');
    } else {
      normalized.path = filePath;
    }
    normalized.start_line = clampInteger(args.start_line, 1, 500000, 1);
    normalized.max_lines = clampInteger(args.max_lines, 1, 120, 80);
  }

  if (name === 'repo_snippets') {
    normalized.scope = normalizeRepoScope(args.scope);
    const rawHits = Array.isArray(args.hits) ? args.hits : [];
    if (!rawHits.length) {
      errors.push('Ferramenta repo_snippets exige hits com path/line.');
    } else {
      const hits = rawHits
        .map((hit) => {
          if (!isPlainObject(hit)) return null;
          const path = sanitizeString(hit.path);
          const line = clampInteger(hit.line, 1, 500000, 1);
          if (!path) return null;
          return { path, line };
        })
        .filter(Boolean)
        .slice(0, 20);
      if (!hits.length) {
        errors.push('Ferramenta repo_snippets exige hits validos com path/line.');
      } else {
        normalized.hits = hits;
      }
    }
    normalized.context_before = clampInteger(args.context_before, 0, 20, 2);
    normalized.context_after = clampInteger(args.context_after, 0, 20, 3);
    normalized.max_snippets = clampInteger(args.max_snippets, 1, 8, 3);
    normalized.max_chars_total = clampInteger(args.max_chars_total, 300, 12000, 3200);
  }

  return {
    ok: errors.length === 0,
    tool_name: name,
    normalized_args: normalized,
    errors,
  };
}

module.exports = {
  DOMAIN_TOOL_NAMES,
  REPO_READ_TOOL_NAMES,
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  isPlainObject,
  isISODate,
  toBoolean,
  toPositiveInteger,
  sanitizeScreenContext,
  getToolCatalog,
  validateToolCall,
};
