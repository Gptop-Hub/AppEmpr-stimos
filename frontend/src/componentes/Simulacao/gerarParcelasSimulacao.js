const fix2 = (n) => Number(Number(n || 0).toFixed(2));

export function gerarParcelasSimulacao({ capital, taxa_juros, qtdParcelas }) {
  const capitalNum = Number(capital || 0);
  const jurosNum = Number(taxa_juros || 0);
  const parcelasNum = Math.trunc(Number(qtdParcelas || 0));

  if (!Number.isFinite(capitalNum) || capitalNum <= 0) return [];
  if (!Number.isFinite(jurosNum) || jurosNum < 0) return [];
  if (!Number.isFinite(parcelasNum) || parcelasNum <= 0) return [];

  const amortizacao = capitalNum / parcelasNum;
  let saldo = capitalNum;
  const parcelas = [];

  for (let i = 1; i <= parcelasNum; i += 1) {
    const juros = saldo * (jurosNum / 100);
    const total = amortizacao + juros;

    parcelas.push({
      numero: i,
      valor_total: fix2(total),
      valor_capital: fix2(amortizacao),
      valor_juros: fix2(juros),
    });

    saldo -= amortizacao;
    if (Math.abs(saldo) < 1e-10) saldo = 0;
  }

  return parcelas;
}
