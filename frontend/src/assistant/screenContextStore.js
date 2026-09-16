const listeners = new Set();

let extraHints = {
  selected_ids: {},
  active_filters: {},
};

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function getHashPayload() {
  const hashRaw = typeof window !== 'undefined' ? window.location.hash || '#/' : '#/';
  const hash = hashRaw.startsWith('#') ? hashRaw.slice(1) : hashRaw;
  const parts = hash.split('?');
  const route = parts[0] || '/';
  const queryRaw = parts[1] || '';
  return { route, queryRaw };
}

function parseQueryParams(queryRaw) {
  const params = new URLSearchParams(queryRaw || '');
  const out = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function extractSelectedIds(queryParams = {}) {
  const selected = {};

  const cliente = toPositiveInt(
    queryParams.cliente || queryParams.cliente_id || queryParams.clienteId
  );
  const emprestimo = toPositiveInt(
    queryParams.emprestimo || queryParams.emprestimo_id || queryParams.emprestimoId
  );
  const parcela = toPositiveInt(
    queryParams.parcela || queryParams.parcela_id || queryParams.parcelaId
  );

  if (cliente != null) selected.cliente = cliente;
  if (emprestimo != null) selected.emprestimo = emprestimo;
  if (parcela != null) selected.parcela = parcela;
  return selected;
}

function extractFilters(queryParams = {}) {
  const ignoreKeys = new Set([
    'cliente',
    'cliente_id',
    'clienteId',
    'emprestimo',
    'emprestimo_id',
    'emprestimoId',
    'parcela',
    'parcela_id',
    'parcelaId',
  ]);

  const filters = {};
  Object.entries(queryParams).forEach(([key, value]) => {
    if (ignoreKeys.has(key)) return;
    filters[key] = value;
  });
  return filters;
}

function normalizeHints(input = {}) {
  const inSelected = input && input.selected_ids ? input.selected_ids : {};
  const inFilters = input && input.active_filters ? input.active_filters : {};
  const selected = {};
  const filters = {};

  const cliente = toPositiveInt(inSelected.cliente || inSelected.cliente_id || inSelected.clienteId);
  const emprestimo = toPositiveInt(
    inSelected.emprestimo || inSelected.emprestimo_id || inSelected.emprestimoId
  );
  const parcela = toPositiveInt(inSelected.parcela || inSelected.parcela_id || inSelected.parcelaId);

  if (cliente != null) selected.cliente = cliente;
  if (emprestimo != null) selected.emprestimo = emprestimo;
  if (parcela != null) selected.parcela = parcela;

  if (inFilters && typeof inFilters === 'object') {
    Object.entries(inFilters).forEach(([key, value]) => {
      if (value == null) return;
      const k = String(key || '').trim();
      if (!k) return;
      filters[k] = String(value);
    });
  }

  return {
    selected_ids: selected,
    active_filters: filters,
  };
}

function emit() {
  listeners.forEach((listener) => {
    try {
      listener(getScreenContextSnapshot());
    } catch {}
  });
}

export function getScreenContextSnapshot() {
  const { route, queryRaw } = getHashPayload();
  const queryParams = parseQueryParams(queryRaw);
  const selectedFromQuery = extractSelectedIds(queryParams);
  const filtersFromQuery = extractFilters(queryParams);

  return {
    route,
    query_params: queryParams,
    selected_ids: {
      ...selectedFromQuery,
      ...(extraHints.selected_ids || {}),
    },
    active_filters: {
      ...filtersFromQuery,
      ...(extraHints.active_filters || {}),
    },
  };
}

export function updateScreenContextHints(nextHints = {}) {
  const normalized = normalizeHints(nextHints);
  extraHints = {
    selected_ids: {
      ...(extraHints.selected_ids || {}),
      ...(normalized.selected_ids || {}),
    },
    active_filters: {
      ...(extraHints.active_filters || {}),
      ...(normalized.active_filters || {}),
    },
  };
  emit();
}

export function clearScreenContextHints() {
  extraHints = {
    selected_ids: {},
    active_filters: {},
  };
  emit();
}

export function subscribeScreenContext(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
