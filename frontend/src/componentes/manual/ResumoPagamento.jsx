import React from 'react';
import { renderLinhaJuros } from '../Emprestimos/helpers.jsx';

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

  // Total de juros da parcela no momento (juros base + adicionais)
  const jurosDoMes = Math.max(valorTotalParcela - capitalParcela, 0);

  // --- Caso 1: pagamento cobre a parcela inteira ---
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
          <strong>Novo capital: {BRL(novoCapitalCalculado)}</strong>
        </div>
      </>
    );
  }

  // --- Caso 2: pagamento de juros parcial ---
  if (isJurosParcialPreview) {
    const jurosBaseMes = Number(primeiraAberta?.valor_juros || 0);
    const jurosPendentesAntes = Number(primeiraAberta?.juros_pendentes || 0);
    const jurosAdicionaisAntes = Number(primeiraAberta?.juros_adicionais || 0);
    let restante = Math.max(Number(valorTotal || 0), 0);

    // abate na ordem: adicionais -> pendentes -> base
    const abatAdic = Math.min(restante, jurosAdicionaisAntes);
    restante -= abatAdic;
    const jurosAdicionaisRestante = Math.max(jurosAdicionaisAntes - abatAdic, 0);

    const abatPend = Math.min(restante, jurosPendentesAntes);
    restante -= abatPend;
    const jurosPendentesRestante = Math.max(jurosPendentesAntes - abatPend, 0);

    const abatBase = Math.min(restante, jurosBaseMes);
    restante -= abatBase;
    const jurosBaseRestante = Math.max(jurosBaseMes - abatBase, 0);

    // pendentes exibidos = pendentes antigos restantes + base nao paga
    const pendentesDepois = Number(
      (jurosPendentesRestante + jurosBaseRestante + jurosAdicionaisRestante).toFixed(2)
    );

    const proximaParcelaValor = capitalParcela + jurosBaseMes + pendentesDepois;

    return (
      <>
        <div>
          Pagamento total: <strong>{BRL(valorTotal)}</strong>
        </div>
        <div>
          Juros da {numParcela}ª parcela:{' '}
          <strong>{BRL(jurosBaseMes + jurosPendentesAntes + jurosAdicionaisAntes)}</strong>
        </div>

        <div
          style={{
            fontFamily: 'monospace',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-soft)',
            padding: '8px 10px',
            borderRadius: 6,
            marginTop: 8,
            color: 'var(--text-main)',
            whiteSpace: 'pre',
          }}
        >
          <div>{`  Juros totais agora: ${BRL(jurosBaseMes + jurosPendentesAntes + jurosAdicionaisAntes)}`}</div>
          <div>{`- Pago agora:     ${BRL(valorTotal)}`}</div>
          <div>{'────────────────────────────────'}</div>
          <div>
            {'  Pendentes:      '}
            <strong>{BRL(pendentesDepois)}</strong>
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          Os juros pendentes serão somados com os juros na próxima cobrança dessa parcela.
        </div>

        <div style={{ marginTop: 10 }}>
          Capital do empréstimo permanece:{' '}
          <strong>{BRL(capitalAnterior)}</strong>
        </div>

        <div style={{ marginTop: 10 }}>
          <div>
            <strong>
              Próxima cobrança da {numParcela}ª parcela:{' '}
              {BRL(proximaParcelaValor)}
            </strong>
          </div>

          <div style={{ fontSize: 13, marginTop: 2 }}>
            (
            {renderLinhaJuros(
              {
                valor_capital: capitalParcela,
                valor_juros: jurosBaseMes,
                juros_pendentes: pendentesDepois,
                juros_adicionais: 0,
              },
              BRL
            )}
            )
          </div>
        </div>
      </>
    );
  }

  // --- Caso 3: pagamento manual "normal" (juros + capital) ---
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
        <strong>Novo capital: {BRL(novoCapitalCalculado)}</strong>
      </div>
    </>
  );
}
