const { actionRegistry } = require('./actionRegistry');

function positiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(positiveId)
    .filter((value) => value != null))];
}

function idsFrom(source, keys) {
  if (!source || typeof source !== 'object') return [];
  const values = [];
  for (const key of keys) {
    const raw = source[key];
    if (Array.isArray(raw)) values.push(...raw);
    else values.push(raw);
  }
  return uniqueIds(values);
}

function candidatesFor(entityType, { screenContext = {}, memoryContext = {}, resolutionEntities = {}, pendingDraft = null } = {}) {
  const selected = screenContext && screenContext.selected_ids ? screenContext.selected_ids : {};
  const active = memoryContext && memoryContext.active_context ? memoryContext.active_context : {};
  const entities = memoryContext && memoryContext.active_entities ? memoryContext.active_entities : {};
  const resolved = resolutionEntities && typeof resolutionEntities === 'object' ? resolutionEntities : {};
  const draftCandidates = pendingDraft && pendingDraft.candidate_entities ? pendingDraft.candidate_entities : {};
  const key = entityType === 'cliente' ? 'cliente' : 'emprestimo';
  const idKey = `${key}_id`;

  // Uma selecao explicita na tela tem precedencia sobre conjuntos amplos de
  // memoria. Sem isso, um result_set com varios itens seria ambiguo.
  const selectedIds = idsFrom(selected, [key, idKey]);
  if (selectedIds.length) return selectedIds;
  const activeIds = idsFrom(active, [idKey, key]);
  if (activeIds.length) return activeIds;
  const resolvedIds = idsFrom(resolved, [key, `${key}s`, idKey]);
  if (resolvedIds.length) return resolvedIds;
  const memoryIds = idsFrom(entities, [key, `${key}s`, idKey]);
  if (memoryIds.length) return memoryIds;
  return idsFrom(draftCandidates, [key, `${key}s`, idKey]);
}

function outcome(kind, message, extra = {}) {
  return { kind, message, ...extra };
}

function validateActionProposal(rawProposal, context = {}) {
  if (rawProposal == null) return outcome('none', '');
  if (!rawProposal || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
    return outcome('clarification', 'Nao consegui validar os dados da acao. Informe os dados necessarios.');
  }
  const definition = actionRegistry.get(rawProposal.action);
  if (!definition) {
    return outcome('unsupported', 'Essa acao ainda nao esta disponivel na assistente.');
  }
  const allowed = new Set(['action', ...definition.required_fields]);
  if (Object.keys(rawProposal).some((key) => !allowed.has(key))) return outcome('rejected', 'A proposta de acao contem dados nao permitidos.');

  const clienteCandidates = candidatesFor('cliente', context);
  const emprestimoCandidates = candidatesFor('emprestimo', context);
  if (clienteCandidates.length !== 1 || emprestimoCandidates.length !== 1) {
    const missing = [];
    if (!clienteCandidates.length) missing.push('cliente');
    if (!emprestimoCandidates.length) missing.push('emprestimo');
    return outcome(
      'clarification',
      missing.length
        ? `Preciso identificar exatamente ${missing.join(' e ')} antes de preparar o pagamento.`
        : 'Encontrei mais de uma entidade compativel. Informe qual cliente e emprestimo devem receber o pagamento.'
    );
  }
  if (positiveId(rawProposal.cliente_id) !== clienteCandidates[0] ||
      positiveId(rawProposal.emprestimo_id) !== emprestimoCandidates[0]) {
    return outcome('clarification', 'Os IDs informados nao correspondem ao contexto selecionado. Selecione ou consulte o cliente e o emprestimo corretos.');
  }

  try {
    return outcome('ready', '', { intent: definition.validate(rawProposal) });
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const fields = [];
    if (code === 'invalid_amount') fields.push('valor');
    if (code === 'invalid_date') fields.push('data no formato AAAA-MM-DD');
    if (code === 'unsupported_payment_type') fields.push('tipo de pagamento normal');
    if (code === 'interest_amount_mismatch') fields.push('o valor exato dos juros atuais');
    return outcome(
      'clarification',
      fields.length ? `Preciso de ${fields.join(' e ')} para preparar o pagamento.` : 'Os dados do pagamento nao sao validos.'
    );
  }
}

async function createActionPreviewFromPlan({ plan, screenContext, memoryContext, resolutionEntities, pendingDraft, sessionId, gateway }) {
  if (!plan || !plan.action_proposal) return outcome('none', '');
  // Uma proposta de acao nunca pode transportar SQL, mesmo que seja SQL de
  // leitura: o contrato de acao nao possui esse canal.
  if (String(plan.sql_query || '').trim() || String(plan.scope_sql || '').trim()) {
    return outcome('rejected', 'A proposta de acao nao pode incluir SQL.');
  }
  const validated = validateActionProposal(plan.action_proposal, { screenContext, memoryContext, resolutionEntities, pendingDraft });
  if (validated.kind !== 'ready') return validated;
  try {
    const prepared = await gateway.createPreview({ sessionId, intent: validated.intent });
    return outcome('preview', '', {
      action_preview: {
        action: prepared.action || validated.intent.action,
        preview: prepared.preview,
        confirmation_token: prepared.confirmation_token,
        expires_at: prepared.expires_at,
      },
    });
  } catch (_) {
    return outcome('clarification', 'Nao foi possivel preparar este pagamento. Verifique o cliente, o emprestimo e os dados informados.');
  }
}

module.exports = {
  validateActionProposal,
  createActionPreviewFromPlan,
  __internal: { candidatesFor, ACTION_FIELDS: null },
};
