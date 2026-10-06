import React, { useCallback, useEffect, useMemo, useState } from 'react';
import notify from '../ui/notify';
import { partitionReleaseCatalog, releaseNoteItems } from './atualizacoesData';

const STATUS_LABELS = {
  idle: 'Aguardando verificação',
  checking: 'Verificando atualizações',
  available: 'Atualização disponível',
  downloading: 'Baixando atualização',
  downloaded: 'Atualização pronta para instalar',
  backup: 'Preparando backup de segurança',
  none: 'Você já está usando a versão mais recente',
  error: 'Não foi possível concluir a atualização',
};

function developmentPreviewStatus() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const search = window.location.hash.split('?')[1] || '';
  if (new URLSearchParams(search).get('updatePreview') !== '1') return null;
  return {
    stage: 'available',
    info: {
      version: '0.6.20',
      releaseNotes: [
        'Melhorias no backup e restauração.',
        'Exportação de dados para celular aprimorada.',
        'Mensagens mais claras durante atualizações.',
        'Ajustes de estabilidade e segurança.',
      ].map((item) => `- ${item}`).join('\n'),
    },
  };
}

export default function Atualizacoes() {
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [lastInfo, setLastInfo] = useState(null);
  const [lastBackup, setLastBackup] = useState(null);
  const [releaseHistory, setReleaseHistory] = useState([]);
  const [installedRelease, setInstalledRelease] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isChecking, setIsChecking] = useState(false);

  const applyStatus = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return;
    setStage(payload.stage || 'idle');
    if (payload.progress != null) setProgress(Number(payload.progress) || 0);
    if (payload.info) setLastInfo(payload.info);
    if (payload.stage === 'backup') setLastBackup(payload.result || null);
    if (typeof payload.message === 'string') setStatusMessage(payload.message);
    if (payload.stage && payload.stage !== 'error' && payload.message == null) setStatusMessage('');
  }, []);

  useEffect(() => {
    let alive = true;
    window.appInfo?.version?.().then((value) => {
      if (alive) setVersion(value);
    }).catch(() => {});

    const preview = developmentPreviewStatus();
    if (preview) {
      applyStatus(preview);
      return () => { alive = false; };
    }

    window.updates?.getStatus?.().then((status) => {
      if (alive) applyStatus(status);
    }).catch(() => {});

    window.updates?.history?.().then((result) => {
      if (alive && Array.isArray(result?.releases)) setReleaseHistory(result.releases);
    }).catch(() => {});

    window.updates?.currentRelease?.().then((result) => {
      if (alive && result?.release) setInstalledRelease(result.release);
    }).catch(() => {});

    const off = window.updates?.onStatus?.((payload) => {
      if (alive) applyStatus(payload);
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
      const result = await window.updates?.check?.();
      if (!result?.ok) {
        notify.error(result?.error || 'Não foi possível verificar atualizações.');
        return;
      }
      applyStatus(result.status || await window.updates?.getStatus?.());
    } catch {
      notify.error('Não foi possível verificar atualizações.');
    } finally {
      setIsChecking(false);
    }
  }

  async function baixar() {
    const result = await window.updates?.download?.();
    if (!result?.ok) notify.error(result?.error || 'Não foi possível baixar a atualização.');
  }

  async function aplicar() {
    const go = await notify.confirm('Aplicar atualização agora? O aplicativo será reiniciado.');
    if (!go) return;
    const result = await window.updates?.apply?.();
    if (!result?.ok) notify.error(result?.error || 'Não foi possível aplicar a atualização.');
  }

  const checkingNow = isChecking || stage === 'checking';
  const hasAvailableUpdate = ['available', 'downloading', 'downloaded', 'backup'].includes(stage) && lastInfo?.version;
  const { currentRelease, historyReleases } = useMemo(() => partitionReleaseCatalog({
    installedRelease,
    availableRelease: hasAvailableUpdate ? lastInfo : null,
    releaseHistory,
  }), [hasAvailableUpdate, installedRelease, lastInfo, releaseHistory]);

  return (
    <div style={{ padding: 16, color: 'var(--text-main)', maxWidth: 780 }}>
      <h2>Atualizações</h2>

      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        <div>Versão instalada: <b>{version || 'desconhecida'}</b></div>
        {hasAvailableUpdate ? <div>Versão disponível: <b>{lastInfo.version}</b></div> : null}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button onClick={verificar} disabled={checkingNow} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--bg-card)', color: 'var(--text-main)', cursor: checkingNow ? 'wait' : 'pointer', opacity: checkingNow ? 0.75 : 1 }}>
          {checkingNow ? 'Verificando...' : 'Verificar atualização'}
        </button>
        {stage === 'available' ? (
          <button onClick={baixar} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #0f766e', background: '#14b8a6', color: '#042f2e', cursor: 'pointer' }}>
            Baixar atualização
          </button>
        ) : null}
        {stage === 'downloaded' ? (
          <button onClick={aplicar} style={{ background: '#f59e0b', border: '1px solid #d97706', padding: '6px 12px', borderRadius: 8, color: '#0f172a', cursor: 'pointer' }}>
            Aplicar e reiniciar
          </button>
        ) : null}
      </div>

      <section style={{ padding: 14, border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--bg-card)' }}>
        <div><b>Status:</b> {STATUS_LABELS[stage] || 'Aguardando atualização'}</div>
        {statusMessage ? <div style={{ marginTop: 8, color: '#fda4af' }}>{statusMessage}</div> : null}

        {stage === 'downloading' ? (
          <div style={{ marginTop: 12 }}>
            <div>Baixando: {progress.toFixed(1)}%</div>
            <div style={{ height: 8, background: 'var(--bg-body)', borderRadius: 4, overflow: 'hidden', marginTop: 6 }}>
              <div style={{ width: `${progress}%`, height: '100%', background: '#10b981' }} />
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
          <section>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', color: 'var(--text-soft)' }}>NOVO / VERSÃO ATUAL</div>
            {currentRelease ? (
              <div style={{ marginTop: 6 }}>
                <b>Versão {currentRelease.version}</b>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {releaseNoteItems(currentRelease.releaseNotes).map((note, index) => <li key={`${currentRelease.version}-${index}-${note}`}>{note}</li>)}
                </ul>
              </div>
            ) : hasAvailableUpdate ? (
              <div style={{ marginTop: 6, color: 'var(--text-soft)' }}>As notas da versão {lastInfo.version} ainda não estão disponíveis.</div>
            ) : (
              <div style={{ marginTop: 6, color: 'var(--text-soft)' }}>As notas da versão instalada ainda não estão disponíveis neste aplicativo.</div>
            )}
          </section>

          <section>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', color: 'var(--text-soft)' }}>HISTÓRICO DE ATUALIZAÇÕES</div>
            {historyReleases.length ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {historyReleases.map((release) => (
                  <details key={release.version} style={{ padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Versão {release.version}</summary>
                    <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                      {releaseNoteItems(release.releaseNotes).map((note, index) => <li key={`${release.version}-${index}-${note}`}>{note}</li>)}
                    </ul>
                  </details>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 6, color: 'var(--text-soft)' }}>Nenhuma versão anterior com notas recuperáveis.</div>
            )}
          </section>
        </div>

        {lastBackup ? <div style={{ marginTop: 12 }}><b>Backup de segurança:</b> {lastBackup.success ? 'concluído.' : 'não foi concluído.'}</div> : null}
      </section>
    </div>
  );
}
