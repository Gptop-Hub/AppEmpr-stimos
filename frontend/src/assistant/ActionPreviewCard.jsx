import React from 'react';

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';
}
function display(label, value) { return typeof value === 'number' && /valor|juros|capital|pago/i.test(label) ? money(value) : String(value ?? '—'); }

export default function ActionPreviewCard({ actionPreview, busy, statusText, onConfirm, onCancel }) {
  const data = actionPreview && actionPreview.preview ? actionPreview.preview : {};
  const ui = data.ui || {};
  const fields = Array.isArray(ui.fields) ? ui.fields : [];
  const sections = Array.isArray(ui.sections) ? ui.sections : [];
  const impacts = Array.isArray(ui.impact) ? ui.impact : [];
  const disabled = Boolean(busy);
  return (
    <section style={styles.card} aria-label="Prévia da ação financeira">
      <div style={styles.title}>{ui.title || actionPreview.action || 'Ação financeira'}</div>
      <div style={styles.notice}>Nada foi registrado ainda. Confirme somente após revisar os dados.</div>
      <dl style={styles.grid}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(label, value)}</dd></div>)}</dl>
      {sections.map((section) => <div key={section.title} style={styles.section}><strong>{section.title}</strong>{(section.rows || []).map(([label, value]) => <div key={label} style={styles.row}><span>{label}</span><span>{display(label, value)}</span></div>)}</div>)}
      {impacts.map(([label, value]) => <div key={label} style={styles.impact}>{label}: {display(label, value)}</div>)}
      {statusText ? <div style={styles.status}>{statusText}</div> : null}
      <div style={styles.actions}>
        <button type="button" onClick={onConfirm} disabled={disabled} style={{ ...styles.confirm, ...(disabled ? styles.disabled : null) }}>{busy ? 'Confirmando…' : 'Confirmar'}</button>
        <button type="button" onClick={onCancel} disabled={disabled} style={{ ...styles.cancel, ...(disabled ? styles.disabled : null) }}>Cancelar</button>
      </div>
    </section>
  );
}
const styles = { card: { border: '1px solid rgba(45, 212, 191, .55)', background: 'rgba(15, 118, 110, .14)', borderRadius: 12, padding: 12, margin: '0 0 8px' }, title: { fontWeight: 800, color: '#ccfbf1', fontSize: 15 }, notice: { color: '#cbd5e1', fontSize: 12, marginTop: 5 }, grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9, margin: '12px 0' }, section: { borderTop: '1px solid rgba(148,163,184,.3)', paddingTop: 8, marginBottom: 8, fontSize: 12, color: '#e2e8f0' }, row: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 5 }, impact: { color: '#99f6e4', fontSize: 12, marginBottom: 5 }, status: { color: '#fde68a', fontSize: 12, marginBottom: 8 }, actions: { display: 'flex', gap: 8 }, confirm: { border: 0, borderRadius: 8, padding: '8px 11px', background: '#14b8a6', color: '#042f2e', fontWeight: 800, cursor: 'pointer' }, cancel: { border: '1px solid #64748b', borderRadius: 8, padding: '8px 11px', background: 'transparent', color: '#e2e8f0', cursor: 'pointer' }, disabled: { opacity: .55, cursor: 'not-allowed' } };
