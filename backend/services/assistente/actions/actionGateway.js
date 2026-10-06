const crypto = require('crypto');
const paymentCommand = require('./paymentCommand');
const { createActionRegistry, actionRegistry: defaultActionRegistry } = require('./actionRegistry');
const { getPersistentAuditStore } = require('./actionAuditStore');
const { touchAtividade } = require('../../../utils/touchAtividade');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function actionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sanitizeAuditPreview(preview) {
  const source = preview && typeof preview === 'object' ? preview : {};
  return {
    action: source.action || null,
    emprestimo_id: source.emprestimo && source.emprestimo.id != null ? Number(source.emprestimo.id) : null,
    cliente_id: source.cliente && source.cliente.id != null ? Number(source.cliente.id) : null,
    impacto: source.impacto || null,
  };
}

function createMemoryAuditStore() {
  const entries = [];
  return { entries, async record(entry) { entries.push({ ...entry }); } };
}

function createActionGateway({
  paymentService = null,
  actionRegistry = null,
  auditStore = null,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  // paymentService e mantido como adaptador de compatibilidade para integrações
  // existentes; o fluxo normal de produção sempre passa pelo registry central.
  const registry = actionRegistry || (paymentService
    ? createActionRegistry({ normalCommand: paymentService })
    : defaultActionRegistry);
  const tokens = new Map();
  let resolvedAuditStore = auditStore;
  function getAuditStore() {
    if (!resolvedAuditStore) resolvedAuditStore = getPersistentAuditStore();
    return resolvedAuditStore;
  }

  async function record(entry) {
    await getAuditStore().record({ timestamp: new Date(now()).toISOString(), ...entry });
  }

  async function createPreview({ sessionId, intent }) {
    const cleanSession = String(sessionId || '').trim();
    if (!cleanSession) throw actionError('session_required', 'session_id e obrigatorio.');
    const prepared = await registry.preparePreview(intent);
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now() + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
    tokens.set(token, {
      status: 'pending', session_id: cleanSession, expires_at: expiresAt,
      action: prepared.action, arguments: prepared.arguments,
      state_fingerprint: prepared.state_fingerprint, preview: prepared.preview,
    });
    await record({ event: 'preview_created', action: prepared.action, session_id: cleanSession,
      confirmation_token_hash: tokenHash(token), preview: registry.sanitizeAuditPreview(prepared.action, prepared.preview), success: true });
    return { preview: prepared.preview, confirmation_token: token, expires_at: new Date(expiresAt).toISOString() };
  }

  async function cancel({ sessionId, confirmationToken }) {
    const token = tokens.get(String(confirmationToken || ''));
    if (!token || token.session_id !== String(sessionId || '').trim()) throw actionError('token_not_found', 'Token de confirmacao invalido.');
    if (token.status !== 'pending') throw actionError('token_unavailable', 'Token de confirmacao nao esta disponivel.');
    token.status = 'cancelled';
    await record({ event: 'cancelled', action: token.action, session_id: token.session_id,
      confirmation_token_hash: tokenHash(confirmationToken), preview: registry.sanitizeAuditPreview(token.action, token.preview), success: true });
    return { cancelled: true };
  }

  async function invalidatePendingForSession(sessionId) {
    const cleanSession = String(sessionId || '').trim();
    if (!cleanSession) return 0;
    let invalidated = 0;
    for (const [tokenValue, token] of tokens.entries()) {
      if (token.session_id !== cleanSession || token.status !== 'pending') continue;
      token.status = 'cancelled';
      invalidated += 1;
      await record({ event: 'invalidated', action: token.action, session_id: token.session_id,
        confirmation_token_hash: tokenHash(tokenValue), preview: registry.sanitizeAuditPreview(token.action, token.preview), success: true });
    }
    return invalidated;
  }

  async function confirm({ sessionId, confirmationToken }) {
    const tokenValue = String(confirmationToken || '');
    const token = tokens.get(tokenValue);
    const cleanSession = String(sessionId || '').trim();
    if (!token || token.session_id !== cleanSession) throw actionError('token_not_found', 'Token de confirmacao invalido.');
    if (token.status !== 'pending') throw actionError('token_unavailable', 'Token de confirmacao nao esta disponivel.');
    if (now() > token.expires_at) {
      token.status = 'expired';
      await record({ event: 'expired', action: token.action, session_id: token.session_id,
        confirmation_token_hash: tokenHash(tokenValue), preview: registry.sanitizeAuditPreview(token.action, token.preview),
        success: false, failure_code: 'token_expired' });
      throw actionError('token_expired', 'Token de confirmacao expirado.');
    }

    token.status = 'executing';
    let execution;
    try {
      execution = await registry.execute(token.action, token.arguments, token.state_fingerprint, {
        idempotencyKey: tokenHash(tokenValue),
      });
    } catch (err) {
      token.status = 'failed';
      try {
        await record({ event: 'failed', action: token.action, session_id: token.session_id,
          confirmation_token_hash: tokenHash(tokenValue), preview: registry.sanitizeAuditPreview(token.action, token.preview), success: false,
          failure_code: err && err.code ? String(err.code) : 'execution_failed' });
      } catch (auditError) {
        console.error('[assistente/action-audit] falha ao registrar execucao rejeitada:', auditError);
      }
      throw err;
    }

    // Todas as ações confirmadas do assistente alteram um empréstimo. Registra
    // a atividade apenas depois de a operação financeira ter sido concluída.
    try {
      await touchAtividade({
        emprestimoId: token.arguments.emprestimo_id,
        clienteId: token.arguments.cliente_id,
      });
    } catch (touchErr) {
      console.error('[touchAtividade] assistente/action:', touchErr);
    }

    // A auditoria fica fora da transacao financeira. Depois de um COMMIT, uma
    // indisponibilidade do banco de auditoria nao pode transformar sucesso em
    // falha nem induzir o usuario a tentar uma nova acao financeira.
    token.status = 'used';
    try {
      await record({ event: 'confirmed', action: token.action, session_id: token.session_id,
        confirmation_token_hash: tokenHash(tokenValue), preview: registry.sanitizeAuditPreview(token.action, token.preview), success: true,
        relevant_ids: { pagamento_id: execution.pagamento_id, emprestimo_id: token.arguments.emprestimo_id, cliente_id: token.arguments.cliente_id } });
    } catch (auditError) {
      console.error('[assistente/action-audit] falha ao registrar confirmacao:', auditError);
    }
    return { confirmed: true, action: token.action, result: execution };
  }

  return { createPreview, confirm, cancel, invalidatePendingForSession, __internal: { tokens, getAuditStore } };
}

module.exports = { createActionGateway, createMemoryAuditStore, DEFAULT_TTL_MS };
