import React, { useRef, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function Backup() {
  const [status, setStatus] = useState('');
  const fileInputRef = useRef(null);
  const BACKUP_KEY = import.meta.env.VITE_BACKUP_KEY || '';

  const buildHeaders = () => {
    const headers = {};
    if (BACKUP_KEY) headers['x-backup-key'] = BACKUP_KEY;
    return headers;
  };

  const baixarLocal = async () => {
    try {
      setStatus('Gerando backup...');
      const url = 'http://localhost:3001/backup/download';
      const resp = await axios.get(url, { responseType: 'blob', headers: buildHeaders() });

      let filename = 'meu-banco-backup.db';
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

      setStatus('Download concluido.');
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
      setStatus('Enviando arquivo de restauracao...');
      const url = 'http://localhost:3001/restore';
      const form = new FormData();
      form.append('file', file);

      const resp = await axios.post(url, form, {
        headers: { ...buildHeaders() },
        timeout: 120_000,
      });

      setStatus('Restauracao enviada.');
      notify.success(
        'Restauracao concluida no servidor. ' + (resp.data.message || 'Reinicie o servidor se necessario.')
      );
    } catch (err) {
      console.error(err);
      setStatus('Erro ao enviar restauracao.');
      notify.error('Erro ao restaurar backup. Veja console do navegador e do servidor.');
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button onClick={baixarLocal} style={{ padding: 8 }}>
        Salvar local
      </button>

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
      <button onClick={abrirSeletorArquivo} style={{ padding: 8 }}>
        Restaurar (upload)
      </button>

      <span style={{ marginLeft: 12 }}>{status}</span>
    </div>
  );
}