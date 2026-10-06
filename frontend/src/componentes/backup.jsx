// frontend/src/componentes/backup.jsx
import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';
import { API_BASE_URL } from '../axios-setup.js';

const API_BASE = API_BASE_URL;

export default function Backup() {
  const [status, setStatus] = useState('');
  const [diagnostico, setDiagnostico] = useState(null);
  const [diagnosticoLoading, setDiagnosticoLoading] = useState(false);

  const [estadoBanco, setEstadoBanco] = useState(null);
  const [estadoLoading, setEstadoLoading] = useState(false);

  const [ultimoRestoreInfo, setUltimoRestoreInfo] = useState(null);
  const [exportandoCelular, setExportandoCelular] = useState(false);
  const [ultimoExportCelular, setUltimoExportCelular] = useState(null);

  const fileInputRef = useRef(null);
  const BACKUP_KEY = import.meta.env.VITE_BACKUP_KEY || '';

  const buildHeaders = () => {
    const headers = {};
    if (BACKUP_KEY) headers['x-backup-key'] = BACKUP_KEY;
    return headers;
  };

  const mensagemErro = async (err, fallback) => {
    let data = err?.response?.data;
    if (data instanceof Blob) {
      try {
        data = JSON.parse(await data.text());
      } catch {
        data = null;
      }
    }
    return data?.error || err?.message || fallback;
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

      let filename = 'emprestimos-backup.emprestimos-backup';
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
      const totalFotos = Number(resp.headers['x-backup-photo-count'] || 0);
      notify.success(`Backup completo baixado com ${totalFotos} foto(s).`);
    } catch (err) {
      console.error(err);
      setStatus('Erro ao gerar download do backup.');
      notify.error(await mensagemErro(err, 'Erro ao gerar o backup completo.'));
    }
  };

  const exportarParaCelular = async () => {
    try {
      setExportandoCelular(true);
      setStatus('Criando cópia segura e convertendo os dados para o celular...');
      const resp = await axios.get(`${API_BASE}/backup/mobile-export`, {
        responseType: 'blob',
        headers: buildHeaders(),
        timeout: 300_000,
      });
      let filename = 'emprestimos-para-celular.sistema-backup';
      const cd = resp.headers['content-disposition'];
      if (cd) {
        const match = cd.match(/filename="?([^";]+)"?/);
        if (match) filename = match[1];
      }
      let contagens = {};
      try {
        const encoded = resp.headers['x-mobile-backup-counts'];
        if (encoded) contagens = JSON.parse(window.atob(encoded));
      } catch {
        // O arquivo já foi validado no backend; o resumo é apenas informativo.
      }
      const fotos = Number(resp.headers['x-mobile-backup-photo-count'] || 0);
      const avisos = Number(resp.headers['x-mobile-backup-warning-count'] || 0);
      const bytes = new Uint8Array(await resp.data.arrayBuffer());
      let salvo = true;

      if (window.mobileBackup?.save) {
        setStatus('Escolha onde salvar o arquivo para o celular...');
        const result = await window.mobileBackup.save({ filename, bytes });
        if (!result?.ok) throw new Error(result?.error || 'Não foi possível salvar o arquivo.');
        if (result.cancelled) {
          salvo = false;
          setStatus('Exportação cancelada antes de salvar o arquivo.');
        }
      } else {
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      if (!salvo) return;
      setUltimoExportCelular({ contagens, fotos, avisos, filename });
      setStatus('Arquivo para celular criado e validado.');
      notify.success('Dados convertidos e validados para o aplicativo Android.');
      notify.info('Envie este arquivo para a pasta Downloads do celular. No aplicativo Android, vá em Configurações → Backup → Restaurar backup.');
    } catch (err) {
      console.error('Erro ao exportar dados para celular', err);
      setStatus('Não foi possível exportar os dados para o celular.');
      notify.error(await mensagemErro(err, 'Erro ao converter os dados para o celular.'));
    } finally {
      setExportandoCelular(false);
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
      notify.success(resp.data?.message || 'Backup restaurado no sistema.');
      notify.info('Feche e reabra o aplicativo para garantir que o backend recarregou o banco.');

      await carregarDiagnostico();
      await carregarEstadoBanco();
    } catch (err) {
      console.error(err);
      setStatus('Erro ao enviar restauração.');
      notify.error(await mensagemErro(err, 'Erro ao restaurar o backup.'));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Ações */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={baixarLocal} style={{ padding: 8 }}>Salvar backup completo</button>

        <button
          onClick={exportarParaCelular}
          disabled={exportandoCelular}
          style={{ padding: 8 }}
        >
          {exportandoCelular ? 'Exportando para celular...' : 'Exportar dados para celular'}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".emprestimos-backup,.db,.sqlite,.sqlite3,application/octet-stream"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) restaurarDoArquivo(f);
          }}
        />
        <button onClick={abrirSeletorArquivo} style={{ padding: 8 }}>Restaurar backup</button>

        <span style={{ marginLeft: 12 }}>{status}</span>
      </div>

      {ultimoExportCelular && (
        <div style={{ padding: 12, border: '1px solid #4caf50', borderRadius: 4, maxWidth: '100%' }}>
          <strong>Exportação para celular concluída</strong>
          <div style={{ marginTop: 6 }}>arquivo: <code>{ultimoExportCelular.filename}</code></div>
          <div style={{ marginTop: 6 }}>
            Clientes: {ultimoExportCelular.contagens.clientes ?? 0} • Empréstimos: {ultimoExportCelular.contagens.emprestimos ?? 0} • Parcelas: {ultimoExportCelular.contagens.parcelas ?? 0} • Pagamentos: {ultimoExportCelular.contagens.pagamentos ?? 0} • Histórico: {ultimoExportCelular.contagens.local_auditoria ?? 0} • Caixa: {ultimoExportCelular.contagens.caixa_movimentos ?? 0} • Fotos: {ultimoExportCelular.fotos}
          </div>
          {ultimoExportCelular.avisos > 0 && (
            <div style={{ marginTop: 6 }}>Há {ultimoExportCelular.avisos} aviso(s) registrado(s) no pacote.</div>
          )}
          <div style={{ marginTop: 8 }}>
            Envie este arquivo para a pasta Downloads do celular. No aplicativo Android, vá em Configurações → Backup → Restaurar backup.
          </div>
        </div>
      )}

      {/* Diagnóstico /health */}
      <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: '100%' }}>
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
      <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: '100%' }}>
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
            ? `Clientes: ${estadoBanco.contagens.clientes} • Empréstimos: ${estadoBanco.contagens.emprestimos} • Parcelas: ${estadoBanco.contagens.parcelas} • Pagamentos: ${estadoBanco.contagens.pagamentos} • Fotos: ${estadoBanco.contagens.fotos ?? 0}`
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
        <div style={{ padding: 12, border: '1px solid #ccc', borderRadius: 4, maxWidth: '100%' }}>
          <strong>Último restore</strong>
          <div style={{ marginTop: 6 }}>
            {ultimoRestoreInfo.message || '—'}
          </div>
          <div style={{ marginTop: 6 }}>
            dbPath: <code>{ultimoRestoreInfo.dbPath || '...'}</code>
          </div>
          {ultimoRestoreInfo.backupOfPreviousState && (
            <div>backup anterior: <code>{ultimoRestoreInfo.backupOfPreviousState}</code></div>
          )}
          <div>fotos restauradas: <strong>{Number(ultimoRestoreInfo.photosRestored || 0)}</strong></div>
          <div style={{ marginTop: 6 }}>
            upload: {ultimoRestoreInfo.uploaded
              ? <code>{`${ultimoRestoreInfo.uploaded.name} • ${ultimoRestoreInfo.uploaded.size} bytes • sha256 ${ultimoRestoreInfo.uploaded.sha256}`}</code>
              : <code>...</code>}
          </div>
          <div>
            target: {ultimoRestoreInfo.target
              ? <code>{`${ultimoRestoreInfo.target.size} bytes • sha256 ${ultimoRestoreInfo.target.sha256}`}</code>
              : <code>...</code>}
          </div>
        </div>
      )}
    </div>
  );
}
