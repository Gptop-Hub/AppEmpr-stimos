import React from 'react';

export default function PreviewParcelas({
  previewRenegociacao,
  BRL,
  // NOVO: modo especial para pagamento de juros parcial
  modoJurosParcial,
  previewJurosParcial = [],
}) {
  // --- MODO JUROS PARCIAL: pré-visualização de como ficam as parcelas atuais ---
  if (modoJurosParcial) {
    return (
      <div style={{ marginTop: 16 }}>
        <h4 style={{ fontWeight: 700, marginBottom: 8 }}>
          Pré-visualização de Parcelas
        </h4>

        {previewJurosParcial.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            Nenhuma parcela para pré-visualizar.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {previewJurosParcial.map((p) => (
              <li
                key={p.numero}
                style={{
                  padding: '10px 8px',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  {p.numero}ª: {BRL(p.total)} {p.pago ? '✅ Pago' : ''}
                </div>

                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {p.juros_adicional && p.juros_adicional > 0 ? (
                    <>
                      (Capital: {BRL(p.capital)}, Juros:{' '}
                      {BRL(p.juros)} + {BRL(p.juros_adicional)})
                    </>
                  ) : (
                    <>
                      (Capital: {BRL(p.capital)}, Juros: {BRL(p.juros)})
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // --- MODO PADRÃO (pré-visualização da renegociação, já existente) ---
  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ fontWeight: 700, marginBottom: 8 }}>
        Pré-visualização de Parcelas
      </h4>
      {previewRenegociacao.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Informe novo capital, parcelas e taxa para ver a simulação.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {previewRenegociacao.map((p) => (
            <li
              key={p.numero}
              style={{
                padding: '10px 8px',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                marginBottom: 8,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                {p.numero}ª: {BRL(p.total)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                (Capital: {BRL(p.amortizacao)}, Juros: {BRL(p.juros)})<br />
                <strong>Vencimento: {p.vencimento}</strong>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}