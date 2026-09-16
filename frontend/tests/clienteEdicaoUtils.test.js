import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizarDDD, normalizarTelefoneCliente, separarTelefoneCliente, dataClienteParaInput,
  camposDeIdentificacaoAlterados, encontrarDuplicidadesEdicao, mensagemDuplicidade,
} from '../src/componentes/common/clienteEdicaoUtils.js';

const atual = { id: 15, nome: 'João Silva', telefone: '(64) 99999-8888' };
const outro = { id: 25, nome: 'Maria Souza', telefone: '(62) 98888-7777', telefones_extras: ['(064) 97777-6666'] };
const catalogo = [atual, outro];

test('editor reconhece os formatos de telefone do cadastro e de registros existentes', () => {
  for (const telefone of ['(064) 99999-8888', '(64) 99999-8888', '64999998888', '+55 (64) 99999-8888']) {
    assert.equal(normalizarTelefoneCliente(telefone), '64999998888');
    assert.deepEqual(separarTelefoneCliente(telefone), { ddd: '64', telefone: '99999-8888' });
  }
  assert.equal(normalizarDDD('064'), '64');
  assert.deepEqual(separarTelefoneCliente('(062) 3333-4444'), { ddd: '62', telefone: '3333-4444' });
  assert.equal(normalizarTelefoneCliente(''), '');
  assert.equal(normalizarTelefoneCliente('99999-8888'), '');
});

test('telefone repetido considera DDD, formatação e números adicionais de outros clientes', () => {
  let avisos = encontrarDuplicidadesEdicao({ ...atual, telefone: '(062) 98888-7777' }, atual, catalogo);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].campo, 'telefone');
  assert.deepEqual(avisos[0].clientes.map(c => c.id), [25]);
  assert.match(mensagemDuplicidade(avisos[0]), /#25 — Maria Souza/);
  avisos = encontrarDuplicidadesEdicao({ ...atual, telefone: '+55 (64) 97777-6666' }, atual, catalogo);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].clientes[0].id, 25);
  assert.deepEqual(encontrarDuplicidadesEdicao({ ...atual, telefone: '(64) 98888-7777' }, atual, catalogo), []);
});

test('não avisa ao editar outros campos de um cliente que já compartilha nome ou telefone', () => {
  const compartilhado = { ...outro, nome: 'JOAO SILVA', telefone: '(064) 99999-8888' };
  const dados = { ...atual, nome: 'João   Silva', telefone: '+55 64 99999-8888', empresa: 'Empresa igual', endereco: 'Endereço igual' };
  assert.equal(camposDeIdentificacaoAlterados(dados, atual), false);
  assert.deepEqual(encontrarDuplicidadesEdicao(dados, atual, [atual, compartilhado]), []);
});

test('nome completo repetido gera aviso, normalizando acentos e espaços, sem comparação parcial', () => {
  const avisos = encontrarDuplicidadesEdicao({ ...atual, nome: 'MARIA   SOUZA' }, atual, catalogo);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].campo, 'nome');
  assert.deepEqual(avisos[0].clientes.map(c => c.id), [25]);
  assert.deepEqual(encontrarDuplicidadesEdicao({ ...atual, nome: 'Maria' }, atual, catalogo), []);
});

test('trocar ID não faz o cliente conflitar consigo mesmo e combina avisos dos campos alterados', () => {
  assert.deepEqual(encontrarDuplicidadesEdicao({ ...atual, id: 40 }, atual, catalogo), []);
  const avisos = encontrarDuplicidadesEdicao({ ...outro, id: 40 }, atual, catalogo);
  assert.deepEqual(avisos.map(a => a.campo), ['nome','telefone']);
});

test('empresa, telefone da empresa, endereço, categoria, data e observações compartilhadas não geram aviso', () => {
  const comuns = { empresa: 'Empresa Exemplo', telEmpresa: '3333-4444', cidade: 'Itumbiara', rua: 'Rua Um', numero: '1', bairro: 'Centro', categoriaTrabalho: 'Serviços', referencia: 'Família', observacao: 'Mesmo texto', criadoEm: '2026-01-01' };
  assert.deepEqual(encontrarDuplicidadesEdicao({ ...atual, ...comuns }, atual, [atual, { ...outro, ...comuns }]), []);
});

test('data preenchida no editor aceita dia simples e timestamps existentes sem deslocar o dia', () => {
  for (const value of ['2026-01-01', '2026-01-01T23:30:00Z', '2026-01-01 12:30:00']) {
    assert.equal(dataClienteParaInput(value), '2026-01-01');
  }
  assert.equal(dataClienteParaInput(null), '');
});
