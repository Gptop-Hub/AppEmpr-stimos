import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import notify from '../../ui/notify';
import { formatarData } from './helpers.jsx';
import { montarPreviaReagendamento } from './reagendamentoPreview.js';

export default function ReagendarVencimentoModal({ parcela, parcelas, onClose, onConcluido }) {
  const parcelaId = parcela?.id || parcela?.parcela_id;
  const vencimentoInicial = String(parcela?.vencimento || '').slice(0, 10);
  const [modo, setModo] = useState('date');
  const [alcance, setAlcance] = useState('single');
  const [novaDataISO, setNovaDataISO] = useState(vencimentoInicial);
  const [novoDia, setNovoDia] = useState(() => Number(vencimentoInicial.slice(8, 10)) || 1);
  const [salvando, setSalvando] = useState(false);
  const [erroServidor, setErroServidor] = useState('');

  const tipo = modo === 'day' ? 'change_day' : alcance;
  const previa = useMemo(() => montarPreviaReagendamento({
    parcelas,
    parcelaId,
    tipo,
    novaDataISO,
    novoDia,
  }), [parcelas, parcelaId, tipo, novaDataISO, novoDia]);
  const podeConfirmar = !salvando && !previa.erro && previa.linhas.some((linha) => linha.alterada);

  const confirmar = async () => {
    if (!podeConfirmar) return;
    setSalvando(true);
    setErroServidor('');
    try {
      await axios.post('/parcelas/reagendar-confirmado', {
        parcelaId: Number(parcelaId),
        tipo,
        novaDataISO: modo === 'date' ? novaDataISO : undefined,
        novoDia: modo === 'day' ? Number(novoDia) : undefined,
      });
      notify.success('Vencimentos atualizados.');
      await onConcluido?.();
      onClose?.();
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Não foi possível atualizar os vencimentos.';
      setErroServidor(message);
    } finally {
      setSalvando(false);
    }
  };

  if (!parcela) return null;
  return createPortal(
    <div
      data-modal-reagendar-vencimento="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !salvando) onClose?.(); }}
      style={styles.overlay}
    >
      <section role="dialog" aria-modal="true" aria-label="Alterar vencimento" style={styles.modal}>
        <header style={styles.header}>
          <div>
            <h2 style={styles.title}>Alterar vencimento</h2>
            <div style={styles.subtitle}>Parcela {parcela.numero} — vencimento atual: {formatarData(parcela.vencimento)}</div>
          </div>
          <button type="button" onClick={onClose} disabled={salvando} style={styles.close}>×</button>
        </header>

        <div style={styles.modeRow}>
          <button type="button" onClick={() => setModo('date')} style={modo === 'date' ? styles.modeActive : styles.mode}>Reagendar data completa</button>
          <button type="button" onClick={() => setModo('day')} style={modo === 'day' ? styles.modeActive : styles.mode}>Alterar somente o dia</button>
        </div>

        {modo === 'date' ? (
          <div style={styles.panel}>
            <label style={styles.label}>Nova data completa
              <input type="date" value={novaDataISO} onChange={(event) => setNovaDataISO(event.target.value)} style={styles.input} />
            </label>
            <div style={styles.scopeRow}>
              <label><input type="radio" name="alcance-vencimento" checked={alcance === 'single'} onChange={() => setAlcance('single')} /> Somente esta parcela</label>
              <label><input type="radio" name="alcance-vencimento" checked={alcance === 'cascade'} onChange={() => setAlcance('cascade')} /> Esta parcela e as próximas abertas</label>
            </div>
          </div>
        ) : (
          <div style={styles.panel}>
            <label style={styles.label}>Novo dia de vencimento (1 a 31)
              <input type="number" min="1" max="31" value={novoDia} onChange={(event) => setNovoDia(event.target.value)} style={styles.input} />
            </label>
            <small>O mês e o ano são preservados. A alteração alcança esta parcela e as próximas abertas.</small>
          </div>
        )}

        <div style={styles.preview}>
          <strong>Prévia — nada é salvo até confirmar</strong>
          <div style={styles.tableHeader}><span>Antes</span><span>Depois</span><span>Status</span></div>
          {previa.linhas.map((linha) => (
            <div key={linha.id || linha.parcela_id} style={styles.tableRow}>
              <span>{formatarData(linha.antes)}</span>
              <span>{formatarData(linha.depois)}</span>
              <span>{linha.paga ? 'Não será alterada' : linha.alterada ? 'Será alterada' : 'Sem alteração'}</span>
            </div>
          ))}
        </div>

        {(previa.erro || erroServidor) && <div role="alert" style={styles.error}>{previa.erro || erroServidor}</div>}
        <footer style={styles.footer}>
          <button type="button" onClick={onClose} disabled={salvando} style={styles.cancel}>Cancelar</button>
          <button type="button" onClick={confirmar} disabled={!podeConfirmar} style={styles.confirm}>{salvando ? 'Confirmando…' : 'Confirmar alteração'}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, zIndex: 10100, display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(2, 6, 23, .58)' },
  modal: { width: 'min(720px, 96vw)', maxHeight: '92vh', overflow: 'auto', padding: 20, borderRadius: 12, background: 'var(--bg-card)', color: 'var(--text-main)', boxShadow: '0 20px 45px rgba(0,0,0,.4)' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 16 }, title: { margin: 0, fontSize: '1.2rem' }, subtitle: { marginTop: 5, color: 'var(--text-muted)', fontSize: '.9rem' },
  close: { border: 0, background: 'transparent', color: 'inherit', fontSize: 28, cursor: 'pointer' }, modeRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 },
  mode: { padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border-soft)', background: 'transparent', color: 'inherit', cursor: 'pointer' }, modeActive: { padding: '8px 12px', borderRadius: 7, border: '1px solid #2563eb', background: '#2563eb', color: '#fff', cursor: 'pointer' },
  panel: { display: 'grid', gap: 12, marginTop: 14, padding: 12, border: '1px solid var(--border-soft)', borderRadius: 8 }, label: { display: 'grid', gap: 6, fontWeight: 600 }, input: { padding: 8, borderRadius: 6, border: '1px solid var(--border-soft)', background: 'var(--bg-main)', color: 'inherit' },
  scopeRow: { display: 'grid', gap: 8 }, preview: { marginTop: 16, padding: 12, border: '1px solid var(--border-soft)', borderRadius: 8 }, tableHeader: { display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 8, marginTop: 10, fontWeight: 700, fontSize: '.85rem' }, tableRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 8, padding: '7px 0', borderTop: '1px solid var(--border-soft)', fontSize: '.9rem' },
  error: { marginTop: 12, padding: 10, borderRadius: 7, color: '#991b1b', background: '#fee2e2' }, footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }, cancel: { padding: '9px 13px', borderRadius: 7, border: '1px solid var(--border-soft)', background: 'transparent', color: 'inherit', cursor: 'pointer' }, confirm: { padding: '9px 13px', border: 0, borderRadius: 7, background: '#2563eb', color: '#fff', cursor: 'pointer' },
};
