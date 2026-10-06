const assert = require('node:assert/strict');
const test = require('node:test');
const gerarParcelas = require('../utils/gerarParcelas');

const f2 = (value) => Number(Number(value || 0).toFixed(2));
const somarCapital = (parcelas) => f2(
  parcelas.reduce((soma, parcela) => soma + Number(parcela.valor_capital || 0), 0)
);

function gerar(opcoes) {
  return gerarParcelas({
    dataInicio: '2026-09-24',
    primeiroVencimento: '2026-10-24',
    ...opcoes,
  });
}

test('fecha o capital de 1624,90 em três parcelas e explica o ajuste', () => {
  const parcelas = gerar({ capital: 1624.90, taxa_juros: 0, qtdParcelas: 3 });

  assert.deepEqual(parcelas.map((parcela) => parcela.valor_capital), [541.63, 541.63, 541.64]);
  assert.equal(somarCapital(parcelas), 1624.90);
  assert.equal(parcelas[2].valor_total, 541.64);
  assert.equal(
    parcelas[2].explicacao,
    'Ajuste de R$ 0,01 aplicado nesta parcela para fechar corretamente o capital total do empréstimo.'
  );
});

test('não cria ajuste nem explicação quando a divisão fecha exatamente', () => {
  const parcelas = gerar({ capital: 1000, taxa_juros: 10, qtdParcelas: 2 });

  assert.deepEqual(parcelas.map((parcela) => parcela.valor_capital), [500, 500]);
  assert.deepEqual(parcelas.map((parcela) => parcela.valor_juros), [100, 50]);
  assert.deepEqual(parcelas.map((parcela) => parcela.valor_total), [600, 550]);
  assert.equal(parcelas[1].explicacao, undefined);
  assert.equal(somarCapital(parcelas), 1000);
});

test('usa o valor real do resíduo em outro caso de divisão', () => {
  const parcelas = gerar({ capital: 1000, taxa_juros: 0, qtdParcelas: 3 });

  assert.deepEqual(parcelas.map((parcela) => parcela.valor_capital), [333.33, 333.33, 333.34]);
  assert.equal(somarCapital(parcelas), 1000);
  assert.match(parcelas[2].explicacao, /R\$\s?0,01/);
});

test('fecha o capital em cronogramas extensos', () => {
  const parcelas = gerar({ capital: 9999.99, taxa_juros: 0, qtdParcelas: 360 });

  assert.equal(parcelas.length, 360);
  assert.equal(somarCapital(parcelas), 9999.99);
  assert.equal(parcelas[359].valor_total, parcelas[359].valor_capital);
});

test('preserva a regra de juros e altera somente o capital residual da última parcela', () => {
  const capital = 1624.90;
  const taxa = 10;
  const parcelas = gerar({ capital, taxa_juros: taxa, qtdParcelas: 3 });
  const amortizacaoOriginal = capital / 3;
  let saldo = capital;
  const jurosEsperados = [];

  for (let numero = 0; numero < 3; numero += 1) {
    jurosEsperados.push(f2(saldo * (taxa / 100)));
    saldo -= amortizacaoOriginal;
  }

  assert.deepEqual(parcelas.map((parcela) => parcela.valor_juros), jurosEsperados);
  assert.equal(somarCapital(parcelas), capital);
  assert.equal(
    parcelas[2].valor_total,
    f2(parcelas[2].valor_capital + parcelas[2].valor_juros)
  );
});
