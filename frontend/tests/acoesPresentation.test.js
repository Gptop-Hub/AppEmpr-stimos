import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionDayLabel,
  actionTimeLabel,
  buildSnapshotComparison,
  formatDetailValue,
  groupActionsByDay,
  metadataEntries,
} from '../src/componentes/acoesPresentation.js';

test('agrupa ações por hoje, ontem e data mantendo a ordem recebida', () => {
  const now = new Date(2026, 8, 29, 18, 0, 0);
  const items = [
    { acao_uid: '1', created_at: '2026-09-29T10:00:00' },
    { acao_uid: '2', created_at: '2026-09-29T09:00:00' },
    { acao_uid: '3', created_at: '2026-09-28T20:00:00' },
    { acao_uid: '4', created_at: '2026-09-27T08:00:00' },
  ];
  const groups = groupActionsByDay(items, now);
  assert.deepEqual(groups.map((group) => group.label), ['Hoje', 'Ontem', '27/09/2026']);
  assert.deepEqual(groups[0].items.map((item) => item.acao_uid), ['1', '2']);
  assert.equal(actionDayLabel('2026-09-29T10:00:00', now), 'Hoje');
  assert.match(actionTimeLabel('2026-09-29T10:00:00'), /^\d{2}:\d{2}$/);
});

test('compara snapshots e destaca somente valores realmente alterados', () => {
  const comparison = buildSnapshotComparison([
    {
      momento: 'antes', entidade: 'clientes',
      dados: { cliente: { id: 1, cliente_uid: 'segredo-local', nome: 'Ana', mal_pagador: 0 } },
    },
    {
      momento: 'depois', entidade: 'clientes',
      dados: { cliente: { id: 1, cliente_uid: 'segredo-local', nome: 'Ana', mal_pagador: 1 } },
    },
  ]);
  assert.equal(comparison.changed_count, 1);
  assert.equal(comparison.items[0].label, 'Cliente · Cliente · Mal pagador');
  assert.equal(formatDetailValue(comparison.items[0].key, comparison.items[0].before), 'Não');
  assert.equal(formatDetailValue(comparison.items[0].key, comparison.items[0].after), 'Sim');
  assert.equal(comparison.items.some((item) => item.key.includes('uid') || item.key.endsWith('.id')), false);
});

test('apresenta parâmetros registrados com labels e formatos amigáveis', () => {
  const entries = metadataEntries({
    contract: 'emprestimo_action_v1',
    parametros: { valor: 300, taxa_juros: 4.5, cliente_id: 9 },
  });
  assert.deepEqual(entries.map((item) => item.label), ['Valor', 'Taxa de juros']);
  assert.equal(formatDetailValue(entries[0].key, entries[0].value), 'R$ 300,00');
  assert.equal(formatDetailValue(entries[1].key, entries[1].value), '4,5%');
});
