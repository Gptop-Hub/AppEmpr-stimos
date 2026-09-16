import { API_BASE_URL } from '../axios-setup.js';

const ASSISTANT_BASE_URL = `${API_BASE_URL}/assistente`;

function generateId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const seed = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  return `${prefix}_${seed}`;
}

async function parseErrorResponse(resp) {
  let data = null;
  try {
    data = await resp.json();
    if (data && data.error) return { message: String(data.error), code: data.code || '', status: resp.status };
  } catch {}
  try {
    const text = await resp.text();
    if (text) return { message: text, code: '', status: resp.status };
  } catch {}
  return { message: `HTTP ${resp.status}`, code: '', status: resp.status };
}

function createApiError(errorResponse, fallback) {
  const error = new Error((errorResponse && errorResponse.message) || fallback);
  error.status = errorResponse && errorResponse.status;
  error.code = errorResponse && errorResponse.code;
  return error;
}

export async function sendAudioToStt({
  audioBlob,
  sessionId,
  turnId,
  durationMs = null,
  language = 'pt',
  signal = null,
}) {
  const form = new FormData();
  form.append('audio', audioBlob, `captura_${Date.now()}.webm`);
  if (sessionId) form.append('session_id', sessionId);
  if (turnId) form.append('turn_id', turnId);
  if (Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
    form.append('duration_ms', String(Math.round(Number(durationMs))));
  }
  form.append('language', language);

  const resp = await fetch(`${ASSISTANT_BASE_URL}/stt`, {
    method: 'POST',
    body: form,
    ...(signal ? { signal } : {}),
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao transcrever audio.');
  }
  return resp.json();
}

export async function queryAssistant({
  userText,
  screenContext,
  conversationContext,
  sessionId,
  turnId,
  voiceEnabled = true,
  signal = null,
}) {
  const payload = {
    session_id: sessionId || generateId('sess'),
    turn_id: turnId || generateId('turn'),
    user_text: String(userText || '').trim(),
    screen_context: screenContext || {},
    conversation_context: Array.isArray(conversationContext) ? conversationContext : [],
    voice_enabled: Boolean(voiceEnabled),
  };

  const resp = await fetch(`${ASSISTANT_BASE_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao consultar assistente.');
  }
  return resp.json();
}

export async function resetAssistantSession(sessionId) {
  const resp = await fetch(`${ASSISTANT_BASE_URL}/session/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId || '' }),
  });
  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao resetar a memoria da assistente.');
  }
  return resp.json();
}

async function sendActionToken(path, { sessionId, confirmationToken }) {
  const resp = await fetch(`${ASSISTANT_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Deliberadamente apenas o vinculo de sessao e o token opaco: nenhum
    // argumento financeiro volta do navegador para a confirmacao.
    body: JSON.stringify({ session_id: sessionId || '', confirmation_token: confirmationToken || '' }),
  });
  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao processar a confirmacao da acao.');
  }
  return resp.json();
}

export function confirmAssistantAction({ sessionId, confirmationToken }) {
  return sendActionToken('/action/confirm', { sessionId, confirmationToken });
}

export function cancelAssistantAction({ sessionId, confirmationToken }) {
  return sendActionToken('/action/cancel', { sessionId, confirmationToken });
}

export async function discardAssistantActionDraft(sessionId) {
  const resp = await fetch(`${ASSISTANT_BASE_URL}/action/draft/discard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId || '' }),
  });
  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao descartar o rascunho.');
  }
  return resp.json();
}

export async function warmupAssistantSession() {
  const resp = await fetch(`${ASSISTANT_BASE_URL}/warmup`, {
    method: 'GET',
  });
  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha no warm-up do assistente.');
  }
  return resp.json();
}

export async function sendAssistantFeedback({
  sessionId,
  turnId,
  feedback,
  route = '',
  note = '',
  payload = {},
}) {
  const resp = await fetch(`${ASSISTANT_BASE_URL}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_id: sessionId || '',
      turn_id: turnId || '',
      feedback: feedback || '',
      route: route || '',
      note: note || '',
      payload: payload && typeof payload === 'object' ? payload : {},
    }),
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao enviar feedback do assistente.');
  }
  return resp.json();
}

export async function getAssistantCostSettings() {
  const resp = await fetch(`${ASSISTANT_BASE_URL}/cost/settings`, {
    method: 'GET',
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao carregar configuracoes de custo.');
  }
  return resp.json();
}

export async function getAssistantCostSummary(sessionId) {
  const query = sessionId ? `?session_id=${encodeURIComponent(String(sessionId))}` : '';
  const resp = await fetch(`${ASSISTANT_BASE_URL}/cost/summary${query}`, {
    method: 'GET',
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao carregar resumo de custo do assistente.');
  }
  return resp.json();
}

export async function updateAssistantCostSettings({ userCreditBalance }) {
  const payload = {
    user_credit_balance: Number(userCreditBalance),
  };

  const resp = await fetch(`${ASSISTANT_BASE_URL}/cost/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw createApiError(err, 'Falha ao salvar configuracao de saldo.');
  }
  return resp.json();
}

export function createAssistantSessionId() {
  return generateId('sess');
}

export function createAssistantTurnId() {
  return generateId('turn');
}
