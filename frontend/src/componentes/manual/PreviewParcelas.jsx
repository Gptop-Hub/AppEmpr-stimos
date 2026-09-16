import React from 'react';
import { renderLinhaJuros } from '../Emprestimos/helpers.jsx';

export default function PreviewParcelas({
  previewRenegociacao,
  BRL,
  modoJurosParcial,
  previewJurosParcial,
}) {
  const lista = modoJurosParcial ? previewJurosParcial : previewRenegociacao;

  if (!Array.isArray(lista) || lista.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 16,
        border: '1px solid var(--border-soft)',
        borderRadius: 8,
        padding: 12,
        background: 'var(--bg-card)',
        color: 'var(--text-main)',
      }}
    >
      <div
        style={{
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Pré-visualização de Parcelas
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {lista.map((p) => {
          const total = Number(p.total || 0);

          const capital =
            typeof p.amortizacao === 'number'
              ? p.amortizacao
              : Number(p.capital ?? 0);

          const jurosPend = Number(p.juros_pendentes || 0);
          const jurosAdic = Number(p.juros_adicionais || 0);
          const jurosBase =
            typeof p.juros === 'number'
              ? p.juros
              : Math.max(
                  0,
                  Number(total || 0) -
                    Number(capital || 0) -
                    jurosPend -
                    jurosAdic
                );

          const hasOriginal =
            typeof p.total_original === 'number' &&
            Math.abs(p.total_original - total) > 0.01;

          const isPago = !!p.pago;

          return (
            <li
              key={p.numero}
              style={{
                marginBottom: 8,
                opacity: isPago ? 0.45 : 1,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {p.numero}ª: {BRL(total)}
                {hasOriginal && (
                  <span
                    style={{
                      fontSize: 12,
                      marginLeft: 6,
                      color: 'var(--text-muted)',
                    }}
                  >
                    (original {BRL(p.total_original)})
                  </span>
                )}
                {isPago && (
                  <span
                    style={{
                      fontSize: 12,
                      marginLeft: 8,
                      color: 'var(--text-muted)',
                    }}
                  >
                    Pago
                  </span>
                )}
              </div>

              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                (
                {renderLinhaJuros(
                  {
                    valor_capital: capital,
                    valor_juros: jurosBase,
                    juros_pendentes: jurosPend,
                    juros_adicionais: jurosAdic,
                  },
                  BRL,
                  {
                    renderJurosPendentes: (value) => (
                      <strong style={{ fontWeight: 800 }}>{value}</strong>
                    ),
                  }
                )}
                )
                {!modoJurosParcial && p.vencimento && (
                  <>
                    <br />
                    <strong>Vencimento: {p.vencimento}</strong>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
