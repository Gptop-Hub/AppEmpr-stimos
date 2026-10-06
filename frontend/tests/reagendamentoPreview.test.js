import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { montarPreviaReagendamento } from '../src/componentes/Emprestimos/reagendamentoPreview.js';

const parcelas = () => [
  { id: 1, numero: 1, vencimento: '2026-12-13', pago: 0, valor_pago: 0 },
  { id: 2, numero: 2, vencimento: '2027-01-13', pago: 0, valor_pago: 0 },
  { id: 3, numero: 3, vencimento: '2027-02-13', pago: 0, valor_pago: 0 },
];

test('prévia de data é local: não muta parcelas enquanto o usuário escolhe ou cancela', () => {
  const origem = parcelas();
  const antes = JSON.stringify(origem);
  const previa = montarPreviaReagendamento({ parcelas: origem, parcelaId: 1, tipo: 'cascade', novaDataISO: '2027-02-21' });
  assert.deepEqual(previa.linhas.map((p) => p.depois), ['2027-02-21', '2027-03-21', '2027-04-21']);
  assert.equal(JSON.stringify(origem), antes);
});

test('entrada parcial não é uma data confirmável e não cria prévia persistível', () => {
  const previa = montarPreviaReagendamento({ parcelas: parcelas(), parcelaId: 1, tipo: 'single', novaDataISO: '2' });
  assert.match(previa.erro, /data completa válida/i);
});

test('prévia marca pagamentos registrados como não alteráveis', () => {
  const origem = parcelas();
  origem[1] = { ...origem[1], valor_pago: 5, data_pagamento: '2027-01-14' };
  const previa = montarPreviaReagendamento({ parcelas: origem, parcelaId: 1, tipo: 'change_day', novoDia: 21 });
  assert.equal(previa.linhas[1].paga, true);
  assert.equal(previa.linhas[1].alterada, false);
  assert.equal(previa.linhas[1].depois, '2027-01-13');
});

test('prévia informa colisão de período antes da confirmação', () => {
  const previa = montarPreviaReagendamento({ parcelas: parcelas(), parcelaId: 1, tipo: 'single', novaDataISO: '2027-02-21' });
  assert.match(previa.erro, /mesmo mês/i);
});

test('fluxo ativo não tem input de vencimento persistente nem PUT duplicado', () => {
  const listSource = fs.readFileSync(new URL('../src/componentes/Emprestimos/ParcelaList.jsx', import.meta.url), 'utf8');
  const modalSource = fs.readFileSync(new URL('../src/componentes/Emprestimos/ReagendarVencimentoModal.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(listSource, /onChangeVencimentoInput\(p, e\.target\.value\)/);
  assert.doesNotMatch(listSource, /window\.confirm/);
  assert.match(modalSource, /axios\.post\('\/parcelas\/reagendar-confirmado'/);
  assert.doesNotMatch(modalSource, /axios\.put\(/);
  assert.match(modalSource, /onChange=\{\(event\) => setNovaDataISO\(event\.target\.value\)\}/);
});
