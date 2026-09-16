import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { criarAutorizador } from '../src/security/segurancaCore.js';

const keys = ['editar_cliente','excluir_cliente','editar_emprestimo','excluir_emprestimo','excluir_todos_emprestimos','adicionar_juros_parcela','excluir_despesa','apagar_todos_dados'];
for (const key of keys) {
  test(`${key}: ON pede senha, valida e autoriza; errado bloqueia; OFF nunca abre prompt`, async () => {
    let ativo = true, senha = 'correta', prompts = 0, validacoes = 0, erros = 0;
    const autorizar = criarAutorizador({
      obterEstado: async chave => { assert.equal(chave, key); return { ativo, temSenha: true, nome: key }; },
      prompt: async (_message, options) => { prompts++; assert.equal(options.type, 'password'); return senha; },
      validarSenha: async (chave, password) => { validacoes++; assert.equal(chave, key); if (password !== 'correta') throw new Error('Senha incorreta.'); return { token: `token-${key}` }; },
      informarErro: async () => { erros++; },
    });
    assert.deepEqual(await autorizar(key), { headers: { 'X-Protecao-Token': `token-${key}` } });
    senha = 'errada'; assert.equal(await autorizar(key), null);
    assert.equal(prompts, 2); assert.equal(validacoes, 2); assert.equal(erros, 1);
    ativo = false; assert.deepEqual(await autorizar(key), {});
    assert.equal(prompts, 2); assert.equal(validacoes, 2);
  });
}
test('cancelar não valida; falha/má configuração nunca libera operação; parcela atual dispensa prompt', async () => {
  let estado = { ativo: true, temSenha: true, nome: 'Juros' }, prompts = 0, validacoes = 0;
  const autorizar = criarAutorizador({ obterEstado: async (_chave, contexto) => { assert.equal(contexto.parcelaId, 42); return estado; }, prompt: async () => { prompts++; return null; }, validarSenha: async () => { validacoes++; }, informarErro: async () => {} });
  assert.equal(await autorizar('adicionar_juros_parcela', { parcelaId: 42 }), null);
  assert.equal(validacoes, 0);
  estado = {}; assert.equal(await autorizar('adicionar_juros_parcela', { parcelaId: 42 }), null);
  assert.equal(prompts, 1);
  estado = { ativo: true, temSenha: true, exigida: false };
  assert.deepEqual(await autorizar('adicionar_juros_parcela', { parcelaId: 42 }), {});
  assert.equal(prompts, 1);
  const falha = criarAutorizador({ obterEstado: async () => { throw new Error('offline'); }, informarErro: async () => {} });
  assert.equal(await falha('editar_cliente'), null);
});
test('oito consumidores usam o helper e o gerenciador lista o catálogo completo com switch acessível', () => {
  const flows = [
    ['editarcliente.jsx', 'editar_cliente'], ['clientes.jsx','excluir_cliente'],
    ['editaremprestimo.jsx','editar_emprestimo'], ['Emprestimos/index.jsx','excluir_emprestimo'],
    ['Emprestimos/index.jsx','excluir_todos_emprestimos'], ['Emprestimos/JurosAdicionaisModal.jsx','adicionar_juros_parcela'],
    ['fluxoCaixa.jsx','excluir_despesa'], ['dashboard.jsx','apagar_todos_dados'],
  ];
  for (const [file,key] of flows) {
    const source = fs.readFileSync(new URL(`../src/componentes/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes(`autorizarProtecao('${key}'`), key);
    assert.ok(!source.includes('1otimodia'), `${file} não pode validar senha fixa`);
  }
  const manager = fs.readFileSync(new URL('../src/security/GerenciadorSeguranca.jsx', import.meta.url), 'utf8');
  const item = fs.readFileSync(new URL('../src/security/ProtecaoItem.jsx', import.meta.url), 'utf8');
  assert.ok(manager.includes('protecoes.map(')); assert.ok(item.includes('role="switch"'));
  assert.ok(item.includes('aria-checked={item.ativo}'));
  assert.ok(item.includes('Ligado')); assert.ok(item.includes('Desligado'));
  // Não substituir/remover as confirmações normais, nem a frase da exclusão total.
  for (const file of ['clientes.jsx','Emprestimos/index.jsx','fluxoCaixa.jsx','dashboard.jsx','Emprestimos/ParcelaList.jsx']) {
    assert.ok(fs.readFileSync(new URL(`../src/componentes/${file}`, import.meta.url), 'utf8').includes('notify.confirm('));
  }
  assert.ok(fs.readFileSync(new URL('../src/componentes/dashboard.jsx', import.meta.url), 'utf8').includes("confirmation: 'EXCLUIR TUDO'"));
});
