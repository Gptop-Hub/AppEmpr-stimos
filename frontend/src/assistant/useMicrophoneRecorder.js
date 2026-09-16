import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function mapMediaError(err) {
  const code = String((err && err.name) || '').toLowerCase();
  if (code === 'notallowederror' || code === 'permissiondeniederror') {
    return 'Permissao de microfone negada. Habilite o acesso para continuar.';
  }
  if (code === 'notfounderror') {
    return 'Nenhum microfone foi encontrado neste dispositivo.';
  }
  if (code === 'notreadableerror') {
    return 'Nao foi possivel acessar o microfone agora. Tente novamente.';
  }
  return err && err.message
    ? String(err.message)
    : 'Falha ao capturar audio do microfone.';
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const candidate of candidates) {
    try {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

function normalizeLevel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export default function useMicrophoneRecorder() {
  const [isListening, setIsListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState('');

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const stopResolverRef = useRef(null);
  const stopRejecterRef = useRef(null);
  const startedAtRef = useRef(null);
  const rafRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const meterArrayRef = useRef(null);

  const isSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return Boolean(
      navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder
    );
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }
    meterArrayRef.current = null;
    setAudioLevel(0);
  }, []);

  const stopTracks = useCallback(() => {
    if (!streamRef.current) return;
    try {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
    } catch {}
    streamRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    stopMeter();
    stopTracks();
    recorderRef.current = null;
    chunksRef.current = [];
    startedAtRef.current = null;
    setIsListening(false);
  }, [stopMeter, stopTracks]);

  const startMeter = useCallback((stream) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      audioContextRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
      meterArrayRef.current = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (!analyserRef.current || !meterArrayRef.current) {
          setAudioLevel(0);
          return;
        }
        analyserRef.current.getByteTimeDomainData(meterArrayRef.current);
        let sum = 0;
        for (let i = 0; i < meterArrayRef.current.length; i += 1) {
          const centered = (meterArrayRef.current[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / meterArrayRef.current.length);
        setAudioLevel(normalizeLevel(rms * 2.5));
        rafRef.current = requestAnimationFrame(tick);
      };

      tick();
    } catch {}
  }, []);

  const requestMainProcessPermission = useCallback(async () => {
    try {
      if (
        window.assistantVoice &&
        typeof window.assistantVoice.requestMicrophoneAccess === 'function'
      ) {
        const result = await window.assistantVoice.requestMicrophoneAccess();
        if (result && result.ok === false) {
          throw new Error(result.error || 'Permissao de microfone negada pelo sistema.');
        }
      }
    } catch (err) {
      throw err;
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError('');

    if (!isSupported) {
      setError('Este ambiente nao suporta captura de audio por microfone.');
      return false;
    }

    try {
      await requestMainProcessPermission();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (!event || !event.data || event.data.size <= 0) return;
        chunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        const msg = mapMediaError(event && event.error ? event.error : event);
        setError(msg);
      };

      recorderRef.current = recorder;
      startMeter(stream);
      recorder.start(250);
      startedAtRef.current = Date.now();
      setIsListening(true);
      return true;
    } catch (err) {
      setError(mapMediaError(err));
      cleanup();
      return false;
    }
  }, [cleanup, isSupported, requestMainProcessPermission, startMeter]);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) {
      throw new Error('Nenhuma gravacao em andamento.');
    }

    const recorder = recorderRef.current;
    if (recorder.state === 'inactive') {
      throw new Error('Gravacao ja foi finalizada.');
    }

    setIsListening(false);
    stopMeter();

    return new Promise((resolve, reject) => {
      stopResolverRef.current = resolve;
      stopRejecterRef.current = reject;

      recorder.onstop = () => {
        try {
          const mimeType = recorder.mimeType || 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: mimeType });
          const startedAt = startedAtRef.current || Date.now();
          const durationMs = Math.max(0, Date.now() - startedAt);
          chunksRef.current = [];
          stopTracks();
          recorderRef.current = null;
          startedAtRef.current = null;
          stopResolverRef.current = null;
          stopRejecterRef.current = null;
          resolve({
            audioBlob: blob,
            durationMs,
            mimeType,
          });
        } catch (err) {
          stopTracks();
          recorderRef.current = null;
          startedAtRef.current = null;
          stopResolverRef.current = null;
          stopRejecterRef.current = null;
          reject(err);
        }
      };

      try {
        recorder.stop();
      } catch (err) {
        stopTracks();
        recorderRef.current = null;
        startedAtRef.current = null;
        stopResolverRef.current = null;
        stopRejecterRef.current = null;
        reject(err);
      }
    });
  }, [stopMeter, stopTracks]);

  useEffect(() => {
    return () => {
      cleanup();
      if (stopRejecterRef.current) {
        try {
          stopRejecterRef.current(new Error('Captura de audio interrompida.'));
        } catch {}
      }
      stopResolverRef.current = null;
      stopRejecterRef.current = null;
    };
  }, [cleanup]);

  const clearError = useCallback(() => setError(''), []);

  return {
    isSupported,
    isListening,
    audioLevel,
    error,
    startRecording,
    stopRecording,
    clearError,
  };
}

