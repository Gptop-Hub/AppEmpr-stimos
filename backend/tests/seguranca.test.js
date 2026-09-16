const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { PROTECOES, criarSegurancaService, getSegurancaService } = require('../services/segurancaService');
const { criarSegurancaRouter } = require('../routes/seguranca');
const { exigirProtecao, jurosExigemProtecao } = require('../middleware/protecao');
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));
const abrirServidor = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const rejeita = (promise, status) => assert.rejects(promise, err => err.status === status);

test('gerenciador: hashes independentes, configuração, estados e persistência', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seguranca-config-'));
  const dbPath = path.join(root, 'seguranca.db');
  let service = criarSegurancaService({ dbPath });
  t.after(async () => { await service.fechar(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.inicializar();
  await t.test('oito proteções ligadas, hashes scrypt com salts diferentes e sem exposição', async () => {
    const items = await service.listar();
    assert.equal(items.length, 8);
    assert.deepEqual(items.map(p => p.chave), PROTECOES.map(([key]) => key));
    assert.ok(items.every(p => p.ativo && p.temSenha && !Object.hasOwn(p, 'senha_hash')));
    const reader = new sqlite3.Database(dbPath);
    try {
      const rows = await all(reader, 'SELECT * FROM seguranca_protecoes');
      assert.equal(new Set(rows.map(p => p.senha_hash)).size, 8);
      assert.ok(rows.every(p => p.senha_hash.startsWith('scrypt$32768$8$3$') && !p.senha_hash.includes('1otimodia')));
    } finally { await close(reader); }
  });
  await t.test('alteração exige senha atual e confirmação; senhas e tokens não atravessam proteções', async () => {
    const key = 'editar_cliente';
    await rejeita(service.definirSenha(key, { novaSenha: ' ', confirmacao: ' ' }), 400);
    await rejeita(service.definirSenha(key, { senhaAtual: '1otimodia', novaSenha: 'nova', confirmacao: 'outra' }), 400);
    await rejeita(service.definirSenha(key, { senhaAtual: 'errada', novaSenha: 'nova', confirmacao: 'nova' }), 401);
    const antiga = await service.validarSenhaProtecao(key, '1otimodia');
    await service.definirSenha(key, { senhaAtual: '1otimodia', novaSenha: 'nova-cliente', confirmacao: 'nova-cliente' });
    await rejeita(service.autorizar(key, antiga.token), 401);
    await rejeita(service.validarSenhaProtecao(key, '1otimodia'), 401);
    const nova = await service.validarSenhaProtecao(key, 'nova-cliente');
    assert.equal(await service.autorizar(key, nova.token), true);
    await rejeita(service.autorizar('excluir_cliente', nova.token), 401);
    await rejeita(service.validarSenhaProtecao('excluir_cliente', 'nova-cliente'), 401);
    assert.ok((await service.validarSenhaProtecao('excluir_cliente', '1otimodia')).token);
  });
  await t.test('desligar exige senha; ligar preserva senha; estado continua ao reabrir SQLite', async () => {
    await rejeita(service.alterarEstado('editar_cliente', { ativo: false, senhaAtual: 'errada' }), 401);
    assert.equal(await service.protecaoAtiva('editar_cliente'), true);
    await service.alterarEstado('editar_cliente', { ativo: false, senhaAtual: 'nova-cliente' });
    assert.equal(await service.autorizar('editar_cliente'), true);
    await service.fechar();
    service = criarSegurancaService({ dbPath });
    assert.equal(await service.protecaoAtiva('editar_cliente'), false);
    assert.ok((await service.validarSenhaProtecao('editar_cliente', 'nova-cliente')).token);
    assert.equal(await service.protecaoAtiva('excluir_cliente'), true);
    await service.alterarEstado('editar_cliente', { ativo: true });
    await rejeita(service.autorizar('editar_cliente'), 401);
  });
  await t.test('tokens expiram e tentativas erradas são limitadas', async () => {
    const curto = criarSegurancaService({ dbPath, tokenTtlMs: -1 });
    try {
      const token = await curto.validarSenhaProtecao('editar_cliente', 'nova-cliente');
      await rejeita(curto.autorizar('editar_cliente', token.token), 401);
      for (let i = 0; i < 8; i++) await rejeita(curto.validarSenhaProtecao('excluir_cliente', 'errada'), 401);
      await rejeita(curto.validarSenhaProtecao('excluir_cliente', 'errada'), 429);
      const paralelas = await Promise.allSettled(Array.from({ length: 12 }, () => curto.validarSenhaProtecao('editar_emprestimo', 'errada')));
      assert.equal(paralelas.filter(p => p.reason?.status === 401).length, 8);
      assert.equal(paralelas.filter(p => p.reason?.status === 429).length, 4);
    } finally { await curto.fechar(); }
  });
  await t.test('sem senha conhecida: definir antes de ligar, rejeitar vazio e confirmação diferente', async () => {
    const novo = criarSegurancaService({ dbPath: path.join(root, 'sem-legado.db'), senhasLegadas: {} });
    try {
      assert.ok((await novo.listar()).every(p => !p.ativo && !p.temSenha));
      await rejeita(novo.alterarEstado('editar_cliente', { ativo: true }), 409);
      await rejeita(novo.definirSenha('editar_cliente', { novaSenha: '', confirmacao: '' }), 400);
      await rejeita(novo.definirSenha('editar_cliente', { novaSenha: 'nova', confirmacao: 'outra' }), 400);
      const item = await novo.definirSenha('editar_cliente', { novaSenha: 'nova', confirmacao: 'nova', ativar: true });
      assert.equal(item.ativo, true);
      assert.equal(item.temSenha, true);
      assert.ok((await novo.validarSenhaProtecao('editar_cliente', 'nova')).token);
      await rejeita(novo.estado('chave_inventada'), 404);
      await rejeita(novo.alterarEstado('editar_cliente', { ativo: 'false' }), 400);
    } finally { await novo.fechar(); }
  });
  await t.test('ADMIN_PASSWORD migra apenas os quatro consumidores administrativos', async () => {
    const anterior = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = 'admin-teste';
    const admin = criarSegurancaService({ dbPath: path.join(root, 'admin.db') });
    try {
      await admin.inicializar();
      for (const [key, , administrativa] of PROTECOES) {
        assert.ok((await admin.validarSenhaProtecao(key, administrativa ? 'admin-teste' : '1otimodia')).token);
        await rejeita(admin.validarSenhaProtecao(key, administrativa ? '1otimodia' : 'admin-teste'), 401);
      }
    } finally {
      await admin.fechar();
      if (anterior === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = anterior;
    }
  });
  await t.test('senha legada inválida para migração para com erro, sem inventar senha ou desligar proteção', async () => {
    const anterior = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = '   ';
    const invalido = criarSegurancaService({ dbPath: path.join(root, 'admin-invalido.db') });
    try {
      await rejeita(invalido.inicializar(), 503);
      const reader = new sqlite3.Database(path.join(root, 'admin-invalido.db'));
      try { assert.deepEqual(await all(reader, 'SELECT * FROM seguranca_protecoes'), []); }
      finally { await close(reader); }
    } finally {
      await invalido.fechar();
      if (anterior === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = anterior;
    }
  });
});

test('oito endpoints reais: ON correto permite, ON errado bloqueia e OFF prossegue sem senha', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seguranca-rotas-'));
  process.env.APP_DATA_DIR = root;
  const db = require('../models/database');
  const service = getSegurancaService();
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await service.fechar(); await db.closeConnection();
    fs.rmSync(root, { recursive: true, force: true });
  });
  // O bootstrap existente enfileira schema/migrations; aguardar sem alterar código financeiro.
  let pronto = false;
  for (let i = 0; i < 100; i++) {
    const columns = await all(db, 'PRAGMA table_info(clientes)');
    if (columns.some(c => c.name === 'motivo_notificacoes_cobranca')) { pronto = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pronto, 'Schema temporário pronto');
  await require('../models/migrations').runMigrations();
  await exec(db, `INSERT INTO clientes(id,nome) VALUES(1,'Teste');
    INSERT INTO emprestimos(id,cliente_id,versao_atual) VALUES(1,1,2);
    INSERT INTO parcelas(id,emprestimo_id,numero,pago,valor_pago,versao) VALUES
      (1,1,1,0,0,2),(2,1,2,0,0,2),(3,1,0,0,0,1),(4,1,-1,0,0,2);`);
  await service.inicializar();
  const app = express();
  app.use(express.json());
  app.use('/seguranca', criarSegurancaRouter(service));
  const clientes = require('../routes/cliente');
  const emprestimos = require('../routes/emprestimo');
  const parcelas = require('../routes/parcelas');
  const caixa = require('../routes/caixa');
  const sistema = require('../routes/sistema');
  let operacoes = 0;
  const flows = [
    ['editar_cliente', clientes, '/:id', 'put', '/clientes/1'],
    ['excluir_cliente', clientes, '/:id', 'delete', '/clientes/1'],
    ['editar_emprestimo', emprestimos, '/:id', 'put', '/emprestimos/1'],
    ['excluir_emprestimo', emprestimos, '/:id', 'delete', '/emprestimos/1'],
    ['excluir_todos_emprestimos', emprestimos, '/reset-all', 'post', '/emprestimos/reset-all'],
    ['adicionar_juros_parcela', parcelas, '/:id/juros-adicionais', 'post', '/parcelas/2/juros-adicionais'],
    ['excluir_despesa', caixa, '/despesa/:id', 'delete', '/caixa/despesa/1'],
    ['apagar_todos_dados', sistema, '/excluir-tudo', 'post', '/sistema/excluir-tudo'],
  ];
  let executorPurge;
  // Substitui SOMENTE o executor destrutivo; mantém o middleware da rota real.
  for (const [key, router, routePath, method] of flows) {
    const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route;
    assert.ok(route.stack.length > 1, `${key} precisa da proteção no servidor`);
    if (key === 'apagar_todos_dados') executorPurge = route.stack.at(-1).handle;
    route.stack.at(-1).handle = (_req, res) => { operacoes++; res.json({ permitido: key }); };
  }
  parcelas.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.put).route.stack.at(-1).handle = (_req, res) => res.json({ permitido: 'update-parcela' });
  app.use('/clientes', clientes); app.use('/emprestimos', emprestimos);
  app.use('/parcelas', parcelas); app.use('/caixa', caixa); app.use('/sistema', sistema);
  server = await abrirServidor(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = 'GET', body, token) => {
    const response = await fetch(`${base}${url}`, { method: method.toUpperCase(), headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Protecao-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cache: response.headers.get('Cache-Control') };
  };
  await t.test('API lista exatamente oito itens sem hash, com no-store', async () => {
    const response = await request('/seguranca/protecoes');
    assert.equal(response.status, 200); assert.equal(response.data.length, 8);
    assert.equal(response.cache, 'no-store'); assert.ok(response.data.every(p => !p.senha_hash));
  });
  for (const [key, , , method, url] of flows) {
    await t.test(key, async () => {
      const legada = PROTECOES.find(([k]) => k === key)[2] ? process.env.ADMIN_PASSWORD || '1otimodia' : '1otimodia';
      const senha = `nova-${key}-teste`;
      const alterada = await request(`/seguranca/protecoes/${key}/senha`, 'PUT', { senhaAtual: legada, novaSenha: senha, confirmacao: senha });
      assert.equal(alterada.status, 200);
      const antes = operacoes;
      assert.equal((await request(url, method, {})).status, 401);
      assert.equal((await request(url, method, { password: 'errada' })).status, 401);
      assert.equal((await request(url, method, { password: legada })).status, 401);
      const invalida = await request(`/seguranca/protecoes/${key}/validar`, 'POST', { senha: 'errada' });
      assert.equal(invalida.status, 401); assert.equal(operacoes, antes);
      const autorizada = await request(`/seguranca/protecoes/${key}/validar`, 'POST', { senha });
      assert.equal(autorizada.status, 200);
      assert.equal((await request(url, method, {}, autorizada.data.token)).status, 200);
      assert.equal(operacoes, antes + 1);
      assert.equal((await request(`/seguranca/protecoes/${key}/estado`, 'PUT', { ativo: false, senhaAtual: 'errada' })).status, 401);
      assert.equal(await service.protecaoAtiva(key), true);
      assert.equal((await request(`/seguranca/protecoes/${key}/estado`, 'PUT', { ativo: false, senhaAtual: senha })).status, 200);
      assert.equal((await request(url, method, {})).status, 200);
      assert.equal(operacoes, antes + 2);
      await service.alterarEstado(key, { ativo: true });
      assert.equal((await request(url, method, {}, autorizada.data.token)).status, 401);
    });
  }
  await t.test('purge preserva confirmação da frase mesmo OFF; nunca executa exclusão no teste', async () => {
    app.post('/purge-frase-teste', exigirProtecao('apagar_todos_dados', { service }), executorPurge);
    await service.alterarEstado('apagar_todos_dados', { ativo: false, senhaAtual: 'nova-apagar_todos_dados-teste' });
    const response = await request('/purge-frase-teste', 'POST', { confirmation: 'NÃO EXCLUIR' });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /EXCLUIR TUDO/);
    await service.alterarEstado('apagar_todos_dados', { ativo: true });
  });
  await t.test('juros atuais não pedem senha; futuras e acessos diretos pedem, incluindo versões antigas', async () => {
    assert.equal(await jurosExigemProtecao(1, db), false);
    assert.equal(await jurosExigemProtecao(2, db), true);
    assert.equal(await jurosExigemProtecao(3, db), true);
    assert.equal(await jurosExigemProtecao(4, db), true);
    assert.equal((await request('/parcelas/1/juros-adicionais', 'POST', {})).status, 200);
    assert.equal((await request('/parcelas/2/juros-adicionais', 'POST', {})).status, 401);
    assert.equal((await request('/parcelas/2', 'PUT', { juros_adicionais: 10 })).status, 401, 'PUT alternativo não contorna a senha');
    assert.equal((await request('/parcelas/2', 'PUT', { vencimento: '2026-09-20' })).status, 200, 'Vencimento continua sem proteção adicional');
    await service.alterarEstado('adicionar_juros_parcela', { ativo: false, senhaAtual: 'nova-adicionar_juros_parcela-teste' });
    assert.equal((await request('/parcelas/2', 'PUT', { juros_adicionais: 10 })).status, 200);
    await service.alterarEstado('adicionar_juros_parcela', { ativo: true });
    assert.equal((await request('/seguranca/protecoes/adicionar_juros_parcela?parcelaId=1')).data.exigida, false);
    assert.equal((await request('/seguranca/protecoes/adicionar_juros_parcela?parcelaId=2')).data.exigida, true);
    assert.equal((await request('/seguranca/protecoes/adicionar_juros_parcela?parcelaId=abc')).status, 400);
    await rejeita(jurosExigemProtecao(999, db), 404);
    // Nenhuma exclusão ocorreu: os executores foram substituídos por spies.
    assert.equal((await all(db, 'SELECT * FROM clientes')).length, 1);
    assert.equal((await all(db, 'SELECT * FROM emprestimos')).length, 1);
    assert.equal((await all(db, 'SELECT * FROM parcelas')).length, 4);
  });
});

test('falha na camada de segurança bloqueia antes do executor', async () => {
  let nextChamado = false;
  let status;
  let payload;
  const middleware = exigirProtecao('editar_cliente', { service: { autorizar: async () => { throw new Error('SQLite indisponível'); } } });
  await middleware({ get: () => undefined, body: {} }, { status: value => { status = value; return { json: data => { payload = data; } }; } }, () => { nextChamado = true; });
  assert.equal(status, 503); assert.equal(nextChamado, false); assert.match(payload.error, /bloqueada/);
});
