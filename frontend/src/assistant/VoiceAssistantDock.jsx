import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createAssistantSessionId,
  createAssistantTurnId,
  cancelAssistantAction,
  confirmAssistantAction,
  discardAssistantActionDraft,
  getAssistantCostSummary,
  getAssistantCostSettings,
  queryAssistant,
  resetAssistantSession,
  sendAssistantFeedback,
  sendAudioToStt,
  updateAssistantCostSettings,
  warmupAssistantSession,
} from './assistantApi';
import useMicrophoneRecorder from './useMicrophoneRecorder';
import useScreenContext from './useScreenContext';
import SafeMarkdown from './SafeMarkdown.jsx';
import ActionPreviewCard from './ActionPreviewCard.jsx';
import ActionDraftNotice from './ActionDraftNotice.jsx';

const STATUS_LABEL = {
  idle: 'Pronta',
  listening: 'Ouvindo...',
  processing: 'Processando...',
  speaking: 'Respondendo...',
};
const PIPELINE_STAGE_LABEL = {
  idle: 'Pronta',
  warming_up: 'Preparando assistente...',
  listening: 'Ouvindo...',
  sending_audio: 'Enviando audio...',
  transcribing: 'Transcrevendo...',
  understanding: 'Entendendo a pergunta...',
  querying_system: 'Consultando sistema...',
  preparing_response: 'Preparando resposta...',
  speaking: 'Falando...',
  cancelled: 'Processamento cancelado.',
};
const PIPELINE_PROGRESS_ORDER = [
  'listening',
  'sending_audio',
  'transcribing',
  'understanding',
  'querying_system',
  'preparing_response',
  'speaking',
];
const STAGE_TIMING_ORDER = [
  'capture_audio_ms',
  'upload_audio_ms',
  'stt_ms',
  'orchestration_ms',
  'tool_execution_ms',
  'response_generation_ms',
  'tts_ms',
  'playback_ms',
];
const STAGE_TIMING_LABEL = {
  capture_audio_ms: 'Captura',
  upload_audio_ms: 'Upload',
  stt_ms: 'STT',
  orchestration_ms: 'Orquestracao',
  tool_execution_ms: 'Consulta',
  response_generation_ms: 'Resposta',
  tts_ms: 'TTS',
  playback_ms: 'Reproducao',
};
const SESSION_ID_STORAGE_KEY = 'assistant.voice.session_id';
const COST_METRICS_STORAGE_KEY = 'assistant.voice.cost_metrics';
const MESSAGES_STORAGE_KEY = 'assistant.voice.messages';
const USER_TEXT_STORAGE_KEY = 'assistant.voice.user_text';
const ASSISTANT_TEXT_STORAGE_KEY = 'assistant.voice.answer_text';
const TEXT_DRAFT_STORAGE_KEY = 'assistant.voice.text_draft';
const VOICE_ENABLED_STORAGE_KEY = 'assistant.voice.voice_enabled';

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function isAbortError(err) {
  const name = String(err && err.name ? err.name : '').toLowerCase();
  const msg = String(err && err.message ? err.message : '').toLowerCase();
  return name === 'aborterror' || msg.includes('aborted') || msg.includes('cancel');
}

function getAssistantErrorMessage(err, fallback) {
  if (
    Number(err && err.status) === 429 ||
    String(err && err.code ? err.code : '') === 'assistant_provider_unavailable'
  ) {
    return 'A IA está temporariamente indisponível por limite de créditos. Tente novamente mais tarde.';
  }
  return err && err.message ? err.message : fallback;
}

function createEmptyInteractionTelemetry(turnId = null) {
  return {
    turn_id: turnId,
    capture_audio_ms: 0,
    upload_audio_ms: 0,
    stt_ms: 0,
    orchestration_ms: 0,
    tool_execution_ms: 0,
    response_generation_ms: 0,
    tts_ms: 0,
    playback_ms: 0,
    playback_start_ms: 0,
    query_roundtrip_ms: 0,
    stt_roundtrip_ms: 0,
  };
}

function formatMs(value) {
  const n = toMs(value);
  if (!n) return '0ms';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function buildStageTimingChips(telemetry) {
  const t = telemetry && typeof telemetry === 'object' ? telemetry : {};
  const chips = [];
  for (const stage of STAGE_TIMING_ORDER) {
    const value = toMs(t[stage]);
    if (!value) continue;
    chips.push({
      key: stage,
      label: STAGE_TIMING_LABEL[stage] || stage,
      value,
    });
  }
  return chips;
}

function buildEmptyCostMetrics() {
  return {
    currency: 'USD',
    interaction: {
      estimated_total: 0,
      is_estimated: true,
      source: 'fallback',
    },
    session_total: 0,
    all_time_total: 0,
    balance: {
      user_credit_balance: 0,
      balance_source: 'manual',
    },
  };
}

function getOrCreateSessionId() {
  try {
    const cached = sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
    if (cached && String(cached).trim()) return String(cached).trim();
  } catch {}

  const created = createAssistantSessionId();
  try {
    sessionStorage.setItem(SESSION_ID_STORAGE_KEY, created);
  } catch {}
  return created;
}

function readStoredCostMetrics() {
  try {
    const raw = sessionStorage.getItem(COST_METRICS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistCostMetrics(metrics) {
  try {
    if (!metrics) {
      sessionStorage.removeItem(COST_METRICS_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(COST_METRICS_STORAGE_KEY, JSON.stringify(metrics));
  } catch {}
}

function readStoredMessages() {
  try {
    const raw = sessionStorage.getItem(MESSAGES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const role = String(item.role || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const text = String(item.text || '').trim();
      if (!text) continue;
      out.push({
        role,
        text: text.slice(0, 1200),
        at: item.at || Date.now(),
        turnId: item.turnId ? String(item.turnId).trim() : null,
        mode: item.mode ? String(item.mode).trim().toLowerCase() : 'answer',
        feedback:
          String(item.feedback || '').trim().toLowerCase() === 'approved'
            ? 'approved'
            : String(item.feedback || '').trim().toLowerCase() === 'rejected'
              ? 'rejected'
              : 'unknown',
      });
    }
    if (out.length <= 20) return out;
    return out.slice(out.length - 20);
  } catch {
    return [];
  }
}

function persistMessages(messages) {
  try {
    const payload = Array.isArray(messages) ? messages : [];
    sessionStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(payload.slice(-20)));
  } catch {}
}

function readStoredText(key) {
  try {
    const value = sessionStorage.getItem(key);
    return value ? String(value) : '';
  } catch {
    return '';
  }
}

function persistText(key, value) {
  try {
    if (!value) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, String(value));
  } catch {}
}

function readStoredBoolean(key, fallback = false) {
  try {
    const value = sessionStorage.getItem(key);
    if (value == null) return fallback;
    return String(value).trim() === '1';
  } catch {
    return fallback;
  }
}

function persistBoolean(key, value) {
  try {
    sessionStorage.setItem(key, value ? '1' : '0');
  } catch {}
}

function AssistantWomanIcon() {
  return (
    <svg viewBox="0 0 96 96" width="34" height="34" aria-hidden="true">
      <defs>
        <linearGradient id="assistantSkin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f7d9c4" />
          <stop offset="100%" stopColor="#f0bd9f" />
        </linearGradient>
        <linearGradient id="assistantHair" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1f2937" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <circle cx="48" cy="48" r="46" fill="#eff6ff" stroke="#bfdbfe" strokeWidth="2" />
      <path
        d="M23 44c0-15 11-27 25-27s25 12 25 27v13H23V44z"
        fill="url(#assistantHair)"
      />
      <ellipse cx="48" cy="49" rx="20" ry="22" fill="url(#assistantSkin)" />
      <circle cx="40" cy="50" r="2.3" fill="#1f2937" />
      <circle cx="56" cy="50" r="2.3" fill="#1f2937" />
      <path d="M42 60c3 3 9 3 12 0" stroke="#9a3412" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M31 41a17 17 0 0 1 34 0" stroke="#0f172a" strokeWidth="7" fill="none" strokeLinecap="round" />
      <rect x="22" y="41" width="9" height="16" rx="4" fill="#111827" />
      <rect x="65" y="41" width="9" height="16" rx="4" fill="#111827" />
      <path d="M34 62c4 8 24 8 28 0" stroke="#0f172a" strokeWidth="4" fill="none" strokeLinecap="round" />
      <rect x="38" y="68" width="20" height="14" rx="7" fill="#f8fafc" stroke="#cbd5e1" />
    </svg>
  );
}

function MoneyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M12 2a1 1 0 0 1 1 1v1.13a4.5 4.5 0 0 1 3.4 2.2 1 1 0 1 1-1.72 1.02A2.5 2.5 0 0 0 12.5 6h-1A1.5 1.5 0 0 0 10 7.5c0 .74.53 1.37 1.25 1.49l2.2.37A3.5 3.5 0 0 1 13 16.87V18a1 1 0 1 1-2 0v-1.13a4.5 4.5 0 0 1-3.4-2.2 1 1 0 0 1 1.72-1.02A2.5 2.5 0 0 0 11.5 15h1a1.5 1.5 0 0 0 .25-2.98l-2.2-.37A3.5 3.5 0 0 1 11 5.13V4a1 1 0 0 1 1-1Z"
        fill="currentColor"
      />
    </svg>
  );
}

function buildAudioLevelGradient(level) {
  const pct = Math.max(4, Math.round(level * 100));
  return `linear-gradient(90deg, #10b981 ${pct}%, rgba(148, 163, 184, 0.28) ${pct}%)`;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'US$ 0.000000';
  return `US$ ${n.toFixed(6)}`;
}

function createAudioElement(audioPayload) {
  if (!audioPayload || !audioPayload.base64) return null;
  const mime = audioPayload.mime || 'audio/mpeg';
  return new Audio(`data:${mime};base64,${audioPayload.base64}`);
}

function buildConversationContext(messages) {
  const base = Array.isArray(messages) ? messages : [];
  if (!base.length) return [];

  const filtered = base.filter((item) => {
    if (!item || !item.text) return false;
    const role = String(item.role || '').trim().toLowerCase();
    if (role !== 'user' && role !== 'assistant') return false;
    if (role === 'assistant' && String(item.feedback || '').trim().toLowerCase() === 'rejected') {
      return false;
    }
    return true;
  });

  const seen = new Set();
  const deduped = [];
  for (const item of filtered) {
    const role = String(item.role || '').trim().toLowerCase();
    const text = String(item.text || '').trim().slice(0, 1000);
    const turnId = item.turnId ? String(item.turnId).trim() : '';
    if (!text) continue;
    const key = `${role}|${turnId}|${text.slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  const normalized = deduped.map((item) => ({
    role: item.role,
    text: String(item.text || '').slice(0, 1000),
    quality: item.feedback === 'approved' ? 'approved' : 'unknown',
    at: item.at || null,
    turn_id: item.turnId || null,
    mode: item.mode ? String(item.mode).toLowerCase() : 'answer',
  }));

  if (normalized.length <= 12) return normalized;
  return normalized.slice(normalized.length - 12);
}

export default function VoiceAssistantDock({ floating = true }) {
  const { screenContext } = useScreenContext();
  const recorder = useMicrophoneRecorder();

  const sessionIdRef = useRef(getOrCreateSessionId());
  const audioRef = useRef(null);
  const stopAudioRequestedRef = useRef(false);
  const stageCyclerRef = useRef(null);
  const activeRunRef = useRef({
    token: null,
    sttAbort: null,
    queryAbort: null,
  });
  const messagesEndRef = useRef(null);

  const [status, setStatus] = useState('idle');
  const [pipelineStage, setPipelineStage] = useState('idle');
  const [userText, setUserText] = useState(() => readStoredText(USER_TEXT_STORAGE_KEY));
  const [assistantText, setAssistantText] = useState(() => readStoredText(ASSISTANT_TEXT_STORAGE_KEY));
  const [textDraft, setTextDraft] = useState(() => readStoredText(TEXT_DRAFT_STORAGE_KEY));
  const [voiceEnabled, setVoiceEnabled] = useState(() => readStoredBoolean(VOICE_ENABLED_STORAGE_KEY, true));
  const [errorMessage, setErrorMessage] = useState('');
  const [messages, setMessages] = useState(() => readStoredMessages());
  const [costMetrics, setCostMetrics] = useState(() => readStoredCostMetrics() || buildEmptyCostMetrics());
  const [creditBalance, setCreditBalance] = useState(null);
  const [balanceSource, setBalanceSource] = useState('manual');
  const [lastAssistantTurnId, setLastAssistantTurnId] = useState(() => {
    const stored = readStoredMessages().filter((m) => m.role === 'assistant' && m.turnId);
    if (!stored.length) return null;
    return stored[stored.length - 1].turnId;
  });
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [warmupMeta, setWarmupMeta] = useState({
    done: false,
    inProgress: false,
    latency_ms: 0,
    error: '',
  });
  const [interactionTelemetry, setInteractionTelemetry] = useState(() =>
    createEmptyInteractionTelemetry(null)
  );
  const [pendingAction, setPendingAction] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const [pendingActionDraft, setPendingActionDraft] = useState(null);

  const isBusy = status === 'processing';
  const isSpeaking = status === 'speaking';
  const isListening = status === 'listening';

  useEffect(() => {
    if (!recorder.error) return;
    setErrorMessage(recorder.error);
  }, [recorder.error]);

  useEffect(() => {
    persistCostMetrics(costMetrics);
  }, [costMetrics]);

  useEffect(() => {
    persistMessages(messages);
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isBusy, pendingAction]);

  useEffect(() => {
    persistText(USER_TEXT_STORAGE_KEY, userText);
  }, [userText]);

  useEffect(() => {
    persistText(ASSISTANT_TEXT_STORAGE_KEY, assistantText);
  }, [assistantText]);

  useEffect(() => {
    persistText(TEXT_DRAFT_STORAGE_KEY, textDraft);
  }, [textDraft]);

  useEffect(() => {
    persistBoolean(VOICE_ENABLED_STORAGE_KEY, voiceEnabled);
  }, [voiceEnabled]);

  useEffect(() => () => {
    stopStageCycler();
    cancelInFlightProcessing({ silent: true });
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {}
      audioRef.current = null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const [settingsResult, summaryResult] = await Promise.allSettled([
        getAssistantCostSettings(),
        getAssistantCostSummary(sessionIdRef.current),
      ]);
      if (!active) return;

      if (settingsResult.status === 'fulfilled') {
        const settings =
          settingsResult.value && settingsResult.value.cost_settings
            ? settingsResult.value.cost_settings
            : null;
        if (settings) {
          setCreditBalance(settings.user_credit_balance);
          setBalanceSource(settings.balance_source || 'manual');
        }
      }

      if (summaryResult.status === 'fulfilled') {
        const summaryCost =
          summaryResult.value && summaryResult.value.cost ? summaryResult.value.cost : null;
        if (summaryCost && typeof summaryCost === 'object') {
          setCostMetrics((prev) => ({
            ...(prev && typeof prev === 'object' ? prev : buildEmptyCostMetrics()),
            ...summaryCost,
            interaction: {
              ...((prev && prev.interaction) || {}),
              ...((summaryCost && summaryCost.interaction) || {}),
            },
            balance: {
              ...((prev && prev.balance) || {}),
              ...((summaryCost && summaryCost.balance) || {}),
            },
          }));

          if (
            summaryCost.balance &&
            Number.isFinite(Number(summaryCost.balance.user_credit_balance))
          ) {
            setCreditBalance(Number(summaryCost.balance.user_credit_balance));
            setBalanceSource(String(summaryCost.balance.balance_source || 'manual'));
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setWarmupMeta({
      done: false,
      inProgress: true,
      latency_ms: 0,
      error: '',
    });
    setPipelineStage((prev) => (prev === 'idle' ? 'warming_up' : prev));

    (async () => {
      const startedAt = nowMs();
      try {
        await warmupAssistantSession();
        if (!active) return;
        setWarmupMeta({
          done: true,
          inProgress: false,
          latency_ms: toMs(nowMs() - startedAt),
          error: '',
        });
      } catch (err) {
        if (!active) return;
        setWarmupMeta({
          done: false,
          inProgress: false,
          latency_ms: toMs(nowMs() - startedAt),
          error: err && err.message ? String(err.message) : 'Warm-up nao concluido.',
        });
      } finally {
        if (!active) return;
        setPipelineStage((prev) => (prev === 'warming_up' ? 'idle' : prev));
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const currentStatusLabel = useMemo(() => {
    if (PIPELINE_STAGE_LABEL[pipelineStage]) return PIPELINE_STAGE_LABEL[pipelineStage];
    return STATUS_LABEL[status] || STATUS_LABEL.idle;
  }, [pipelineStage, status]);

  const stopStageCycler = () => {
    if (!stageCyclerRef.current) return;
    clearInterval(stageCyclerRef.current);
    stageCyclerRef.current = null;
  };

  const startStageCycler = (stages, intervalMs = 850) => {
    stopStageCycler();
    const normalized = Array.isArray(stages) ? stages.filter(Boolean) : [];
    if (!normalized.length) return;
    let index = 0;
    setPipelineStage(normalized[index]);
    stageCyclerRef.current = setInterval(() => {
      index = (index + 1) % normalized.length;
      setPipelineStage(normalized[index]);
    }, intervalMs);
  };

  const updateTelemetryForTurn = (turnId, patch) => {
    const normalizedTurn = turnId ? String(turnId) : null;
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    setInteractionTelemetry((prev) => {
      const base = prev && typeof prev === 'object' ? prev : createEmptyInteractionTelemetry(null);
      if (normalizedTurn && base.turn_id && base.turn_id !== normalizedTurn) {
        return base;
      }
      return {
        ...base,
        ...safePatch,
        turn_id: normalizedTurn || base.turn_id || null,
      };
    });
  };

  const clearActiveRunControllers = () => {
    activeRunRef.current = {
      token: null,
      sttAbort: null,
      queryAbort: null,
    };
  };

  const isRunActive = (token) => {
    if (!token) return false;
    return Boolean(activeRunRef.current && activeRunRef.current.token === token);
  };

  const endRun = (token) => {
    if (!isRunActive(token)) return;
    clearActiveRunControllers();
  };

  const cancelInFlightProcessing = ({ silent = false } = {}) => {
    const active = activeRunRef.current;
    if (active && active.sttAbort) {
      try { active.sttAbort.abort(); } catch {}
    }
    if (active && active.queryAbort) {
      try { active.queryAbort.abort(); } catch {}
    }
    clearActiveRunControllers();
    stopStageCycler();
    if (!silent) {
      setErrorMessage('Processamento interrompido.');
      setPipelineStage('cancelled');
      setTimeout(() => {
        setPipelineStage((prev) => (prev === 'cancelled' ? 'idle' : prev));
      }, 1400);
    } else {
      setPipelineStage('idle');
    }
    setStatus('idle');
  };

  const beginRun = (turnId) => {
    cancelInFlightProcessing({ silent: true });
    const token = `${turnId}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    activeRunRef.current = {
      token,
      sttAbort: null,
      queryAbort: null,
    };
    setInteractionTelemetry(createEmptyInteractionTelemetry(String(turnId)));
    return token;
  };

  const appendMessage = (role, text, turnId = null, feedback = 'unknown', mode = 'answer') => {
    const clean = String(text || '').trim();
    if (!clean) return;
    setMessages((prev) => {
      const next = [
        ...prev,
        {
          role,
          text: clean,
          at: Date.now(),
          turnId: turnId ? String(turnId) : null,
          mode: String(mode || 'answer').toLowerCase(),
          feedback: role === 'assistant' ? feedback : 'unknown',
        },
      ];
      if (next.length > 20) return next.slice(next.length - 20);
      return next;
    });
  };

  const stopCurrentAudioPlayback = () => {
    stopAudioRequestedRef.current = true;
    if (!audioRef.current) return;
    try {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    } catch {}
    audioRef.current = null;
    setPipelineStage('idle');
    setStatus('idle');
  };

  const playAssistantAudio = (audioPayload, turnId = null) => {
    const audioElement = createAudioElement(audioPayload);
    if (!audioElement) return;

    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {}
    }

    stopAudioRequestedRef.current = false;
    audioRef.current = audioElement;
    setPipelineStage('speaking');
    setStatus('speaking');
    const playbackRequestedAt = nowMs();
    let playbackStartedAt = 0;

    audioElement.onplaying = () => {
      playbackStartedAt = nowMs();
      updateTelemetryForTurn(turnId, {
        playback_start_ms: toMs(playbackStartedAt - playbackRequestedAt),
      });
    };

    audioElement.onended = () => {
      if (playbackStartedAt > 0) {
        updateTelemetryForTurn(turnId, {
          playback_ms: toMs(nowMs() - playbackStartedAt),
        });
      }
      if (audioRef.current === audioElement) audioRef.current = null;
      setPipelineStage('idle');
      setStatus('idle');
    };
    audioElement.onerror = () => {
      if (audioRef.current === audioElement) audioRef.current = null;
      setPipelineStage('idle');
      setStatus('idle');
      setErrorMessage('Nao foi possivel reproduzir o audio da resposta.');
    };
    audioElement.onpause = () => {
      if (!stopAudioRequestedRef.current) return;
      if (playbackStartedAt > 0) {
        updateTelemetryForTurn(turnId, {
          playback_ms: toMs(nowMs() - playbackStartedAt),
        });
      }
      if (audioRef.current === audioElement) audioRef.current = null;
      stopAudioRequestedRef.current = false;
      setPipelineStage('idle');
      setStatus('idle');
    };

    audioElement.play().catch((err) => {
      if (audioRef.current === audioElement) audioRef.current = null;
      setPipelineStage('idle');
      setStatus('idle');
      setErrorMessage(err && err.message ? err.message : 'Falha ao tocar audio.');
    });
  };

  const submitFeedback = async (feedbackValue) => {
    if (!lastAssistantTurnId || feedbackSaving) return;
    const normalized = feedbackValue === 'approved' ? 'approved' : 'rejected';
    setFeedbackSaving(true);

    try {
      await sendAssistantFeedback({
        sessionId: sessionIdRef.current,
        turnId: lastAssistantTurnId,
        feedback: normalized,
        route: screenContext && screenContext.route ? String(screenContext.route) : '',
        payload: {
          user_text: userText,
          answer_text: assistantText,
        },
      });

      setMessages((prev) =>
        prev.map((item) => {
          if (item.role !== 'assistant' || item.turnId !== lastAssistantTurnId) return item;
          return {
            ...item,
            feedback: normalized,
          };
        })
      );
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(
        err && err.message ? err.message : 'Falha ao salvar feedback da resposta.'
      );
    } finally {
      setFeedbackSaving(false);
    }
  };

  const startListening = async () => {
    cancelInFlightProcessing({ silent: true });
    if (audioRef.current) {
      stopCurrentAudioPlayback();
    }
    setErrorMessage('');
    recorder.clearError();
    const started = await recorder.startRecording();
    if (!started) return;
    setPipelineStage('listening');
    setStatus('listening');
  };

  const runQueryFromUserText = async ({ inputText, turnId, runToken }) => {
    const transcript = String(inputText || '').trim();
    if (!transcript) {
      throw new Error('Pergunta vazia.');
    }
    if (!isRunActive(runToken)) return;

    setUserText(transcript);
    appendMessage('user', transcript, turnId);

    const contextToSend = buildConversationContext([
      ...messages,
      {
        role: 'user',
        text: transcript,
        at: Date.now(),
        turnId,
        feedback: 'unknown',
        mode: 'answer',
      },
    ]);

    if (!isRunActive(runToken)) return;
    setPipelineStage('understanding');
    setStatus('processing');
    startStageCycler(['understanding', 'querying_system', 'preparing_response'], 900);
    const queryStartedAt = nowMs();
    const queryAbort = new AbortController();
    if (isRunActive(runToken)) {
      activeRunRef.current.queryAbort = queryAbort;
    }
    let queryResp = null;
    try {
      queryResp = await queryAssistant({
        userText: transcript,
        sessionId: sessionIdRef.current,
        turnId,
        screenContext,
        conversationContext: contextToSend,
        voiceEnabled,
        signal: queryAbort.signal,
      });
    } finally {
      stopStageCycler();
    }
    if (!isRunActive(runToken)) return;
    const queryRoundtripMs = toMs(nowMs() - queryStartedAt);

    const responseMode = String(queryResp && queryResp.mode ? queryResp.mode : 'answer')
      .trim()
      .toLowerCase();
    const answerText = String(queryResp && queryResp.answer_text ? queryResp.answer_text : '').trim();
    if (!answerText) {
      throw new Error('Consulta concluida, mas a resposta veio vazia.');
    }

    setMessages((prev) =>
      prev.map((item) => {
        if (item.role !== 'user' || item.turnId !== turnId) return item;
        return {
          ...item,
          mode: responseMode,
        };
      })
    );
    setAssistantText(answerText);
    appendMessage('assistant', answerText, turnId, 'unknown', responseMode);
    setLastAssistantTurnId(turnId);
    const actionPreview = queryResp && queryResp.action_preview && typeof queryResp.action_preview === 'object'
      ? queryResp.action_preview
      : null;
    if (queryResp && queryResp.action_preview_invalidated) {
      setPendingAction(null);
      setActionStatus('');
    }
    if (actionPreview && actionPreview.confirmation_token) {
      setPendingAction(actionPreview);
      setActionStatus('');
    }
    if (queryResp && Object.prototype.hasOwnProperty.call(queryResp, 'pending_action_draft')) {
      setPendingActionDraft(queryResp.pending_action_draft || null);
    }

    const queryTelemetry = queryResp && queryResp.telemetry ? queryResp.telemetry : {};
    const orchestratorTelemetry =
      queryTelemetry && queryTelemetry.orchestrator ? queryTelemetry.orchestrator : {};
    updateTelemetryForTurn(turnId, {
      query_roundtrip_ms: queryRoundtripMs,
      orchestration_ms: toMs(
        (queryTelemetry && queryTelemetry.orchestration_ms) ||
        (orchestratorTelemetry && orchestratorTelemetry.orchestration_ms)
      ),
      tool_execution_ms: toMs(orchestratorTelemetry && orchestratorTelemetry.tool_execution_ms),
      response_generation_ms: toMs(
        (orchestratorTelemetry && orchestratorTelemetry.response_generation_ms) ||
        (orchestratorTelemetry && orchestratorTelemetry.answer_generation_ms)
      ),
      tts_ms: toMs(
        (queryTelemetry && queryTelemetry.tts_generation_ms) ||
        (queryResp && queryResp.audio && queryResp.audio.telemetry && queryResp.audio.telemetry.total_ms)
      ),
    });

    const cost = queryResp && queryResp.cost ? queryResp.cost : null;
    if (cost) {
      setCostMetrics(cost);
      if (cost.balance && Number.isFinite(Number(cost.balance.user_credit_balance))) {
        setCreditBalance(Number(cost.balance.user_credit_balance));
        setBalanceSource(String(cost.balance.balance_source || 'manual'));
      }
    }

    if (voiceEnabled && queryResp && queryResp.audio && queryResp.audio.base64) {
      playAssistantAudio(queryResp.audio, turnId);
    } else {
      setPipelineStage('idle');
      setStatus('idle');
    }
    endRun(runToken);

    if (queryResp && queryResp.tts_error) {
      setErrorMessage(String(queryResp.tts_error));
    }
  };

  const stopAndProcess = async () => {
    if (audioRef.current) {
      stopCurrentAudioPlayback();
    }
    setErrorMessage('');

    const turnId = createAssistantTurnId();
    const runToken = beginRun(turnId);
    setStatus('processing');

    try {
      const recording = await recorder.stopRecording();
      if (!isRunActive(runToken)) return;
      const audioBlob = recording && recording.audioBlob ? recording.audioBlob : null;
      const durationMs = recording && Number.isFinite(Number(recording.durationMs))
        ? Number(recording.durationMs)
        : null;
      const captureAudioMs = durationMs && durationMs > 0 ? toMs(durationMs) : 0;
      updateTelemetryForTurn(turnId, {
        capture_audio_ms: captureAudioMs,
      });

      if (!audioBlob || audioBlob.size <= 0) {
        throw new Error('Captacao vazia. Fale novamente.');
      }

      const sttAbort = new AbortController();
      if (isRunActive(runToken)) {
        activeRunRef.current.sttAbort = sttAbort;
      }
      setPipelineStage('sending_audio');
      setStatus('processing');
      startStageCycler(['sending_audio', 'transcribing'], 700);
      const sttStartedAt = nowMs();
      const sttResp = await sendAudioToStt({
        audioBlob,
        sessionId: sessionIdRef.current,
        turnId,
        durationMs,
        language: 'pt',
        signal: sttAbort.signal,
      });
      stopStageCycler();
      if (!isRunActive(runToken)) return;
      const sttRoundtripMs = toMs(nowMs() - sttStartedAt);
      const sttTelemetry = sttResp && sttResp.telemetry ? sttResp.telemetry : {};
      const sttMs = toMs(
        sttTelemetry && (
          sttTelemetry.stt_total_ms ||
          sttTelemetry.stt_provider_ms ||
          sttTelemetry.endpoint_total_ms
        )
      );
      updateTelemetryForTurn(turnId, {
        stt_roundtrip_ms: sttRoundtripMs,
        stt_ms: sttMs,
        upload_audio_ms: Math.max(0, sttRoundtripMs - sttMs),
      });

      const transcript = String(sttResp && sttResp.transcript ? sttResp.transcript : '').trim();
      if (!transcript) {
        throw new Error('Nao consegui entender o audio. Tente falar de novo.');
      }

      await runQueryFromUserText({ inputText: transcript, turnId, runToken });
    } catch (err) {
      stopStageCycler();
      if (isAbortError(err)) {
        if (isRunActive(runToken)) {
          setErrorMessage('Processamento interrompido.');
          setPipelineStage('idle');
          setStatus('idle');
          endRun(runToken);
        }
        return;
      }
      endRun(runToken);
      setErrorMessage(getAssistantErrorMessage(err, 'Falha no fluxo de voz.'));
      setPipelineStage('idle');
      setStatus('idle');
    }
  };

  const handleSendText = async () => {
    if (isBusy) return;
    if (isListening) {
      setErrorMessage('Finalize a captura de audio antes de enviar texto.');
      return;
    }

    const cleanText = String(textDraft || '').trim();
    if (!cleanText) {
      setErrorMessage('Digite uma pergunta para enviar por texto.');
      return;
    }

    if (audioRef.current) {
      stopCurrentAudioPlayback();
    }
    setErrorMessage('');

    const turnId = createAssistantTurnId();
    const runToken = beginRun(turnId);
    setStatus('processing');

    try {
      await runQueryFromUserText({
        inputText: cleanText,
        turnId,
        runToken,
      });
      setTextDraft('');
    } catch (err) {
      if (isAbortError(err)) {
        if (isRunActive(runToken)) {
          setErrorMessage('Processamento interrompido.');
          setPipelineStage('idle');
          setStatus('idle');
          endRun(runToken);
        }
        return;
      }
      endRun(runToken);
      setErrorMessage(getAssistantErrorMessage(err, 'Falha ao consultar por texto.'));
      setPipelineStage('idle');
      setStatus('idle');
    }
  };

  const toggleVoice = () => {
    setVoiceEnabled((prev) => {
      const next = !prev;
      if (!next && audioRef.current) {
        stopCurrentAudioPlayback();
      }
      return next;
    });
  };

  const handleAdjustBalance = async () => {
    const currentValue = Number.isFinite(Number(creditBalance)) ? Number(creditBalance) : 0;
    const raw = window.prompt(
      'Defina o saldo local em USD (ex: 25.50).',
      String(currentValue.toFixed(2))
    );
    if (raw == null) return;

    const normalized = Number(String(raw).trim().replace(',', '.'));
    if (!Number.isFinite(normalized)) {
      setErrorMessage('Saldo invalido. Informe um numero em USD.');
      return;
    }

    try {
      const resp = await updateAssistantCostSettings({ userCreditBalance: normalized });
      const settings = resp && resp.cost_settings ? resp.cost_settings : null;
      if (!settings) return;

      const nextBalance = Number(settings.user_credit_balance);
      setCreditBalance(Number.isFinite(nextBalance) ? nextBalance : 0);
      setBalanceSource(String(settings.balance_source || 'manual'));
      setCostMetrics((prev) => {
        const base =
          prev && typeof prev === 'object' ? prev : buildEmptyCostMetrics();
        return {
          ...base,
          balance: {
            user_credit_balance: Number.isFinite(nextBalance) ? nextBalance : 0,
            balance_source: String(settings.balance_source || 'manual'),
          },
        };
      });
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(
        err && err.message ? err.message : 'Falha ao atualizar saldo local do assistente.'
      );
    }
  };

  const handleMainAction = async () => {
    if (isBusy) return;
    if (!recorder.isSupported) {
      setErrorMessage('Este ambiente nao suporta microfone para o assistente.');
      return;
    }

    if (!isListening) {
      await startListening();
      return;
    }

    await stopAndProcess();
  };

  const handleClearConversation = async () => {
    cancelInFlightProcessing({ silent: true });
    if (isListening) {
      try {
        await recorder.stopRecording();
      } catch {}
    }
    if (audioRef.current) {
      stopCurrentAudioPlayback();
    }

    const previousSessionId = sessionIdRef.current;
    const activePreview = pendingAction;
    if (activePreview && activePreview.confirmation_token) {
      try {
        await cancelAssistantAction({
          sessionId: previousSessionId,
          confirmationToken: activePreview.confirmation_token,
        });
      } catch {
        // O token pode ja ter expirado; a troca de sessao ainda o torna inutil.
      }
    }
    try {
      await resetAssistantSession(previousSessionId);
    } catch {
      // A nova sessao continua segura mesmo se o backend ja tiver expirado a anterior.
    }

    const nextSessionId = createAssistantSessionId();
    sessionIdRef.current = nextSessionId;
    try {
      sessionStorage.setItem(SESSION_ID_STORAGE_KEY, nextSessionId);
    } catch {}

    setMessages([]);
    setUserText('');
    setAssistantText('');
    setTextDraft('');
    setLastAssistantTurnId(null);
    setErrorMessage('');
    setStatus('idle');
    setPipelineStage('idle');
    setInteractionTelemetry(createEmptyInteractionTelemetry(null));
    setPendingAction(null);
    setActionBusy(false);
    setActionStatus('');
    setPendingActionDraft(null);
    setCostMetrics((prev) => ({
      ...(prev && typeof prev === 'object' ? prev : buildEmptyCostMetrics()),
      interaction: {
        estimated_total: 0,
        is_estimated: true,
        source: 'manual_clear',
      },
      session_total: 0,
    }));

    try {
      const summary = await getAssistantCostSummary(nextSessionId);
      const summaryCost =
        summary && summary.cost && typeof summary.cost === 'object'
          ? summary.cost
          : null;
      if (summaryCost) {
        setCostMetrics((prev) => ({
          ...(prev && typeof prev === 'object' ? prev : buildEmptyCostMetrics()),
          ...summaryCost,
          interaction: {
            ...((prev && prev.interaction) || {}),
            ...((summaryCost && summaryCost.interaction) || {}),
          },
          balance: {
            ...((prev && prev.balance) || {}),
            ...((summaryCost && summaryCost.balance) || {}),
          },
        }));
      }
    } catch {}
  };

  const getActionFailureMessage = (err) => {
    const code = String(err && err.code ? err.code : '');
    if (code === 'state_changed') return 'Os dados mudaram desde a prévia. Gere uma nova confirmação.';
    if (code === 'token_expired') return 'Esta prévia expirou. Gere uma nova confirmação.';
    if (code === 'token_unavailable' || code === 'token_not_found') return 'Esta prévia não está mais disponível. Gere uma nova confirmação.';
    return 'Não foi possível concluir esta ação. Nenhum pagamento foi confirmado.';
  };

  const handleConfirmAction = async () => {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    setActionStatus('Confirmando pagamento…');
    try {
      await confirmAssistantAction({
        sessionId: sessionIdRef.current,
        confirmationToken: pendingAction.confirmation_token,
      });
      appendMessage('assistant', 'Pagamento registrado com sucesso.', createAssistantTurnId(), 'unknown', 'action_result');
      setAssistantText('Pagamento registrado com sucesso.');
      setPendingAction(null);
      setPendingActionDraft(null);
      setActionStatus('');
    } catch (err) {
      const message = getActionFailureMessage(err);
      setActionStatus(message);
      if (['state_changed', 'token_expired', 'token_unavailable', 'token_not_found'].includes(String(err && err.code ? err.code : ''))) {
        setPendingAction(null);
        setErrorMessage(message);
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleCancelAction = async () => {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    setActionStatus('Cancelando prévia…');
    try {
      await cancelAssistantAction({
        sessionId: sessionIdRef.current,
        confirmationToken: pendingAction.confirmation_token,
      });
      appendMessage('assistant', 'Operação cancelada. Nenhum pagamento foi registrado.', createAssistantTurnId(), 'unknown', 'action_result');
      setAssistantText('Operação cancelada. Nenhum pagamento foi registrado.');
      setPendingAction(null);
      setPendingActionDraft(null);
      setActionStatus('');
    } catch (err) {
      setActionStatus(getActionFailureMessage(err));
      if (['token_expired', 'token_unavailable', 'token_not_found'].includes(String(err && err.code ? err.code : ''))) {
        setPendingAction(null);
        setErrorMessage(getActionFailureMessage(err));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleDiscardActionDraft = async () => {
    if (actionBusy || !pendingActionDraft) return;
    setActionBusy(true);
    try {
      await discardAssistantActionDraft(sessionIdRef.current);
      setPendingActionDraft(null);
      setPendingAction(null);
      appendMessage('assistant', 'Rascunho descartado. Nenhum pagamento foi registrado.', createAssistantTurnId(), 'unknown', 'action_result');
    } catch (err) {
      setErrorMessage(getActionFailureMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleCancelProcessing = () => {
    if (!isBusy) return;
    cancelInFlightProcessing({ silent: false });
  };

  const audioLevelPercent = Math.round((recorder.audioLevel || 0) * 100);
  const interactionCostText = formatUsd(
    costMetrics && costMetrics.interaction ? costMetrics.interaction.estimated_total : 0
  );
  const sessionCostText = formatUsd(costMetrics ? costMetrics.session_total : 0);
  const allTimeCostText = formatUsd(costMetrics ? costMetrics.all_time_total : 0);
  const resolvedBalanceValue = Number.isFinite(Number(creditBalance))
    ? Number(creditBalance)
    : costMetrics && costMetrics.balance
      ? costMetrics.balance.user_credit_balance
      : 0;
  const resolvedBalanceSource = balanceSource || (
    costMetrics && costMetrics.balance && costMetrics.balance.balance_source
      ? String(costMetrics.balance.balance_source)
      : 'manual'
  );
  const balanceText = formatUsd(resolvedBalanceValue);
  const stageTimingChips = useMemo(
    () => buildStageTimingChips(interactionTelemetry),
    [interactionTelemetry]
  );
  const activeStageIndex = PIPELINE_PROGRESS_ORDER.indexOf(pipelineStage);
  const pipelineProgressPercent = activeStageIndex >= 0
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round(((activeStageIndex + 1) / PIPELINE_PROGRESS_ORDER.length) * 100)
        )
      )
    : pipelineStage === 'warming_up'
      ? 12
      : 0;
  const stageTimingTotalMs = stageTimingChips.reduce((sum, chip) => sum + toMs(chip.value), 0);
  const pipelineProgressLabel = isBusy || isListening || isSpeaking || pipelineStage === 'cancelled'
    ? PIPELINE_STAGE_LABEL[pipelineStage] || currentStatusLabel
    : 'Aguardando nova interacao';
  const rootStyle = floating ? styles.rootFloating : styles.rootEmbedded;
  const lastAssistantMessage = useMemo(() => {
    const reversed = [...messages].reverse();
    if (lastAssistantTurnId) {
      const byTurn = reversed.find(
        (item) => item.role === 'assistant' && item.turnId === lastAssistantTurnId
      );
      if (byTurn) return byTurn;
    }
    return reversed.find((item) => item.role === 'assistant') || null;
  }, [messages, lastAssistantTurnId]);
  const lastFeedback = lastAssistantMessage ? lastAssistantMessage.feedback || 'unknown' : 'unknown';

  return (
    <div style={rootStyle}>
      <style>{`
        @keyframes assistantPulse {
          0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.45); }
          70% { box-shadow: 0 0 0 16px rgba(16, 185, 129, 0); }
          100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        @keyframes assistantProcessingBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes assistantSpeakBars {
          0%, 100% { transform: scaleY(0.45); }
          50% { transform: scaleY(1); }
        }
      `}</style>

      <section style={styles.panel} aria-live="polite">
        <header style={styles.header}>
          <div style={styles.headerLeft}>
            <div style={styles.iconWrap}>
              <AssistantWomanIcon />
            </div>
            <div>
            <div style={styles.title}>Assistente</div>
              <div
                style={{
                  ...styles.subtitle,
                  ...(status === 'processing' ? styles.subtitleProcessing : null),
                }}
              >
                {currentStatusLabel}
              </div>
            </div>
          </div>

          <div style={styles.headerActions}>
            <button
              type="button"
              onClick={toggleVoice}
              style={{
                ...styles.soundToggleButton,
                ...(voiceEnabled ? styles.soundToggleOn : styles.soundToggleOff),
              }}
              title={voiceEnabled ? 'Desativar fala da assistente' : 'Ativar fala da assistente'}
              aria-label={voiceEnabled ? 'Desativar fala da assistente' : 'Ativar fala da assistente'}
            >
              <span style={styles.soundToggleIcon}>{voiceEnabled ? '🔊' : '🔇'}</span>
              <span>{voiceEnabled ? 'Som' : 'Texto'}</span>
            </button>
            <button
              type="button"
              onClick={handleMainAction}
              disabled={isBusy}
              style={{
                ...styles.mainButton,
                ...(isListening ? styles.mainButtonListening : null),
                ...(isBusy ? styles.mainButtonBusy : null),
              }}
              title={isListening ? 'Parar escuta e processar' : 'Iniciar escuta'}
              aria-label={isListening ? 'Parar escuta e processar' : 'Iniciar escuta'}
            >
              <span style={styles.mainButtonIcon}>MIC</span>
              <span>{isListening ? 'Parar' : 'Ouvir'}</span>
            </button>
            <button
              type="button"
              onClick={handleClearConversation}
              style={styles.clearConversationButton}
              title="Limpar conversa e iniciar nova sessao"
              aria-label="Limpar conversa e iniciar nova sessao"
            >
              Nova conversa
            </button>
            {isBusy ? (
              <button
                type="button"
                onClick={handleCancelProcessing}
                style={styles.cancelRunButton}
                title="Cancelar processamento atual"
                aria-label="Cancelar processamento atual"
              >
                Cancelar
              </button>
            ) : null}
            {isSpeaking ? (
              <button
                type="button"
                onClick={stopCurrentAudioPlayback}
                style={styles.stopSpeakButton}
                title="Parar fala"
                aria-label="Parar fala"
              >
                Parar fala
              </button>
            ) : null}
          </div>
        </header>

        <div style={styles.levelBlock}>
          <div style={styles.levelLabel}>Captacao de audio</div>
          <div style={{ ...styles.levelTrack, background: buildAudioLevelGradient(recorder.audioLevel || 0) }} />
          <div style={styles.levelMeta}>{isListening ? `${audioLevelPercent}%` : 'inativo'}</div>
        </div>

        <div style={styles.progressBlock}>
          <div style={styles.progressHeader}>
            <span style={styles.progressTitle}>Fluxo da interacao</span>
            <span style={styles.progressStage}>{pipelineProgressLabel}</span>
          </div>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${pipelineProgressPercent}%` }} />
          </div>
          <div style={styles.progressMetaRow}>
            <span style={styles.progressMetaText}>
              Etapa: {PIPELINE_STAGE_LABEL[pipelineStage] || STATUS_LABEL[status] || 'Pronta'}
            </span>
            <span style={styles.progressMetaText}>
              {stageTimingTotalMs > 0 ? `Tempo ~ ${formatMs(stageTimingTotalMs)}` : 'Sem tempos ainda'}
            </span>
          </div>
          {stageTimingChips.length ? (
            <div style={styles.stageTimingWrap}>
              {stageTimingChips.map((chip) => (
                <span key={chip.key} style={styles.stageTimingChip}>
                  <strong style={styles.stageTimingChipLabel}>{chip.label}</strong> {formatMs(chip.value)}
                </span>
              ))}
            </div>
          ) : null}
          {warmupMeta.inProgress || warmupMeta.done ? (
            <div style={styles.warmupMeta}>
              Warm-up:{' '}
              {warmupMeta.inProgress
                ? 'preparando pipeline...'
                : warmupMeta.error
                  ? `falhou (${warmupMeta.error})`
                  : `ok em ${formatMs(warmupMeta.latency_ms)}`}
            </div>
          ) : null}
        </div>

        <div style={styles.costBar}>
          <div style={styles.costHeader}>
            <span style={styles.costIconWrap}>
              <MoneyIcon />
            </span>
            <span style={styles.costHeaderText}>Monitor de custo</span>
            <button type="button" style={styles.balanceButton} onClick={handleAdjustBalance}>
              Ajustar saldo
            </button>
          </div>
          <div style={styles.costGrid}>
            <div style={styles.costChip}>
              <span style={styles.costChipLabel}>Pergunta</span>
              <span style={styles.costChipValue}>{interactionCostText}</span>
            </div>
            <div style={styles.costChip}>
              <span style={styles.costChipLabel}>Sessao</span>
              <span style={styles.costChipValue}>{sessionCostText}</span>
            </div>
            <div style={styles.costChip}>
              <span style={styles.costChipLabel}>Total</span>
              <span style={styles.costChipValue}>{allTimeCostText}</span>
            </div>
          </div>
          <div style={styles.balanceMeta}>
            Saldo: {balanceText} ({resolvedBalanceSource === 'provider_api' ? 'provider_api' : 'manual'})
          </div>
        </div>

        {status === 'speaking' ? (
          <div style={styles.speakingRow}>
            <span style={{ ...styles.speakBar, animationDelay: '0ms' }} />
            <span style={{ ...styles.speakBar, animationDelay: '120ms' }} />
            <span style={{ ...styles.speakBar, animationDelay: '240ms' }} />
            <span style={{ ...styles.speakBar, animationDelay: '360ms' }} />
            <span style={styles.speakingText}>Respondendo por voz...</span>
          </div>
        ) : null}

        <div style={styles.chatHistory} aria-label="Historico da conversa">
          {messages.length ? messages.map((item) => (
            <article
              key={`${item.at}_${item.role}_${item.turnId || ''}`}
              style={{
                ...styles.chatMessage,
                ...(item.role === 'assistant' ? styles.chatMessageAssistant : styles.chatMessageUser),
              }}
            >
              <div style={styles.chatRole}>{item.role === 'assistant' ? 'Assistente' : 'Você'}</div>
              <div style={styles.chatContent}>
                {item.role === 'assistant' ? <SafeMarkdown>{item.text}</SafeMarkdown> : item.text}
              </div>
            </article>
          )) : (
            <div style={styles.emptyConversation}>
              Pergunte qualquer coisa sobre seus dados financeiros.
            </div>
          )}
          {isBusy ? <div style={styles.thinkingMessage}>Assistente está pensando…</div> : null}
          {pendingAction ? (
            <ActionPreviewCard
              actionPreview={pendingAction}
              busy={actionBusy}
              statusText={actionStatus}
              onConfirm={handleConfirmAction}
              onCancel={handleCancelAction}
            />
          ) : null}
          {!pendingAction ? (
            <ActionDraftNotice draft={pendingActionDraft} busy={actionBusy} onDiscard={handleDiscardActionDraft} />
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <div style={styles.textComposer}>
          <div style={styles.textInputWrap}>
            <textarea
              value={textDraft}
              onChange={(ev) => setTextDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  handleSendText();
                }
              }}
              placeholder="Pergunte qualquer coisa sobre seus dados financeiros."
              style={styles.textArea}
              disabled={isBusy || isListening}
            />
          </div>
          <button
            type="button"
            onClick={handleSendText}
            disabled={isBusy || isListening}
            style={{
              ...styles.sendTextButton,
              ...(isBusy || isListening ? styles.sendTextButtonDisabled : null),
            }}
          >
            Enviar
          </button>
        </div>

        {assistantText ? (
          <div style={styles.feedbackRow}>
            <span style={styles.feedbackLabel}>Entendimento desta resposta</span>
            <button
              type="button"
              onClick={() => submitFeedback('approved')}
              disabled={!lastAssistantTurnId || feedbackSaving}
              style={{
                ...styles.feedbackButton,
                ...(lastFeedback === 'approved' ? styles.feedbackButtonActiveGood : null),
              }}
            >
              👍 Certo
            </button>
            <button
              type="button"
              onClick={() => submitFeedback('rejected')}
              disabled={!lastAssistantTurnId || feedbackSaving}
              style={{
                ...styles.feedbackButton,
                ...(lastFeedback === 'rejected' ? styles.feedbackButtonActiveBad : null),
              }}
            >
              👎 Errado
            </button>
          </div>
        ) : null}

        {errorMessage ? <div style={styles.errorBox}>{errorMessage}</div> : null}

      </section>
    </div>
  );
}

const styles = {
  rootFloating: {
    position: 'fixed',
    right: 18,
    bottom: 18,
    zIndex: 20400,
    width: 'min(360px, calc(100vw - 24px))',
  },
  rootEmbedded: {
    position: 'relative',
    width: '100%',
    maxWidth: 'min(1180px, var(--main-max-effective, var(--main-max)))',
    margin: '0 auto',
  },
  panel: {
    borderRadius: 16,
    border: '1px solid rgba(148, 163, 184, 0.35)',
    background: 'rgba(15, 23, 42, 0.94)',
    backdropFilter: 'blur(8px)',
    color: '#e2e8f0',
    boxShadow: '0 14px 44px rgba(2, 6, 23, 0.45)',
    padding: 14,
    display: 'grid',
    gap: 10,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  headerLeft: {
    display: 'flex',
    gap: 9,
    alignItems: 'center',
    minWidth: 0,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(191, 219, 254, 0.16)',
    flexShrink: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.2,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#93c5fd',
  },
  subtitleProcessing: {
    animation: 'assistantProcessingBlink 1s ease-in-out infinite',
    color: '#7dd3fc',
    fontWeight: 700,
  },
  soundToggleButton: {
    borderRadius: 999,
    border: '1px solid rgba(148, 163, 184, 0.45)',
    padding: '7px 10px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
  },
  soundToggleOn: {
    background: 'rgba(3, 105, 161, 0.75)',
    color: '#e0f2fe',
    border: '1px solid rgba(56, 189, 248, 0.65)',
  },
  soundToggleOff: {
    background: 'rgba(51, 65, 85, 0.82)',
    color: '#e2e8f0',
    border: '1px solid rgba(148, 163, 184, 0.55)',
  },
  soundToggleIcon: {
    lineHeight: 1,
    fontSize: 13,
  },
  mainButton: {
    border: 'none',
    borderRadius: 999,
    background: '#0ea5e9',
    color: '#082f49',
    fontWeight: 700,
    padding: '8px 12px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 92,
    justifyContent: 'center',
  },
  mainButtonListening: {
    background: '#34d399',
    color: '#052e16',
    animation: 'assistantPulse 1.2s infinite',
  },
  mainButtonBusy: {
    opacity: 0.7,
    cursor: 'default',
  },
  mainButtonIcon: {
    fontSize: 15,
    lineHeight: 1,
  },
  clearConversationButton: {
    border: '1px solid rgba(148, 163, 184, 0.55)',
    borderRadius: 999,
    background: 'rgba(30, 41, 59, 0.82)',
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: 700,
    padding: '7px 10px',
    cursor: 'pointer',
  },
  stopSpeakButton: {
    border: '1px solid rgba(244, 63, 94, 0.6)',
    borderRadius: 999,
    background: 'rgba(127, 29, 29, 0.8)',
    color: '#fee2e2',
    fontSize: 11,
    fontWeight: 700,
    padding: '7px 10px',
    cursor: 'pointer',
  },
  cancelRunButton: {
    border: '1px solid rgba(248, 113, 113, 0.72)',
    borderRadius: 999,
    background: 'rgba(127, 29, 29, 0.86)',
    color: '#fee2e2',
    fontSize: 11,
    fontWeight: 700,
    padding: '7px 10px',
    cursor: 'pointer',
  },
  levelBlock: {
    display: 'grid',
    gap: 4,
  },
  levelLabel: {
    fontSize: 11,
    color: '#cbd5e1',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  levelTrack: {
    height: 9,
    borderRadius: 999,
    border: '1px solid rgba(148, 163, 184, 0.35)',
  },
  levelMeta: {
    fontSize: 11,
    color: '#93c5fd',
  },
  progressBlock: {
    borderRadius: 10,
    border: '1px solid rgba(56, 189, 248, 0.35)',
    background: 'rgba(15, 23, 42, 0.72)',
    padding: '8px 9px',
    display: 'grid',
    gap: 6,
  },
  progressHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressTitle: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#bfdbfe',
    fontWeight: 700,
  },
  progressStage: {
    fontSize: 11,
    color: '#7dd3fc',
  },
  progressTrack: {
    width: '100%',
    height: 7,
    borderRadius: 999,
    background: 'rgba(148, 163, 184, 0.2)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    background: 'linear-gradient(90deg, #22d3ee 0%, #34d399 100%)',
    transition: 'width 220ms ease',
  },
  progressMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  progressMetaText: {
    fontSize: 11,
    color: '#cbd5e1',
  },
  stageTimingWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  stageTimingChip: {
    borderRadius: 999,
    border: '1px solid rgba(125, 211, 252, 0.3)',
    background: 'rgba(15, 23, 42, 0.86)',
    color: '#bae6fd',
    fontSize: 10,
    padding: '2px 7px',
    lineHeight: 1.25,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  stageTimingChipLabel: {
    color: '#67e8f9',
    fontWeight: 700,
  },
  warmupMeta: {
    fontSize: 11,
    color: '#93c5fd',
  },
  costBar: {
    borderRadius: 10,
    border: '1px solid rgba(16, 185, 129, 0.38)',
    background: 'rgba(5, 46, 22, 0.4)',
    padding: '8px 9px',
    display: 'grid',
    gap: 7,
  },
  costHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  costIconWrap: {
    width: 18,
    height: 18,
    borderRadius: 999,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(16, 185, 129, 0.22)',
    color: '#6ee7b7',
    flexShrink: 0,
  },
  costHeaderText: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#bbf7d0',
    fontWeight: 700,
  },
  balanceButton: {
    marginLeft: 'auto',
    border: '1px solid rgba(148, 163, 184, 0.45)',
    borderRadius: 999,
    background: 'rgba(30, 41, 59, 0.9)',
    color: '#e2e8f0',
    fontSize: 11,
    padding: '2px 8px',
    cursor: 'pointer',
  },
  costGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  costChip: {
    borderRadius: 8,
    background: 'rgba(15, 23, 42, 0.76)',
    border: '1px solid rgba(74, 222, 128, 0.24)',
    padding: '6px 7px',
    display: 'grid',
    gap: 2,
  },
  costChipLabel: {
    fontSize: 10,
    color: '#86efac',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  costChipValue: {
    fontSize: 11,
    fontWeight: 700,
    color: '#dcfce7',
    lineHeight: 1.2,
  },
  balanceMeta: {
    fontSize: 11,
    color: '#bbf7d0',
  },
  speakingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  speakBar: {
    width: 4,
    height: 14,
    borderRadius: 999,
    background: '#38bdf8',
    transformOrigin: 'bottom',
    animation: 'assistantSpeakBars 0.8s ease-in-out infinite',
  },
  speakingText: {
    fontSize: 12,
    color: '#bae6fd',
    marginLeft: 4,
  },
  textBlock: {
    borderRadius: 10,
    border: '1px solid rgba(148, 163, 184, 0.22)',
    background: 'rgba(30, 41, 59, 0.72)',
    padding: '8px 9px',
    display: 'grid',
    gap: 4,
  },
  textTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: '#cbd5e1',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  textValue: {
    fontSize: 13,
    lineHeight: 1.35,
    color: '#e2e8f0',
    minHeight: 16,
  },
  textComposer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  textInputWrap: {
    flex: 1,
    minWidth: 0,
  },
  textInput: {
    width: '100%',
    minWidth: 0,
    borderRadius: 9,
    border: '1px solid rgba(148, 163, 184, 0.35)',
    background: 'rgba(15, 23, 42, 0.8)',
    color: '#e2e8f0',
    fontSize: 13,
    padding: '8px 10px',
    outline: 'none',
  },
  textArea: {
    width: '100%', minWidth: 0, minHeight: 48, maxHeight: 128, resize: 'vertical', boxSizing: 'border-box',
    borderRadius: 9, border: '1px solid rgba(148, 163, 184, 0.35)', background: 'rgba(15, 23, 42, 0.8)',
    color: '#e2e8f0', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.4, padding: '10px', outline: 'none',
  },
  chatHistory: {
    minHeight: 360, maxHeight: 'min(58vh, 650px)', overflowY: 'auto', padding: 4,
    display: 'grid', alignContent: 'start', gap: 10,
  },
  emptyConversation: { alignSelf: 'center', justifySelf: 'center', color: '#cbd5e1', textAlign: 'center', padding: 32, fontSize: 15 },
  chatMessage: { width: 'min(88%, 800px)', borderRadius: 12, padding: '10px 12px', lineHeight: 1.45, fontSize: 14 },
  chatMessageUser: { justifySelf: 'end', background: 'rgba(30, 64, 175, 0.52)', border: '1px solid rgba(96, 165, 250, 0.6)' },
  chatMessageAssistant: { justifySelf: 'start', background: 'rgba(30, 41, 59, 0.82)', border: '1px solid rgba(148, 163, 184, 0.32)' },
  chatRole: { marginBottom: 5, color: '#93c5fd', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' },
  chatContent: { overflowWrap: 'anywhere' },
  thinkingMessage: { color: '#bae6fd', fontSize: 13, padding: '6px 10px', fontStyle: 'italic' },
  sendTextButton: {
    borderRadius: 9,
    border: '1px solid rgba(56, 189, 248, 0.65)',
    background: 'rgba(2, 132, 199, 0.88)',
    color: '#e0f2fe',
    fontSize: 12,
    fontWeight: 700,
    padding: '8px 11px',
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  sendTextButtonDisabled: {
    opacity: 0.55,
    cursor: 'default',
  },
  feedbackRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    borderRadius: 10,
    border: '1px solid rgba(56, 189, 248, 0.22)',
    background: 'rgba(15, 23, 42, 0.55)',
    padding: '7px 9px',
  },
  feedbackLabel: {
    fontSize: 11,
    color: '#cbd5e1',
    marginRight: 4,
  },
  feedbackButton: {
    border: '1px solid rgba(148, 163, 184, 0.45)',
    borderRadius: 999,
    background: 'rgba(30, 41, 59, 0.85)',
    color: '#e2e8f0',
    fontSize: 11,
    padding: '4px 10px',
    cursor: 'pointer',
    fontWeight: 700,
  },
  feedbackButtonActiveGood: {
    border: '1px solid rgba(34, 197, 94, 0.75)',
    background: 'rgba(20, 83, 45, 0.85)',
    color: '#bbf7d0',
  },
  feedbackButtonActiveBad: {
    border: '1px solid rgba(244, 63, 94, 0.75)',
    background: 'rgba(127, 29, 29, 0.85)',
    color: '#fecdd3',
  },
  errorBox: {
    borderRadius: 10,
    border: '1px solid rgba(252, 165, 165, 0.8)',
    background: 'rgba(127, 29, 29, 0.85)',
    color: '#fee2e2',
    fontSize: 12,
    padding: '8px 9px',
  },
  historyWrap: {
    display: 'grid',
    gap: 6,
  },
  historyItem: {
    borderRadius: 8,
    padding: '7px 8px',
    fontSize: 12,
    lineHeight: 1.3,
  },
  historyItemUser: {
    background: 'rgba(30, 64, 175, 0.35)',
    border: '1px solid rgba(96, 165, 250, 0.55)',
  },
  historyItemAssistant: {
    background: 'rgba(5, 150, 105, 0.25)',
    border: '1px solid rgba(16, 185, 129, 0.45)',
  },
  historyRole: {
    fontWeight: 700,
  },
};

