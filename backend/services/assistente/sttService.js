function getOpenAIConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim();
  const model = String(process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe').trim();
  return { apiKey, baseUrl, model };
}

function guessFilenameByMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('ogg')) return 'audio.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio.mp3';
  if (mime.includes('wav')) return 'audio.wav';
  if (mime.includes('mp4')) return 'audio.mp4';
  return 'audio.webm';
}

function toPositiveIntegerOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i > 0 ? i : null;
}

async function transcribeAudio({
  audioBuffer,
  mimeType = 'audio/webm',
  language = 'pt',
  filename = '',
  durationMs = null,
} = {}) {
  const startedAt = Date.now();
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('Audio invalido para transcricao.');
  }

  const { apiKey, baseUrl, model } = getOpenAIConfig();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada no backend.');
  }

  const form = new FormData();
  const finalFilename = filename && String(filename).trim()
    ? String(filename).trim()
    : guessFilenameByMime(mimeType);
  const blob = new Blob([audioBuffer], { type: mimeType || 'audio/webm' });
  form.append('file', blob, finalFilename);
  form.append('model', model);
  form.append('language', String(language || 'pt').slice(0, 8));

  const providerStartedAt = Date.now();
  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  const providerMs = Date.now() - providerStartedAt;

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(
      `Falha no STT (${resp.status}). ${errText || 'Resposta sem detalhes do provedor.'}`
    );
  }

  const data = await resp.json();
  const transcript = data && typeof data.text === 'string' ? data.text.trim() : '';
  if (!transcript) {
    throw new Error('Transcricao vazia retornada pelo provedor de STT.');
  }

  const usage = data && data.usage && typeof data.usage === 'object' ? data.usage : null;
  const audioMeta = {
    bytes: audioBuffer.length,
    duration_ms: toPositiveIntegerOrNull(durationMs),
    mime_type: mimeType || 'audio/webm',
    filename: finalFilename,
  };

  return {
    transcript,
    model,
    usage,
    audio_meta: audioMeta,
    telemetry: {
      provider_ms: providerMs,
      total_ms: Date.now() - startedAt,
    },
  };
}

module.exports = {
  transcribeAudio,
};
