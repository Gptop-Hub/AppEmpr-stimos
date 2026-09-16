import React, { useState } from 'react';
import CobrancaTab from './abas/CobrancaTab';

const TAB_COBRANCA = 'cobranca';

export default function RelatoriosPage() {
  const [abaAtiva, setAbaAtiva] = useState(TAB_COBRANCA);

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 'var(--main-max-effective, var(--main-max))',
        margin: '0 auto',
        color: 'var(--text-main)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0 }}>Relatorios</h2>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.92em' }}>
          Operacao de cobranca com foco em uso diario e impressao.
        </span>
      </header>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--border-soft)',
          paddingBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setAbaAtiva(TAB_COBRANCA)}
          style={{
            padding: '7px 12px',
            borderRadius: 999,
            border: '1px solid var(--border-soft)',
            background: abaAtiva === TAB_COBRANCA ? '#0f766e' : 'var(--bg-card)',
            color: abaAtiva === TAB_COBRANCA ? '#fff' : 'var(--text-main)',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          Cobranca
        </button>
      </div>

      {abaAtiva === TAB_COBRANCA ? <CobrancaTab /> : null}
    </div>
  );
}
