import React from 'react';

export default function ResumoPagamento({
  valorTotal,
  primeiraAberta,
  saldoJurosParcela,
  valorTotalParcela,
  capitalParcela,
  capitalAnterior,
  capitalPosParcela,
  sobraAposParcela,
  abatExtraCapital,
  novoCapitalCalculado,
  isJurosParcialPreview,
  usadoPrimeiraJ,
  usadoPrimeiraC,
  BRL,
}) {
  if (!valorTotal || !primeiraAberta) return null;

  const numParcela = primeiraAberta.numero;
  const jurosParcela = saldoJurosParcela;
  const jurosRestante = Math.max(jurosParcela - usadoPrimeiraJ, 0);
  const jurosCarregado = jurosRestante;
  const jurosProx = jurosParcela + jurosCarregado;
  const proximaParcelaValor = capitalParcela + jurosProx;

  if (valorTotal >= valorTotalParcela - 1e-6) {
    return (
      <>
        <div>
          Pagamento total: <strong>{BRL(valorTotal)}</strong>
        </div>
        <div>
          Valor da {numParcela}ª parcela:{' '}
          <strong>{BRL(valorTotalParcela)}</strong>
        </div>

        <pre
          style={{
            fontFamily: 'monospace',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-soft)',
            padding: '8px 10px',
            borderRadius: 6,
            marginTop: 8,
            color: 'var(--text-main)',
          }}
        >
{`
  ${BRL(valorTotal)}
- ${BRL(valorTotalParcela)}
────────────
  ${BRL(sobraAposParcela)}
`}
        </pre>

        <div style={{ marginTop: 6 }}>
          Capital restante após pagamento da {numParcela}ª parcela:{' '}
          <strong>{BRL(capitalPosParcela)}</strong>
        </div>

        {abatExtraCapital > 0 && (
          <pre
            style={{
              fontFamily: 'monospace',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-soft)',
              padding: '8px 10px',
              borderRadius: 6,
              marginTop: 8,
              color: 'var(--text-main)',
            }}
          >
{`
  ${BRL(capitalPosParcela)}
- ${BRL(abatExtraCapital)}
────────────
  ${BRL(novoCapitalCalculado)}
`}
          </pre>
        )}

        <div style={{ marginTop: 6 }}>
          <strong>➡️ Novo capital: {BRL(novoCapitalCalculado)}</strong>
        </div>
      </>
    );
  }

  if (isJurosParcialPreview) {
    return (
      <>
        <div>
          Pagamento total: <strong>{BRL(valorTotal)}</strong>
        </div>
        <div>
          Juros da {numParcela}ª parcela:{' '}
          <strong>{BRL(jurosParcela)}</strong>
        </div>

        <pre
          style={{
            fontFamily: 'monospace',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-soft)',
            padding: '8px 10px',
            borderRadius: 6,
            marginTop: 8,
            color: 'var(--text-main)',
          }}
        >
{`
  Juros do mês:   ${BRL(jurosParcela)}
- Pago agora:     ${BRL(usadoPrimeiraJ)}
────────────
  Pendentes:      ${BRL(jurosRestante)}
`}
        </pre>

        <div style={{ marginTop: 8 }}>
          Os juros pendentes serão somados como{' '}
          <strong>juros adicionais</strong> na próxima cobrança
          dessa parcela.
        </div>

        <div style={{ marginTop: 10 }}>
          Capital do empréstimo permanece:{' '}
          <strong>{BRL(capitalAnterior)}</strong>
        </div>

        {/* AQUI FOI A ÚNICA MUDANÇA VISUAL */}
        <div style={{ marginTop: 10 }}>
          <div>
            <strong>
              ➡️ Próxima cobrança da {numParcela}ª parcela:{' '}
              {BRL(proximaParcelaValor)}
            </strong>
          </div>

          <div style={{ fontSize: 13, marginTop: 2 }}>
            (Capital: {BRL(capitalParcela)}, Juros: {BRL(jurosParcela)} +{' '}
            {BRL(jurosCarregado)})
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        Pagamento total: <strong>{BRL(valorTotal)}</strong>
      </div>
      <div>
        Valor da {numParcela}ª parcela:{' '}
        <strong>{BRL(valorTotalParcela)}</strong>
      </div>

      <pre
        style={{
          fontFamily: 'monospace',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-soft)',
          padding: '8px 10px',
          borderRadius: 6,
          marginTop: 8,
          color: 'var(--text-main)',
        }}
      >
{`
  Pagamento: ${BRL(valorTotal)}
- Juros:     ${BRL(usadoPrimeiraJ)}
────────────
  Capital:   ${BRL(usadoPrimeiraC)}
`}
      </pre>

      <div style={{ marginTop: 10 }}>
        Capital antes do pagamento:{' '}
        <strong>{BRL(capitalAnterior)}</strong>
      </div>

      <pre
        style={{
          fontFamily: 'monospace',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-soft)',
          padding: '8px 10px',
          borderRadius: 6,
          marginTop: 8,
          color: 'var(--text-main)',
        }}
      >
{`
  ${BRL(capitalAnterior)}
- ${BRL(usadoPrimeiraC)}
────────────
  ${BRL(novoCapitalCalculado)}
`}
      </pre>

      <div style={{ marginTop: 6 }}>
        <strong>➡️ Novo capital: {BRL(novoCapitalCalculado)}</strong>
      </div>
    </>
  );
}