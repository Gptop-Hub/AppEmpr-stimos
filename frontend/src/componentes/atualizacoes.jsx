import React, { useCallback, useEffect, useState } from 'react';
import notify from '../ui/notify';

export default function Atualizacoes() {
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [lastInfo, setLastInfo] = useState(null);
  const [lastBackup, setLastBackup] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isChecking, setIsChecking] = useState(false);

  const applyStatus = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return;
    setStage(payload.stage || 'idle');
    if (payload.progress != null) setProgress(payload.progress);
    if (payload.info) setLastInfo(payload.info);
    if (payload.stage === 'backup') setLastBackup(payload.result || null);
    if (typeof payload.message === 'string') setStatusMessage(payload.message);
    if (payload.stage && payload.stage !== 'error' && payload.message == null) {
      setStatusMessage('');
    }
  }, []);

  useEffect(() => {
    let alive = true;

    window.appInfo?.version?.().then((v) => {
      if (alive) setVersion(v);
    }).catch(() => {});

    window.updates?.getStatus?.().then((status) => {
      if (alive) applyStatus(status);
    }).catch(() => {});

    const off = window.updates?.onStatus?.((payload) => {
      if (!alive) return;
      applyStatus(payload);
    });

    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, [applyStatus]);

  async function verificar() {
    if (isChecking || stage === 'checking') return;

    setIsChecking(true);
    try {
      const r = await window.updates?.check?.();
      if (!r?.ok) {
        notify.error(`Falha ao verificar: ${r?.error || 'erro'}`);
        return;
      }

      if (r.status) {
        applyStatus(r.status);
      } else {
        const status = await window.updates?.getStatus?.();
        applyStatus(status);
      }
    } catch {
      notify.error('Falha ao verificar atualizacao.');
    } finally {
      setIsChecking(false);
    }
  }

  async function aplicar() {
    const go = await notify.confirm('Aplicar atualizacao agora? O app sera reiniciado.');
    if (!go) return;
    await window.updates?.apply?.();
  }

  const checkingNow = isChecking || stage === 'checking';

  return (
    <div style={{ padding: 16, color: 'var(--text-main)' }}>
      <h2>Atualizacoes</h2>
      <div style={{ marginBottom: 8 }}>
        Versao atual: <b>{version || 'desconhecida'}</b>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          onClick={verificar}
          disabled={checkingNow}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid var(--border-soft)',
            background: 'var(--bg-card)',
            color: 'var(--text-main)',
            cursor: checkingNow ? 'wait' : 'pointer',
            opacity: checkingNow ? 0.75 : 1,
          }}
        >
          {checkingNow ? 'Verificando...' : 'Verificar atualizacao'}
        </button>
        {stage === 'downloaded' && (
          <button
            onClick={aplicar}
            style={{
              background: '#f59e0b',
              border: '1px solid #d97706',
              padding: '6px 12px',
              borderRadius: 8,
              color: '#0f172a',
              cursor: 'pointer',
            }}
          >
            Aplicar e Reiniciar
          </button>
        )}
      </div>

      <div
        style={{
          padding: 12,
          border: '1px solid var(--border-soft)',
          borderRadius: 8,
          background: 'var(--bg-card)',
        }}
      >
        <div>
          <b>Status:</b> {stage}
        </div>

        {statusMessage ? (
          <div style={{ marginTop: 8, color: '#fda4af' }}>{statusMessage}</div>
        ) : null}

        {stage === 'downloading' && (
          <div style={{ marginTop: 8 }}>
            <div>Baixando: {progress.toFixed(1)}%</div>
            <div
              style={{
                height: 8,
                background: 'var(--bg-body)',
                borderRadius: 4,
                overflow: 'hidden',
                marginTop: 6,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: '#10b981',
                }}
              />
            </div>
          </div>
        )}

        {lastInfo && (
          <pre
            style={{
              marginTop: 10,
              background: 'var(--bg-body)',
              color: 'var(--text-main)',
              border: '1px solid var(--border-soft)',
              padding: 8,
              borderRadius: 6,
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(lastInfo, null, 2)}
          </pre>
        )}

        {lastBackup && (
          <div style={{ marginTop: 10 }}>
            <b>Backup:</b>{' '}
            {lastBackup.success ? `OK (${lastBackup.path})` : 'Falhou'}
          </div>
        )}
      </div>
    </div>
  );
}
