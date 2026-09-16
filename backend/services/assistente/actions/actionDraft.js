const { actionRegistry } = require('./actionRegistry');

const ACTION_DRAFT_FIELDS = new Set(['decision', 'action', 'cliente_id', 'emprestimo_id', 'valor', 'parcelas', 'taxa_juros', 'data', 'data_pagamento', 'tipo_pagamento', 'abatimentos']);
function positiveId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function validDate(value) { const text = String(value || '').trim(); const date = new Date(`${text}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null; }
function idList(value) { return [...new Set((Array.isArray(value) ? value : [value]).map(positiveId).filter(Boolean))]; }
function contextualIds(kind, { screenContext = {}, memoryContext = {}, resolutionEntities = {}, currentDraft = null } = {}) {
  const selected = screenContext.selected_ids || {}; const active = memoryContext.active_context || {}; const entities = memoryContext.active_entities || {}; const draftEntities = currentDraft && currentDraft.candidate_entities ? currentDraft.candidate_entities : {}; const key = kind === 'cliente' ? 'cliente' : 'emprestimo';
  const explicit = idList(selected[key] || selected[`${key}_id`]); if (explicit.length) return explicit;
  const activeIds = idList(active[`${key}_id`] || active[key]); if (activeIds.length) return activeIds;
  const resolved = idList(resolutionEntities[key]); if (resolved.length) return resolved;
  return idList(entities[key] || entities[`${key}s`] || draftEntities[key]);
}
function safeDraft(rawUpdate, currentDraft, context = {}) {
  if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate) || Object.keys(rawUpdate).some((key) => !ACTION_DRAFT_FIELDS.has(key))) return { ok: false, reason: 'invalid_draft' };
  const decision = String(rawUpdate.decision || 'update').trim().toLowerCase(); if (!['create', 'update', 'keep', 'abandon'].includes(decision)) return { ok: false, reason: 'invalid_decision' }; if (decision === 'abandon') return { ok: true, abandoned: true };
  const base = currentDraft && typeof currentDraft === 'object' ? currentDraft : {}; const baseArgs = base.arguments && typeof base.arguments === 'object' ? base.arguments : base;
  const action = String(rawUpdate.action || base.action || '').trim(); const definition = actionRegistry.get(action); if (!definition) return { ok: false, reason: 'unsupported_action' };
  const allowed = new Set(['decision', 'action', ...definition.required_fields]); if (Object.keys(rawUpdate).some((key) => !allowed.has(key))) return { ok: false, reason: 'unknown_field' };
  const args = {}; for (const field of definition.required_fields) args[field] = baseArgs[field] ?? null;
  for (const [field, kind] of [['cliente_id', 'cliente'], ['emprestimo_id', 'emprestimo']]) if (Object.prototype.hasOwnProperty.call(rawUpdate, field)) { const id = positiveId(rawUpdate[field]); const candidates = contextualIds(kind, { ...context, currentDraft: base }); if (!id || candidates.length !== 1 || id !== candidates[0]) return { ok: false, reason: `unresolved_${kind}` }; args[field] = id; }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'valor')) { const value = Number(rawUpdate.valor); if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid_amount' }; args.valor = Number(value.toFixed(2)); }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'parcelas')) { const value = Number(rawUpdate.parcelas); if (!Number.isInteger(value) || value <= 0) return { ok: false, reason: 'invalid_installments' }; args.parcelas = value; }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'taxa_juros')) { const value = Number(rawUpdate.taxa_juros); if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'invalid_rate' }; args.taxa_juros = Number(value.toFixed(2)); }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'data')) { const date = validDate(rawUpdate.data); if (!date) return { ok: false, reason: 'invalid_date' }; args.data = date; }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'data_pagamento')) { const date = validDate(rawUpdate.data_pagamento); if (!date) return { ok: false, reason: 'invalid_date' }; args.data_pagamento = date; }
  if (Object.prototype.hasOwnProperty.call(rawUpdate, 'abatimentos')) { if (!Array.isArray(rawUpdate.abatimentos)) return { ok: false, reason: 'invalid_allocations' }; args.abatimentos = rawUpdate.abatimentos; }
  if (definition.required_fields.includes('tipo_pagamento')) { if (Object.prototype.hasOwnProperty.call(rawUpdate, 'tipo_pagamento') && String(rawUpdate.tipo_pagamento).toLowerCase() !== 'normal') return { ok: false, reason: 'unsupported_payment_type' }; args.tipo_pagamento = 'normal'; }
  const next = { action, arguments: args, ...args, candidate_entities: { ...(base.candidate_entities || {}) }, entity_sources: { ...(base.entity_sources || {}) }, created_at: base.created_at || Date.now(), updated_at: Date.now() };
  for (const kind of ['cliente', 'emprestimo']) { const id = args[`${kind}_id`]; if (id) next.candidate_entities[kind] = [id]; }
  const comparable = (draft) => JSON.stringify({ action: draft.action, arguments: draft.arguments || draft, candidate_entities: draft.candidate_entities || {} });
  return { ok: true, draft: next, changed: comparable(base) !== comparable(next) };
}
function resolutionEntitiesFromRows(rows) { const result = { cliente: [], emprestimo: [] }; for (const row of Array.isArray(rows) ? rows : []) { if (!row || typeof row !== 'object') continue; const cliente = positiveId(row.cliente_id); const emprestimo = positiveId(row.emprestimo_id); if (cliente) result.cliente.push(cliente); if (emprestimo) result.emprestimo.push(emprestimo); } result.cliente = [...new Set(result.cliente)].slice(0, 20); result.emprestimo = [...new Set(result.emprestimo)].slice(0, 20); return result; }
module.exports = { safeDraft, resolutionEntitiesFromRows, contextualIds, ACTION_DRAFT_FIELDS };
