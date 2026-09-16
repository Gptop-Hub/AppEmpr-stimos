import React from 'react';

const LABELS = {
  cliente_id: 'cliente', emprestimo_id: 'empréstimo', valor: 'valor', data: 'data',
};

export default function ActionDraftNotice({ draft, onDiscard, busy }) {
  const missing = Array.isArray(draft && draft.missing_fields) ? draft.missing_fields : [];
  if (!draft || !missing.length) return null;
  const labels = missing.map((field) => LABELS[field] || field).join(', ');
  return (
    <div style={styles.box} aria-label="Rascunho de pagamento pendente">
      <div style={styles.title}>Rascunho de pagamento</div>
      <div style={styles.text}>Nada foi registrado. Ainda preciso de: {labels}.</div>
      <button type="button" onClick={onDiscard} disabled={busy} style={styles.button}>Descartar</button>
    </div>
  );
}

const styles = {
  box: { border: '1px solid rgba(251, 191, 36, .55)', background: 'rgba(120, 53, 15, .18)', borderRadius: 10, padding: 10, margin: '0 0 8px' },
  title: { color: '#fde68a', fontWeight: 800, fontSize: 13 },
  text: { color: '#e2e8f0', fontSize: 12, margin: '4px 0 8px' },
  button: { border: '1px solid #a16207', background: 'transparent', color: '#fde68a', borderRadius: 7, padding: '5px 8px', cursor: 'pointer' },
};
