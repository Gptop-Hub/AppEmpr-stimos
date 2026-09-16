const db = require('../../models/database');

const CURRENCY = 'USD';
const COST_MODE_ESTIMATED = 'estimated';
const COST_MODE_RECONCILED = 'provider_reconciled';

const DEFAULT_MODEL_PRICING = Object.freeze({
  'gpt-4o-mini': {
    input_per_1k_tokens_usd: 0.00015,
    output_per_1k_tokens_usd: 0.0006,
  },
  'gpt-4o-mini-transcribe': {
    input_per_1k_tokens_usd: 0.0003,
    output_per_1k_tokens_usd: 0.0003,
  },
  'gpt-4o-mini-tts': {
    per_1k_chars_usd: 0.015,
  },
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundUsd(value) {
  const n = toFiniteNumber(value, 0);
  return Math.round(n * 1e8) / 1e8;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function safeJsonParse(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function readPricingOverrides() {
  const raw = String(process.env.ASSISTANT_MODEL_PRICING_JSON || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getPricingTable() {
  const overrides = readPricingOverrides();
  return {
    ...DEFAULT_MODEL_PRICING,
    ...overrides,
  };
}

function resolveModelPricing(model) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;

  const table = getPricingTable();
  const entries = Object.entries(table)
    .map(([key, value]) => [String(key).toLowerCase(), value])
    .filter(([, value]) => isPlainObject(value))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [key, value] of entries) {
    if (normalized === key || normalized.startsWith(`${key}-`) || normalized.includes(key)) {
      return value;
    }
  }
  return null;
}

function getDefaultTokenPricing(stage) {
  if (stage === 'stt') {
    return {
      input_per_1k_tokens_usd: toFiniteNumber(
        process.env.ASSISTANT_STT_INPUT_COST_PER_1K_TOKENS_USD,
        0.0003
      ),
      output_per_1k_tokens_usd: toFiniteNumber(
        process.env.ASSISTANT_STT_OUTPUT_COST_PER_1K_TOKENS_USD,
        0.0003
      ),
    };
  }
  return {
    input_per_1k_tokens_usd: toFiniteNumber(
      process.env.ASSISTANT_LLM_INPUT_COST_PER_1K_TOKENS_USD,
      0.00015
    ),
    output_per_1k_tokens_usd: toFiniteNumber(
      process.env.ASSISTANT_LLM_OUTPUT_COST_PER_1K_TOKENS_USD,
      0.0006
    ),
  };
}

function getDefaultTtsPricing() {
  return {
    per_1k_chars_usd: toFiniteNumber(process.env.ASSISTANT_TTS_COST_PER_1K_CHARS_USD, 0.015),
  };
}

function extractTokenUsage(rawUsage) {
  if (!isPlainObject(rawUsage)) return null;

  let inputTokens = Number.isFinite(Number(rawUsage.input_tokens))
    ? Number(rawUsage.input_tokens)
    : Number.isFinite(Number(rawUsage.prompt_tokens))
      ? Number(rawUsage.prompt_tokens)
      : null;

  let outputTokens = Number.isFinite(Number(rawUsage.output_tokens))
    ? Number(rawUsage.output_tokens)
    : Number.isFinite(Number(rawUsage.completion_tokens))
      ? Number(rawUsage.completion_tokens)
      : null;

  if (inputTokens == null && outputTokens == null && Number.isFinite(Number(rawUsage.total_tokens))) {
    inputTokens = Number(rawUsage.total_tokens);
    outputTokens = 0;
  }

  if (inputTokens == null && outputTokens == null) return null;

  const input = Math.max(0, Math.round(toFiniteNumber(inputTokens, 0)));
  const output = Math.max(0, Math.round(toFiniteNumber(outputTokens, 0)));

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}

function estimateTokenCost({ stage, model, usage }) {
  const normalizedUsage = extractTokenUsage(usage);
  const pricing = resolveModelPricing(model) || getDefaultTokenPricing(stage);
  const inputRate = toFiniteNumber(pricing && pricing.input_per_1k_tokens_usd, 0);
  const outputRate = toFiniteNumber(pricing && pricing.output_per_1k_tokens_usd, 0);

  if (!normalizedUsage) {
    return {
      estimated_cost_usd: 0,
      cost_source: 'fallback_missing_usage',
      usage: null,
      pricing: {
        input_per_1k_tokens_usd: inputRate,
        output_per_1k_tokens_usd: outputRate,
      },
    };
  }

  const cost =
    (normalizedUsage.input_tokens / 1000) * inputRate +
    (normalizedUsage.output_tokens / 1000) * outputRate;

  return {
    estimated_cost_usd: roundUsd(cost),
    cost_source: 'api_usage',
    usage: normalizedUsage,
    pricing: {
      input_per_1k_tokens_usd: inputRate,
      output_per_1k_tokens_usd: outputRate,
    },
  };
}

function estimateTtsCost(ttsMeta = {}) {
  const model = String(ttsMeta.model || '').trim();

  const rawEstimate = isPlainObject(ttsMeta.estimate) ? ttsMeta.estimate : {};
  const charsFromEstimate = toFiniteNumber(
    rawEstimate.input_characters || rawEstimate.characters || rawEstimate.char_count,
    NaN
  );
  const charsFromInput = String(ttsMeta.input_text || '').length;
  const inputCharacters = Number.isFinite(charsFromEstimate)
    ? Math.max(0, Math.round(charsFromEstimate))
    : Math.max(0, Math.round(charsFromInput));

  const pricing = resolveModelPricing(model) || getDefaultTtsPricing();
  const per1kChars = toFiniteNumber(pricing && pricing.per_1k_chars_usd, 0);

  const explicitCost = toFiniteNumber(rawEstimate.estimated_cost_usd, NaN);
  const estimatedCost = Number.isFinite(explicitCost)
    ? explicitCost
    : (inputCharacters / 1000) * per1kChars;

  return {
    model: model || null,
    input_characters: inputCharacters,
    estimated_cost_usd: roundUsd(estimatedCost),
    cost_source: rawEstimate.source ? String(rawEstimate.source) : 'fallback_chars',
    pricing: {
      per_1k_chars_usd: per1kChars,
    },
  };
}

function normalizeBalanceSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  return normalized === 'provider_api' ? 'provider_api' : 'manual';
}

async function ensureCostSettingsRow() {
  const existing = await get(
    `
      SELECT id, user_credit_balance, balance_source, created_at, updated_at
      FROM assistant_cost_settings
      WHERE id = 1
      LIMIT 1
    `
  );

  if (existing) {
    return {
      id: 1,
      user_credit_balance: roundUsd(toFiniteNumber(existing.user_credit_balance, 0)),
      balance_source: normalizeBalanceSource(existing.balance_source),
      created_at: existing.created_at || null,
      updated_at: existing.updated_at || null,
    };
  }

  const initialBalance = roundUsd(toFiniteNumber(process.env.ASSISTANT_INITIAL_CREDIT_USD, 0));
  const initialSource = normalizeBalanceSource(process.env.ASSISTANT_INITIAL_BALANCE_SOURCE || 'manual');

  await run(
    `
      INSERT INTO assistant_cost_settings
        (id, user_credit_balance, balance_source, created_at, updated_at)
      VALUES
        (1, ?, ?, datetime('now'), datetime('now'))
    `,
    [initialBalance, initialSource]
  );

  return {
    id: 1,
    user_credit_balance: initialBalance,
    balance_source: initialSource,
    created_at: null,
    updated_at: null,
  };
}

function getStageSourceList(stages = []) {
  return stages
    .map((stage) => (stage && stage.cost_source ? String(stage.cost_source) : ''))
    .filter(Boolean);
}

function composeCostSource(stages = []) {
  const sources = getStageSourceList(stages);
  if (!sources.length) return 'fallback';

  const hasApi = sources.some((source) => source.includes('api_usage'));
  const hasFallback = sources.some(
    (source) => source.includes('fallback') || source.includes('chars')
  );

  if (hasApi && hasFallback) return 'api_usage+fallback';
  if (hasApi) return 'api_usage';
  return 'fallback';
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || '').trim();
}

function sanitizeTurnId(turnId) {
  return String(turnId || '').trim();
}

async function getInteractionRowByTurn(turnId) {
  return get(
    `
      SELECT
        id,
        session_id,
        turn_id,
        stt_usage_json,
        llm_planning_usage_json,
        llm_answer_usage_json,
        tts_estimated_cost,
        interaction_total_estimated_usd,
        cost_source,
        cost_mode,
        user_credit_balance,
        balance_source,
        created_at,
        updated_at
      FROM assistant_cost_interactions
      WHERE turn_id = ?
      LIMIT 1
    `,
    [turnId]
  );
}

function buildSttStagePayload(sttData = {}) {
  const model = String(sttData.model || '').trim();
  const estimated = estimateTokenCost({
    stage: 'stt',
    model,
    usage: sttData.usage || null,
  });

  return {
    model: model || null,
    usage: isPlainObject(sttData.usage) ? sttData.usage : null,
    normalized_usage: estimated.usage,
    audio_meta: isPlainObject(sttData.audio_meta) ? sttData.audio_meta : {},
    estimated_cost_usd: estimated.estimated_cost_usd,
    cost_source: estimated.cost_source,
    pricing: estimated.pricing,
  };
}

function buildLlmStagePayload(stageName, stageData = {}) {
  const model = String(stageData.model || '').trim();
  const estimated = estimateTokenCost({
    stage: 'llm',
    model,
    usage: stageData.usage || null,
  });

  return {
    stage: stageName,
    model: model || null,
    usage: isPlainObject(stageData.usage) ? stageData.usage : null,
    normalized_usage: estimated.usage,
    estimated_cost_usd: estimated.estimated_cost_usd,
    cost_source: estimated.cost_source,
    pricing: estimated.pricing,
  };
}

async function recordSttUsage({ sessionId, turnId, stt }) {
  const sid = sanitizeSessionId(sessionId);
  const tid = sanitizeTurnId(turnId);
  if (!sid || !tid) return null;

  const stagePayload = buildSttStagePayload(stt || {});
  const stageJson = safeJsonStringify(stagePayload);

  await run(
    `
      INSERT INTO assistant_cost_interactions
        (
          session_id,
          turn_id,
          stt_usage_json,
          llm_planning_usage_json,
          llm_answer_usage_json,
          tts_estimated_cost,
          interaction_total_estimated_usd,
          cost_source,
          cost_mode,
          user_credit_balance,
          balance_source,
          created_at,
          updated_at
        )
      VALUES
        (?, ?, ?, NULL, NULL, 0, 0, 'api_usage+fallback', ?, NULL, 'manual', datetime('now'), datetime('now'))
      ON CONFLICT(turn_id) DO UPDATE SET
        session_id = excluded.session_id,
        stt_usage_json = excluded.stt_usage_json,
        updated_at = datetime('now')
    `,
    [sid, tid, stageJson, COST_MODE_ESTIMATED]
  );

  return stagePayload;
}

async function computeSessionTotalUsd(sessionId) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return 0;
  const row = await get(
    `
      SELECT COALESCE(SUM(interaction_total_estimated_usd), 0) AS total
      FROM assistant_cost_interactions
      WHERE session_id = ?
    `,
    [sid]
  );
  return roundUsd(toFiniteNumber(row && row.total, 0));
}

async function computeAllTimeTotalUsd() {
  const row = await get(
    `
      SELECT COALESCE(SUM(interaction_total_estimated_usd), 0) AS total
      FROM assistant_cost_interactions
    `
  );
  return roundUsd(toFiniteNumber(row && row.total, 0));
}

async function getLastInteractionSummaryRow(sessionId) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return null;

  return get(
    `
      SELECT
        turn_id,
        interaction_total_estimated_usd,
        cost_source,
        cost_mode,
        created_at
      FROM assistant_cost_interactions
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [sid]
  );
}

function buildCostResponse({
  interactionTotal,
  sessionTotal,
  allTimeTotal,
  settings,
  stages,
  costSource,
}) {
  return {
    currency: CURRENCY,
    interaction: {
      estimated_total: roundUsd(interactionTotal),
      is_estimated: true,
      source: costSource,
      breakdown: {
        stt: stages.stt || null,
        llm_planning: stages.llm_planning || null,
        llm_answer: stages.llm_answer || null,
        tts: stages.tts || null,
      },
    },
    session_total: roundUsd(sessionTotal),
    all_time_total: roundUsd(allTimeTotal),
    balance: {
      user_credit_balance: roundUsd(toFiniteNumber(settings.user_credit_balance, 0)),
      balance_source: normalizeBalanceSource(settings.balance_source),
    },
  };
}

async function finalizeInteractionCost({
  sessionId,
  turnId,
  llmPlanning = null,
  llmAnswer = null,
  tts = null,
}) {
  const sid = sanitizeSessionId(sessionId);
  const tid = sanitizeTurnId(turnId);
  if (!sid || !tid) {
    throw new Error('session_id e turn_id sao obrigatorios para consolidar custo.');
  }

  const settings = await ensureCostSettingsRow();
  const existing = await getInteractionRowByTurn(tid);

  const sttStage = safeJsonParse(existing && existing.stt_usage_json, null);
  const planningStage = buildLlmStagePayload('planning', llmPlanning || {});
  const answerStage = buildLlmStagePayload('answer', llmAnswer || {});
  const ttsStage = estimateTtsCost(tts || {});

  const stages = {
    stt: sttStage,
    llm_planning: planningStage,
    llm_answer: answerStage,
    tts: ttsStage,
  };

  const sttCost = roundUsd(toFiniteNumber(sttStage && sttStage.estimated_cost_usd, 0));
  const llmPlanningCost = roundUsd(toFiniteNumber(planningStage.estimated_cost_usd, 0));
  const llmAnswerCost = roundUsd(toFiniteNumber(answerStage.estimated_cost_usd, 0));
  const ttsCost = roundUsd(toFiniteNumber(ttsStage.estimated_cost_usd, 0));

  const interactionTotal = roundUsd(sttCost + llmPlanningCost + llmAnswerCost + ttsCost);
  const previousTotal = roundUsd(toFiniteNumber(existing && existing.interaction_total_estimated_usd, 0));
  const delta = roundUsd(interactionTotal - previousTotal);

  const nextBalance = roundUsd(toFiniteNumber(settings.user_credit_balance, 0) - delta);
  const balanceSource = normalizeBalanceSource(settings.balance_source);

  const costSource = composeCostSource([sttStage, planningStage, answerStage, ttsStage]);

  await run(
    `
      UPDATE assistant_cost_settings
      SET
        user_credit_balance = ?,
        updated_at = datetime('now')
      WHERE id = 1
    `,
    [nextBalance]
  );

  await run(
    `
      INSERT INTO assistant_cost_interactions
        (
          session_id,
          turn_id,
          stt_usage_json,
          llm_planning_usage_json,
          llm_answer_usage_json,
          tts_estimated_cost,
          interaction_total_estimated_usd,
          cost_source,
          cost_mode,
          user_credit_balance,
          balance_source,
          created_at,
          updated_at
        )
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(turn_id) DO UPDATE SET
        session_id = excluded.session_id,
        stt_usage_json = excluded.stt_usage_json,
        llm_planning_usage_json = excluded.llm_planning_usage_json,
        llm_answer_usage_json = excluded.llm_answer_usage_json,
        tts_estimated_cost = excluded.tts_estimated_cost,
        interaction_total_estimated_usd = excluded.interaction_total_estimated_usd,
        cost_source = excluded.cost_source,
        cost_mode = excluded.cost_mode,
        user_credit_balance = excluded.user_credit_balance,
        balance_source = excluded.balance_source,
        updated_at = datetime('now')
    `,
    [
      sid,
      tid,
      safeJsonStringify(sttStage),
      safeJsonStringify(planningStage),
      safeJsonStringify(answerStage),
      ttsCost,
      interactionTotal,
      costSource,
      COST_MODE_ESTIMATED,
      nextBalance,
      balanceSource,
    ]
  );

  const [sessionTotal, allTimeTotal] = await Promise.all([
    computeSessionTotalUsd(sid),
    computeAllTimeTotalUsd(),
  ]);

  return buildCostResponse({
    interactionTotal,
    sessionTotal,
    allTimeTotal,
    settings: {
      user_credit_balance: nextBalance,
      balance_source: balanceSource,
    },
    stages,
    costSource,
  });
}

async function getCostSettingsSnapshot() {
  const settings = await ensureCostSettingsRow();
  return {
    user_credit_balance: roundUsd(toFiniteNumber(settings.user_credit_balance, 0)),
    balance_source: normalizeBalanceSource(settings.balance_source),
    cost_mode_supported: [COST_MODE_ESTIMATED, COST_MODE_RECONCILED],
  };
}

async function setManualCreditBalance(userCreditBalance) {
  const normalized = roundUsd(toFiniteNumber(userCreditBalance, NaN));
  if (!Number.isFinite(normalized)) {
    throw new Error('user_credit_balance invalido.');
  }

  await ensureCostSettingsRow();
  await run(
    `
      UPDATE assistant_cost_settings
      SET
        user_credit_balance = ?,
        balance_source = 'manual',
        updated_at = datetime('now')
      WHERE id = 1
    `,
    [normalized]
  );

  return getCostSettingsSnapshot();
}

async function getCostOverview({ sessionId }) {
  const sid = sanitizeSessionId(sessionId);
  const settings = await ensureCostSettingsRow();

  const [lastInteraction, sessionTotal, allTimeTotal] = await Promise.all([
    getLastInteractionSummaryRow(sid),
    computeSessionTotalUsd(sid),
    computeAllTimeTotalUsd(),
  ]);

  const interactionTotal = roundUsd(
    toFiniteNumber(lastInteraction && lastInteraction.interaction_total_estimated_usd, 0)
  );
  const interactionSource = lastInteraction && lastInteraction.cost_source
    ? String(lastInteraction.cost_source)
    : 'fallback';

  return {
    currency: CURRENCY,
    interaction: {
      estimated_total: interactionTotal,
      is_estimated: true,
      source: interactionSource,
      turn_id: lastInteraction && lastInteraction.turn_id ? String(lastInteraction.turn_id) : null,
      created_at: lastInteraction && lastInteraction.created_at ? String(lastInteraction.created_at) : null,
    },
    session_total: roundUsd(sessionTotal),
    all_time_total: roundUsd(allTimeTotal),
    balance: {
      user_credit_balance: roundUsd(toFiniteNumber(settings.user_credit_balance, 0)),
      balance_source: normalizeBalanceSource(settings.balance_source),
    },
  };
}

module.exports = {
  CURRENCY,
  COST_MODE_ESTIMATED,
  COST_MODE_RECONCILED,
  recordSttUsage,
  finalizeInteractionCost,
  getCostOverview,
  getCostSettingsSnapshot,
  setManualCreditBalance,
};
