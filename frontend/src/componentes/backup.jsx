// frontend/src/componentes/backup.jsx
import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

const API_BASE = 'http://localhost:3001';

export default function Backup() {
  const [status, setStatus] = useState('');
  const [diagnostico, setDiagnostico] = useState(null);
  const [diagnosticoLoading, setDiagnosticoLoading] = useState(false);

  const [estadoBanco, setEstadoBanco] = useState(null);
  const [estadoLoading, setEstadoLoading] = useState(false);

  const [ultimoRestoreInfo, setUltimoRestoreInfo] = useState(null);

  const fileInputRef = useRef(null);
  const BACKUP_KEY = import.meta.env.VITE_BACKUP_KEY || '';

  const buildHeaders = () => {
    const headers = {};
    if (BACKUP_KEY) headers['x-backup-key'] = BACKUP_KEY;
    return headers;
  };

  const carregarDiagnostico = async () => {
    try {
      setDiagnosticoLoading(true);
      const resp = await axios.get(`${API_BASE}/health`, { headers: buildHeaders() });
      setDiagnostico(resp.data);
    } catch (err) {
      console.error('Erro ao consultar /health', err);
      setDiagnostico(null);
    } finally {
      setDiagnosticoLoading(false);
    }
  };

  const carregarEstadoBanco = async () => {
    try {
      setEstadoLoading(true);
      const resp = await axios.get(`${API_BASE}/backup/now`, { headers: buildHeaders() });
      setEstadoBanco(resp.data);
    } catch (err) {
      console.error('Erro ao consultar /backup/now', err);
      setEstadoBanco(null);
    } finally {
      setEstadoLoading(false);
    }
  };

  useEffect(() => {
    carregarDiagnostico();
    carregarEstadoBanco();
  }, []);

  const baixarLocal = async () => {
    try {
      setStatus('Gerando backup...');
      // servidor já faz WAL checkpoint antes da cópia
      const url = `${API_BASE}/backup/download`;
      const resp = await axios.get(url, { responseType: 'blob', headers: buildHeaders() });

      let filename = 'emprestimos-backup.db';
      const cd = resp.headers['content-disposition'];
      if (cd) {
        const match = cd.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }

      const blob = new Blob([resp.data]);
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setStatus('Download concluído.');
      notify.success('Backup baixado com sucesso.');
    } catch (err) {
      console.error(err);
      setStatus('Erro ao gerar download do backup.');
      notify.error('Erro ao gerar backup. Veja console.');
    }
  };

  const abrirSeletorArquivo = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const restaurarDoArquivo = async (file) => {
    if (!file) {
      notify.warn('Selecione um arquivo para restaurar.');
      return;
    }
    try {
      setStatus('Enviando arquivo de restauração...');
      const url = `${API_BASE}/backup/restore`;
      const form = new FormData();
      form.append('file', file);

      const resp = await axios.post(url, form, {
        headers: { ...buildHeaders() },
        timeout: 120_000,
      });

      setUltimoRestoreInfo(resp.data || null);

      setStatus('Restauração concluída. Reinicie o app para recarregar os dados.');
      notify.success(resp.data?.message || 'Banco restaurado no servidor.');
      notify.info('Feche e reabra o aplicativo para garantir que o backend recarregou o banco.');

      await carregarDiagnostico();
      await carregarEstadoBanco();
    } catch (err) {
      console.error(err);
      setStatus('Erro ao enviar restauração.');
      notify.error('Erro ao restaurar backup. Veja console do navegador e do servidor.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Ações */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={baixarLocal} style={{ padding: 8 }}>Salvar local</button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".db,.sqlite,.sqlite3"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) restaurarDoArquivo(f);
          }}
        />
        <button onClick={abrirSeletorArquivo} style={{ padding: 8 }}>Restaurar (upload)</button>

        <span style={{ marginLeft: 12 }}>{status}</span>
      </div>

      {/* Diagnóstico /health */}
      <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: 820 }}>
        <strong>Diagnóstico (/health)</strong>
        <div style={{ marginTop: 6 }}>
          dbPath: <code>{diagnostico?.dbPath || '...'}</code>
        </div>
        <div>
          backupsDir: <code>{diagnostico?.backupsDir || '...'}</code>
        </div>
        {diagnostico?.appDataDir ? (
          <div>
            appDataDir: <code>{diagnostico.appDataDir}</code>
          </div>
        ) : null}
        <button
          onClick={carregarDiagnostico}
          disabled={diagnosticoLoading}
          style={{ marginTop: 8, padding: 6 }}
        >
          {diagnosticoLoading ? 'Atualizando...' : 'Atualizar diagnóstico'}
        </button>
      </div>

      {/* Estado do banco /backup/now */}
      <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: 820 }}>
        <strong>Estado do banco (/backup/now)</strong>
        <div style={{ marginTop: 6 }}>
          dbPath: <code>{estadoBanco?.dbPath || '...'}</code>
        </div>
        <div>
          arquivo: {estadoBanco?.file
            ? <code>{`${estadoBanco.file.size} bytes • mtime ${estadoBanco.file.mtime}`}</code>
            : <code>...</code>}
        </div>
        <div style={{ marginTop: 6 }}>
          <em>Contagens</em> —{' '}
          {estadoBanco?.contagens
            ? `Clientes: ${estadoBanco.contagens.clientes} • Empréstimos: ${estadoBanco.contagens.emprestimos} • Parcelas: ${estadoBanco.contagens.parcelas} • Pagamentos: ${estadoBanco.contagens.pagamentos}`
            : '...'}
        </div>
        <button
          onClick={carregarEstadoBanco}
          disabled={estadoLoading}
          style={{ marginTop: 8, padding: 6 }}
        >
          {estadoLoading ? 'Atualizando...' : 'Atualizar estado'}
        </button>
      </div>

      {/* Resultado do último restore */}
      {ultimoRestoreInfo && (
        <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: 820 }}>
          <strong>Último restore</strong>
          <div style={{ marginTop: 6 }}>
            {ultimoRestoreInfo.message || '—'}
          </div>
          <div style={{ marginTop: 6 }}>
            dbPath: <code>{ultimoRestoreInfo.dbPath || '...'}</code>
          </div>
          {ultimoRestoreInfo.backupOfPreviousDb && (
            <div>backup anterior: <code>{ultimoRestoreInfo.backupOfPreviousDb}</code></div>
          )}
          <div style={{ marginTop: 6 }}>
            upload: {ultimoRestoreInfo.uploaded
              ? <code>{`${ultimoRestoreInfo.uploaded.path} • ${ultimoRestoreInfo.uploaded.size} bytes • sha1 ${ultimoRestoreInfo.uploaded.sha1}`}</code>
              : <code>...</code>}
          </div>
          <div>
            target: {ultimoRestoreInfo.target
              ? <code>{`${ultimoRestoreInfo.target.size} bytes • sha1 ${ultimoRestoreInfo.target.sha1}`}</code>
              : <code>...</code>}
          </div>
        </div>
      )}
    </div>
  );
}