const { runAssistantQuery, warmupAssistantPipeline } = require('../services/assistente/orchestrator');
const { transcribeAudio } = require('../services/assistente/sttService');
const { synthesizeSpeech } = require('../services/assistente/ttsService');
const { sanitizeScreenContext } = require('../services/assistente/contracts');
const {
  resetSessionMemory,
  invalidateFinancialResultSets,
  clearPendingActionDraft,
} = require('../services/assistente/conversationMemory');
const { getActionGateway } = require('../services/assistente/actions/actionGatewayInstance');

const actionGateway = getActionGateway();

function isReadOnlyTestMode() {
  return process.env.ASSISTANT_READONLY_TEST_MODE === '1';
}

function getCostService() {
  return require('../services/assistente/costService');
}

function getFeedbackService() {
  return require('../services/assistente/feedbackService');
}

function parseScreenContext(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return sanitizeScreenContext(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return sanitizeScreenContext(raw);
}

function parsePositiveIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i > 0 ? i : null;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return fallback;
    if (normalized === 'true' || normalized === '1' || normalized === 'sim' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'nao' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function parseConversationContext(raw) {
  const base = Array.isArray(raw) ? raw : [];
  const cleaned = [];

  for (const item of base) {
    if (!item || typeof item !== 'object') continue;
    const role = String(item.role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const text = String(item.text || '').trim();
    if (!text) continue;

    const quality = String(item.quality || 'unknown').trim().toLowerCase();
    if (quality === 'rejected') continue;
    const mode = String(item.mode || 'answer').trim().toLowerCase();

    cleaned.push({
      role,
      text: text.slice(0, 1000),
      quality: quality === 'approved' ? 'approved' : 'unknown',
      at: item.at || null,
      turn_id: item.turn_id ? String(item.turn_id).trim() : null,
      mode: mode || 'answer',
    });
  }

  if (cleaned.length <= 10) return cleaned;
  return cleaned.slice(cleaned.length - 10);
}

exports.stt = async (req, res) => {
  const startedAt = Date.now();
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({
        success: false,
        error: 'Audio nao enviado. Use campo "audio" multipart/form-data.',
      });
    }

    const sessionId = req.body && req.body.session_id ? String(req.body.session_id).trim() : '';
    const turnId = req.body && req.body.turn_id ? String(req.body.turn_id).trim() : '';
    const language = req.body && req.body.language ? String(req.body.language) : 'pt';
    const durationMs = parsePositiveIntOrNull(req.body && req.body.duration_ms);

    if (!sessionId || !turnId) {
      return res.status(400).json({
        success: false,
        error: 'session_id e turn_id sao obrigatorios no STT.',
      });
    }

    const result = await transcribeAudio({
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype || 'audio/webm',
      language,
      filename: req.file.originalname || '',
      durationMs,
    });

    const sttCostStage = await getCostService().recordSttUsage({
      sessionId,
      turnId,
      stt: result,
    });

    return res.json({
      success: true,
      session_id: sessionId,
      turn_id: turnId,
      transcript: result.transcript,
      provider_model: result.model,
      usage: result.usage || null,
      audio_meta: result.audio_meta || null,
      telemetry: {
        stt_provider_ms: result && result.telemetry ? Number(result.telemetry.provider_ms || 0) : 0,
        stt_total_ms: result && result.telemetry ? Number(result.telemetry.total_ms || 0) : 0,
        endpoint_total_ms: Date.now() - startedAt,
      },
      cost_stage: sttCostStage || null,
    });
  } catch (err) {
    console.error('[assistente/stt] erro:', err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Falha ao transcrever audio.',
    });
  }
};

exports.query = async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = req.body || {};
    const sessionId = body.session_id ? String(body.session_id).trim() : '';
    const turnId = body.turn_id ? String(body.turn_id).trim() : '';
    const userText = body.user_text != null ? String(body.user_text).trim() : '';
    const screenContext = parseScreenContext(body.screen_context);
    const conversationContext = parseConversationContext(body.conversation_context);
    const voiceEnabled = parseBoolean(body.voice_enabled, true);

    if (!sessionId || !turnId) {
      return res.status(400).json({
        success: false,
        error: 'session_id e turn_id sao obrigatorios.',
      });
    }

    if (!userText) {
      return res.status(400).json({
        success: false,
        error: 'Campo user_text e obrigatorio.',
      });
    }

    const orchestrationStartedAt = Date.now();
    const orchestrated = await runAssistantQuery({
      userText,
      screenContext,
      conversationContext,
      sessionId,
      turnId,
    });
    const orchestrationMs = Date.now() - orchestrationStartedAt;

    let audio = null;
    let ttsEstimateForCost = {
      model: process.env.OPENAI_TTS_MODEL || null,
      estimate: {
        input_characters: 0,
        estimated_cost_usd: 0,
        source: 'fallback_tts_not_generated',
      },
    };
    let ttsError = null;
    let ttsGenerationMs = 0;
    if (voiceEnabled) {
      try {
        const ttsStartedAt = Date.now();
        const tts = await synthesizeSpeech(orchestrated.answer_text);
        ttsGenerationMs = Date.now() - ttsStartedAt;
        audio = {
          mime: tts.mime,
          base64: tts.base64,
          model: tts.model,
          voice: tts.voice,
          estimate: tts.estimate || null,
          telemetry: tts.telemetry || null,
        };
        ttsEstimateForCost = {
          model: tts.model,
          estimate: tts.estimate || null,
        };
      } catch (errTts) {
        ttsError = errTts && errTts.message ? errTts.message : 'Falha de TTS.';
        console.error('[assistente/query][tts] erro:', errTts);
      }
    }

    const usageTrace = orchestrated && orchestrated.usage_trace ? orchestrated.usage_trace : {};
    const reasoningMode = orchestrated && orchestrated.reasoning_mode
      ? String(orchestrated.reasoning_mode)
      : 'advanced';
    const requestClassification = orchestrated && orchestrated.request_classification
      ? orchestrated.request_classification
      : null;
    const cost = isReadOnlyTestMode()
      ? { mode: 'read_only_test', skipped_persistence: true }
      : await getCostService().finalizeInteractionCost({
      sessionId,
      turnId,
      llmPlanning: usageTrace.planning
        ? {
            ...usageTrace.planning,
            metadata: {
              ...(usageTrace.planning.metadata || {}),
              reasoning_mode: reasoningMode,
              request_classification: requestClassification,
            },
          }
        : {
            model: null,
            usage: null,
            metadata: {
              reasoning_mode: reasoningMode,
              request_classification: requestClassification,
            },
          },
      llmAnswer: usageTrace.answer
        ? {
            ...usageTrace.answer,
            metadata: {
              ...(usageTrace.answer.metadata || {}),
              reasoning_mode: reasoningMode,
            },
          }
        : {
            model: null,
            usage: null,
            metadata: {
              reasoning_mode: reasoningMode,
              generation: 'not_invoked',
            },
          },
      tts: ttsEstimateForCost,
    });

    return res.json({
      success: true,
      mode: orchestrated.mode,
      reasoning_mode: reasoningMode,
      request_classification: requestClassification,
      session_id: orchestrated.session_id,
      turn_id: orchestrated.turn_id,
      user_text: userText,
      answer_text: orchestrated.answer_text,
      action_preview: orchestrated.action_preview || null,
      action_preview_invalidated: Boolean(orchestrated.action_preview_invalidated),
      pending_action_draft: orchestrated.pending_action_draft || null,
      intent: orchestrated.intent || null,
      confidence: orchestrated.confidence,
      resolved_context: orchestrated.resolved_context || {},
      tool_trace: orchestrated.tool_trace || [],
      repo_trace: orchestrated.repo_trace || [],
      repo_evidence: orchestrated.repo_evidence || [],
      sources: orchestrated.sources || [],
      verification: orchestrated.verification || null,
      follow_up: orchestrated.follow_up || null,
      usage_trace: usageTrace,
      telemetry: {
        backend_total_ms: Date.now() - startedAt,
        orchestration_ms: orchestrationMs,
        tts_generation_ms: ttsGenerationMs,
        orchestrator: orchestrated && orchestrated.telemetry ? orchestrated.telemetry : null,
      },
      voice_enabled: voiceEnabled,
      audio,
      tts_error: ttsError,
      cost,
    });
  } catch (err) {
    console.error('[assistente/query] erro:', err);
    const providerUnavailable = Boolean(err && err.code === 'assistant_provider_unavailable');
    return res.status(providerUnavailable ? 429 : 500).json({
      success: false,
      error: providerUnavailable
        ? 'A IA esta temporariamente indisponivel. Tente novamente mais tarde.'
        : 'Falha ao processar consulta do assistente.',
      code: providerUnavailable ? 'assistant_provider_unavailable' : 'assistant_query_failed',
    });
  }
};

exports.resetSession = async (req, res) => {
  try {
    const sessionId = req.body && req.body.session_id ? String(req.body.session_id).trim() : '';
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'session_id e obrigatorio.',
      });
    }

    await actionGateway.invalidatePendingForSession(sessionId);
    resetSessionMemory(sessionId);
    return res.json({ success: true, session_id: sessionId, reset: true });
  } catch (err) {
    console.error('[assistente/session/reset] erro:', err);
    return res.status(500).json({
      success: false,
      error: 'Falha ao resetar a memoria da assistente.',
    });
  }
};

exports.confirmAction = async (req, res) => {
  try {
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'session_id' && key !== 'confirmation_token')) {
      return res.status(400).json({ success: false, code: 'invalid_confirmation_contract', error: 'Confirmacao invalida.' });
    }
    const result = await actionGateway.confirm({
      sessionId: body.session_id,
      confirmationToken: body.confirmation_token,
    });
    await actionGateway.invalidatePendingForSession(body.session_id);
    invalidateFinancialResultSets(body.session_id);
    clearPendingActionDraft(body.session_id);
    return res.json({ success: true, action: result.action });
  } catch (err) {
    return res.status(400).json({
      success: false,
      code: err && err.code ? String(err.code) : 'action_confirmation_failed',
      error: 'Nao foi possivel confirmar esta acao. Gere um novo preview.',
    });
  }
};

exports.cancelAction = async (req, res) => {
  try {
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'session_id' && key !== 'confirmation_token')) {
      return res.status(400).json({ success: false, code: 'invalid_cancellation_contract', error: 'Cancelamento invalido.' });
    }
    await actionGateway.cancel({
      sessionId: body.session_id,
      confirmationToken: body.confirmation_token,
    });
    clearPendingActionDraft(body.session_id);
    return res.json({ success: true, cancelled: true });
  } catch (err) {
    return res.status(400).json({
      success: false,
      code: err && err.code ? String(err.code) : 'action_cancel_failed',
      error: 'Nao foi possivel cancelar esta acao.',
    });
  }
};

exports.discardActionDraft = async (req, res) => {
  try {
    const body = req.body || {};
    if (Object.keys(body).some((key) => key !== 'session_id')) {
      return res.status(400).json({ success: false, code: 'invalid_draft_discard_contract', error: 'Descarte invalido.' });
    }
    const sessionId = String(body.session_id || '').trim();
    if (!sessionId) return res.status(400).json({ success: false, error: 'session_id e obrigatorio.' });
    clearPendingActionDraft(sessionId);
    await actionGateway.invalidatePendingForSession(sessionId);
    return res.json({ success: true, discarded: true });
  } catch (_) {
    return res.status(400).json({ success: false, code: 'action_draft_discard_failed', error: 'Nao foi possivel descartar este rascunho.' });
  }
};

exports.warmup = async (_req, res) => {
  try {
    const warm = warmupAssistantPipeline();
    return res.json({
      success: true,
      warmup: warm,
    });
  } catch (err) {
    console.error('[assistente/warmup] erro:', err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Falha no warm-up do assistente.',
    });
  }
};

exports.feedback = async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = body.session_id ? String(body.session_id).trim() : '';
    const turnId = body.turn_id ? String(body.turn_id).trim() : '';
    const feedback = body.feedback ? String(body.feedback).trim() : '';
    const route = body.route ? String(body.route).trim() : '';
    const note = body.note ? String(body.note).trim() : '';
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

    const saved = await getFeedbackService().recordAssistantFeedback({
      sessionId,
      turnId,
      feedback,
      route,
      note,
      payload,
    });

    return res.json({
      success: true,
      feedback: saved,
    });
  } catch (err) {
    console.error('[assistente/feedback] erro:', err);
    return res.status(400).json({
      success: false,
      error: err && err.message ? err.message : 'Falha ao registrar feedback.',
    });
  }
};

exports.getCostSettings = async (_req, res) => {
  try {
    const settings = await getCostService().getCostSettingsSnapshot();
    return res.json({
      success: true,
      cost_settings: settings,
    });
  } catch (err) {
    console.error('[assistente/cost/settings][get] erro:', err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Falha ao carregar configuracoes de custo.',
    });
  }
};

exports.getCostSummary = async (req, res) => {
  try {
    const sessionId = req.query && req.query.session_id
      ? String(req.query.session_id).trim()
      : '';

    const cost = await getCostService().getCostOverview({ sessionId });
    return res.json({
      success: true,
      session_id: sessionId || null,
      cost,
    });
  } catch (err) {
    console.error('[assistente/cost/summary] erro:', err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Falha ao carregar resumo de custo.',
    });
  }
};

exports.updateCostSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const userCreditBalance = Number(body.user_credit_balance);
    if (!Number.isFinite(userCreditBalance)) {
      return res.status(400).json({
        success: false,
        error: 'Campo user_credit_balance invalido.',
      });
    }

    const settings = await getCostService().setManualCreditBalance(userCreditBalance);
    return res.json({
      success: true,
      cost_settings: settings,
    });
  } catch (err) {
    console.error('[assistente/cost/settings][update] erro:', err);
    return res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Falha ao atualizar configuracoes de custo.',
    });
  }
};
