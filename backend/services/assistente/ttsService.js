function getOpenAIConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
  const model = String(process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts').trim();
  const voice = String(process.env.OPENAI_TTS_VOICE || 'alloy').trim();
  return { apiKey, baseUrl, model, voice };
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundUsd(value) {
  return Math.round(toFiniteNumber(value, 0) * 1e8) / 1e8;
}

function buildTtsEstimate(inputText, model) {
  const inputCharacters = Math.max(0, String(inputText || '').length);
  const usdPer1kChars = toFiniteNumber(process.env.ASSISTANT_TTS_COST_PER_1K_CHARS_USD, 0.015);
  const estimatedCostUsd = (inputCharacters / 1000) * usdPer1kChars;

  return {
    model: model || null,
    input_characters: inputCharacters,
    usd_per_1k_chars: usdPer1kChars,
    estimated_cost_usd: roundUsd(estimatedCostUsd),
    source: 'fallback_chars',
  };
}

async function synthesizeSpeech(text, options = {}) {
  const startedAt = Date.now();
  const input = String(text || '').trim();
  if (!input) {
    throw new Error('Texto vazio para TTS.');
  }

  const { apiKey, baseUrl, model, voice: defaultVoice } = getOpenAIConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada no backend.');
  }

  const voice = String(options.voice || defaultVoice || 'alloy').trim();
  const boundedInput = input.slice(0, 3500);
  const payload = {
    model,
    voice,
    input: boundedInput,
    format: 'mp3',
  };

  const providerStartedAt = Date.now();
  const resp = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const providerMs = Date.now() - providerStartedAt;

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(
      `Falha no TTS (${resp.status}). ${errText || 'Resposta sem detalhes do provedor.'}`
    );
  }

  const ab = await resp.arrayBuffer();
  const audioBuffer = Buffer.from(ab);
  if (!audioBuffer.length) {
    throw new Error('TTS retornou audio vazio.');
  }

  return {
    mime: 'audio/mpeg',
    base64: audioBuffer.toString('base64'),
    model,
    voice,
    estimate: buildTtsEstimate(boundedInput, model),
    telemetry: {
      provider_ms: providerMs,
      total_ms: Date.now() - startedAt,
    },
  };
}

module.exports = {
  synthesizeSpeech,
};
