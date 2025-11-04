import React, { useEffect, useState } from 'react';
import notify from '../ui/notify';

export default function Atualizacoes() {
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [lastInfo, setLastInfo] = useState(null);
  const [lastBackup, setLastBackup] = useState(null);

  useEffect(() => {
    window.appInfo?.version?.().then(setVersion).catch(() => {});
    const off = window.updates?.onStatus?.((p) => {
      setStage(p.stage || 'idle');
      if (p.progress != null) setProgress(p.progress);
      if (p.info) setLastInfo(p.info);
      if (p.stage === 'backup') setLastBackup(p.result || null);
    });
    return () => off && off();
  }, []);

  async function verificar() {
    setStage('checking');
    const r = await window.updates?.check?.();
    if (!r?.ok) {
      notify.error(`Falha ao verificar: ${r?.error || 'erro'}`);
      setStage('idle');
    }
  }

  async function aplicar() {
    const go = await notify.confirm('Aplicar atualização agora? O app será reiniciado.');
    if (!go) return;
    await window.updates?.apply?.();
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>Atualizações</h2>
      <div style={{ marginBottom: 8 }}>
        Versão atual: <b>{version || 'desconhecida'}</b>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={verificar}>Verificar atualização</button>
        {stage === 'downloaded' && (
          <button
            onClick={aplicar}
            style={{
              background: '#f59e0b',
              border: '1px solid #d97706',
              padding: '6px 12px',
              borderRadius: 8,
            }}
          >
            Aplicar e Reiniciar
          </button>
        )}
      </div>

      <div
        style={{
          padding: 12,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
        }}
      >
        <div>
          <b>Status:</b> {stage}
        </div>

        {stage === 'downloading' && (
          <div style={{ marginTop: 8 }}>
            <div>Baixando: {progress.toFixed(1)}%</div>
            <div
              style={{
                height: 8,
                background: '#e5e7eb',
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
              background: '#f9fafb',
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