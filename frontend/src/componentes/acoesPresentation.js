const FIELD_LABELS = Object.freeze({
  nome: 'Nome',
  valor: 'Valor',
  valor_atual: 'Valor atual',
  valor_emprestado: 'Valor emprestado',
  valor_total: 'Valor total',
  valor_pago: 'Valor pago',
  valor_capital: 'Capital',
  valor_juros: 'Juros',
  valor_adicionado: 'Valor adicionado',
  valor_despesa: 'Valor da despesa',
  capital_restante: 'Capital restante',
  saldo_devedor: 'Saldo devedor',
  taxa_juros: 'Taxa de juros',
  mal_pagador: 'Mal pagador',
  receber_notificacoes_cobranca: 'Receber notificações de cobrança',
  motivo_notificacoes_cobranca: 'Motivo da preferência',
  telefone: 'Telefone',
  endereco: 'Endereço',
  observacao: 'Observação',
  descricao: 'Descrição',
  data: 'Data',
  vencimento: 'Vencimento',
  data_pagamento: 'Data do pagamento',
  dia_pagamento: 'Dia de pagamento',
  primeiro_vencimento: 'Primeiro vencimento',
  parcelas: 'Parcelas',
  parcela: 'Parcela',
  numero: 'Número',
  modalidade: 'Modalidade',
  pago: 'Pago',
  ativo: 'Ativo',
  tipo_pagamento: 'Tipo de pagamento',
  juros_adicionais: 'Juros adicionais',
  juros_pendentes: 'Juros pendentes',
  campos_confirmados: 'Campos alterados',
  qtd_parcelas: 'Quantidade de parcelas',
  proximo_vencimento: 'Próximo vencimento',
  operacao: 'Operação',
  criadas: 'Criadas',
  removidas: 'Removidas',
  atualizadas: 'Atualizadas',
});

const ENTITY_LABELS = Object.freeze({
  clientes: 'Cliente',
  cliente: 'Cliente',
  emprestimos: 'Empréstimo',
  emprestimo: 'Empréstimo',
  parcelas: 'Parcela',
  parcela: 'Parcela',
  pagamentos: 'Pagamento',
  pagamento: 'Pagamento',
  caixa_movimentos: 'Movimento de caixa',
  notificacoes: 'Notificação',
  configuracoes_notificacoes: 'Configuração de notificações',
});

const HIDDEN_KEYS = new Set([
  'id', 'cliente_id', 'emprestimo_id', 'parcela_id', 'pagamento_id',
  'acao_id', 'renegociacao_id', 'historico_id', 'cliente_uid',
  'emprestimo_uid', 'parcela_uid', 'acao_uid', 'origin_device_id',
  'created_at', 'updated_at', 'last_activity_at', 'foto_cliente',
]);

const CURRENCY_HINT = /(valor|saldo|capital|juros|despesa|total_pago)/;
const BOOLEAN_HINT = /^(pago|ativo|mal_pagador|receber_notificacoes_cobranca|renegociada)$/;

export function parseActionDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDayKey(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

export function actionDayLabel(value, now = new Date()) {
  const date = parseActionDate(value);
  if (!date) return 'Data não informada';
  const today = localDayKey(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = localDayKey(date);
  if (day === today) return 'Hoje';
  if (day === localDayKey(yesterdayDate)) return 'Ontem';
  return new Intl.DateTimeFormat('pt-BR').format(date);
}

export function actionTimeLabel(value) {
  const date = parseActionDate(value);
  if (!date) return 'Horário não informado';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function groupActionsByDay(items, now = new Date()) {
  const groups = [];
  for (const item of items || []) {
    const label = actionDayLabel(item?.created_at, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function formatCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number);
}

function titleFromKey(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function displayPath(path) {
  const segments = path.split('.').filter(Boolean);
  const entity = ENTITY_LABELS[segments[0]] || titleFromKey(segments[0]);
  const meaningful = segments
    .slice(1)
    .filter((segment) => !['estado', 'parametros', 'entrada'].includes(segment))
    .map((segment) => {
      const arrayMatch = segment.match(/^(.+)\[(\d+)\]$/);
      if (!arrayMatch) return titleFromKey(segment);
      return `${titleFromKey(arrayMatch[1])} ${Number(arrayMatch[2]) + 1}`;
    });
  return [entity, ...meaningful].filter(Boolean).join(' · ');
}

function canExposeKey(key) {
  return !HIDDEN_KEYS.has(key) && !key.endsWith('_uid') && !key.endsWith('_id');
}

function flattenValue(value, path, output, limit) {
  if (output.size >= limit || value === undefined) return;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    output.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.set(path, []);
      return;
    }
    value.forEach((item, index) => flattenValue(item, `${path}[${index}]`, output, limit));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (!canExposeKey(key)) continue;
    flattenValue(nested, path ? `${path}.${key}` : key, output, limit);
    if (output.size >= limit) break;
  }
}

function snapshotMap(snapshots, moment, limit = 100) {
  const output = new Map();
  for (const snapshot of snapshots || []) {
    if (snapshot?.momento !== moment) continue;
    const prefix = String(snapshot.entidade || 'registro');
    flattenValue(snapshot.dados, prefix, output, limit);
  }
  return output;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildSnapshotComparison(snapshots, limit = 60) {
  const before = snapshotMap(snapshots, 'antes');
  const after = snapshotMap(snapshots, 'depois');
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const all = keys.map((key) => ({
    key,
    label: displayPath(key),
    before: before.has(key) ? before.get(key) : null,
    after: after.has(key) ? after.get(key) : null,
    changed: !sameValue(before.get(key), after.get(key)),
  }));
  const changed = all.filter((item) => item.changed);
  const selected = (changed.length ? changed : all).slice(0, limit);
  return {
    items: selected,
    changed_count: changed.length,
    truncated: (changed.length ? changed.length : all.length) > selected.length,
  };
}

export function formatDetailValue(path, value) {
  if (value == null || value === '') return 'Não informado';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Nenhum';
  const key = String(path || '').split('.').pop()?.replace(/\[\d+\]$/, '') || '';
  if (BOOLEAN_HINT.test(key)) return Number(value) === 1 || value === true ? 'Sim' : 'Não';
  if (key.includes('taxa') && Number.isFinite(Number(value))) return `${Number(value).toLocaleString('pt-BR')}%`;
  if (CURRENCY_HINT.test(key) && Number.isFinite(Number(value))) return formatCurrency(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) {
    const date = parseActionDate(value);
    if (date) return new Intl.DateTimeFormat('pt-BR').format(date);
  }
  const text = String(value);
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

export function metadataEntries(metadata, limit = 12) {
  if (!metadata || typeof metadata !== 'object') return [];
  const source = metadata.parametros && typeof metadata.parametros === 'object'
    ? metadata.parametros
    : metadata;
  const flattened = new Map();
  flattenValue(source, 'acao', flattened, limit * 2);
  return [...flattened.entries()]
    .filter(([path]) => !path.endsWith('.contract'))
    .slice(0, limit)
    .map(([path, value]) => ({
      key: path,
      label: displayPath(path).replace(/^Acao · /, ''),
      value,
    }));
}
