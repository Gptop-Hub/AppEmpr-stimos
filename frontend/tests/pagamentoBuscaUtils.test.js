import assert from 'node:assert/strict';
import test from 'node:test';
import { filtrarEmprestimosParaPagamento } from '../src/componentes/pagamentoBuscaUtils.js';

const emprestimos = [
  { id: 41, cliente_id: 4, cliente_nome: 'Cliente Quatro', codigo_cliente: '4-1', capital_restante: 100 },
  { id: 42, cliente_id: 4, cliente_nome: 'Cliente Quatro', codigo_cliente: '4-2', capital_restante: 200 },
  { id: 43, cliente_id: 4, cliente_nome: 'Cliente Quatro', codigo_cliente: '4-3', capital_restante: 0 },
  { id: 44, cliente_id: 40, cliente_nome: 'Cliente Quarenta', codigo_cliente: '40-1', capital_restante: 100 },
  { id: 51, cliente_id: 5, cliente_nome: 'Outro Cliente', codigo_cliente: '5-1', capital_restante: 100 },
];

const ids = (lista) => lista.map((emp) => emp.id);

test('busca por ID do cliente retorna todos e somente os empréstimos ativos daquele cliente', () => {
  assert.deepEqual(ids(filtrarEmprestimosParaPagamento(emprestimos, { buscaId: '4' })), [41, 42]);
});

test('busca por nome mantém todos os empréstimos ativos do cliente', () => {
  assert.deepEqual(
    ids(filtrarEmprestimosParaPagamento(emprestimos, { busca: 'cliente quatro' })),
    [41, 42]
  );
});

test('busca por código específico do empréstimo permanece disponível', () => {
  assert.deepEqual(ids(filtrarEmprestimosParaPagamento(emprestimos, { busca: '4-2' })), [42]);
});

test('empréstimos quitados não aparecem na busca de pagamento', () => {
  assert.deepEqual(ids(filtrarEmprestimosParaPagamento(emprestimos, { busca: '4-3' })), []);
});
