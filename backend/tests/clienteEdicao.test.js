const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));

test('edição de clientes, banco antigo restaurado e troca segura de ID', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliente-edicao-'));
  process.env.APP_DATA_DIR = tempDir;
  const dbFile = path.join(tempDir, 'emprestimos-data', 'database.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const seed = new sqlite3.Database(dbFile);
  await exec(seed, `CREATE TABLE clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, cpf TEXT, telefone TEXT,
    endereco TEXT, trabalho TEXT, categoria_trabalho TEXT, mal_pagador INTEGER DEFAULT 0,
    foto_cliente TEXT, referencia TEXT, observacao TEXT, criadoEm TEXT);
    INSERT INTO clientes(id,nome,cpf,telefone,criadoEm) VALUES(15,'Cliente antigo','11122233344','(64) 99999-8888','2026-01-01');
    PRAGMA user_version = 1;`);
  await assert.rejects(exec(seed, "UPDATE clientes SET nome='Novo nome', receber_notificacoes_cobranca=1 WHERE id=15"), /no such column/);
  await close(seed);

  const db = require('../models/database');
  t.after(async () => {
    await require('../services/segurancaService').getSegurancaService().fechar();
    await db.closeConnection();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  async function esperarSchema() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const columns = await all(db, 'PRAGMA table_info(clientes)');
      if (['receber_notificacoes_cobranca', 'motivo_notificacoes_cobranca'].every(name => columns.some(c => c.name === name))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('As migrations de clientes não terminaram');
  }
  await esperarSchema();
  assert.equal((await all(db, 'SELECT nome FROM clientes WHERE id=15'))[0].nome, 'Cliente antigo');
  const { runMigrations } = require('../models/migrations');
  await runMigrations();

  const app = express();
  app.use(express.json());
  app.use('/clientes', require('../routes/cliente'));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/clientes`;
  const payload = {
    id: 15, nome: 'Cliente A', cpf: '11122233344', telefone: '(64) 99999-8888',
    endereco: 'Rua: Um, Nº: 1, Bairro: Centro, Cidade: Teste', trabalho: 'Empresa: Exemplo',
    categoria_trabalho: 'Serviços', referencia: 'Referência', observacao: 'Observação',
    criadoEm: '2026-01-01', receber_notificacoes_cobranca: false, motivo_notificacoes_cobranca: 'Motivo',
  };
  const put = async (changes = {}, id = 15) => {
    const response = await fetch(`${baseUrl}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...changes, password: '1otimodia' }) });
    return { status: response.status, data: await response.json() };
  };
  async function fixture() {
    await exec(db, `DELETE FROM clientes_telefones; DELETE FROM pagamentos; DELETE FROM renegociacoes_historico;
      DELETE FROM caixa_movimentos; DELETE FROM notificacoes; DELETE FROM parcelas_originais;
      DELETE FROM parcelas; DELETE FROM emprestimos; DELETE FROM clientes;
      INSERT INTO clientes(id,nome,cpf,telefone,criadoEm) VALUES
        (15,'Cliente A','11122233344','(64) 99999-8888','2026-01-01'),
        (25,'Cliente B','55566677788','(64) 98888-7777','2026-01-01');
      INSERT INTO emprestimos(id,cliente_id,codigo_cliente,valor,capital_restante) VALUES
        (101,15,'15-1',500,300),(102,15,'15-2',700,450),(103,25,'25-1',900,600);
      INSERT INTO parcelas(id,emprestimo_id,numero,valor_total,valor_capital,valor_juros,pago) VALUES(201,101,1,110,100,10,1);
      INSERT INTO pagamentos(id,emprestimo_id,valor,tipo_pagamento) VALUES(301,101,110,'normal');
      INSERT INTO clientes_telefones(cliente_id,telefone) VALUES(15,'(64) 97777-6666');
      INSERT INTO caixa_movimentos(id,tipo,categoria,data,cliente_id,emprestimo_id,valor_total,valor_juros,valor_capital)
        VALUES(401,'ENTRADA','PAGAMENTO','2026-01-02',15,101,110,10,100);
      INSERT INTO renegociacoes_historico(emprestimo_id,versao,snapshot_emprestimo,snapshot_parcelas) VALUES(101,1,'{"cliente_id":15}','[]');
      INSERT INTO notificacoes(tipo,titulo,mensagem,data_referencia,emprestimo_id,parcela_id) VALUES('teste','Teste','Teste','2026-01-02',101,201);`);
  }
  async function snapshot() {
    const result = {};
    for (const table of ['clientes','emprestimos','parcelas','pagamentos','clientes_telefones','caixa_movimentos','renegociacoes_historico','notificacoes']) {
      result[table] = await all(db, `SELECT * FROM ${table} ORDER BY id`);
    }
    return result;
  }
  const integrity = async () => assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);

  await t.test('banco antigo migrado: todos os campos editáveis e opcionais', async () => {
    await fixture();
    for (const [field, value] of Object.entries({ nome: 'Novo nome', telefone: '(64) 91234-5678', endereco: 'Novo endereço', trabalho: 'Novo trabalho', categoria_trabalho: 'Nova categoria', referencia: 'Nova referência', observacao: 'Nova observação', criadoEm: '2025-12-01', motivo_notificacoes_cobranca: 'Novo motivo', mal_pagador: true, cpf: '12345678901' })) {
      const result = await put({ [field]: value });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data[field], field === 'mal_pagador' ? 1 : value);
    }
    const result = await put({ nome: 'Vários campos', telefone: '(64) 98888-1234', observacao: '', referencia: '', motivo_notificacoes_cobranca: '' });
    assert.equal(result.status, 200);
    assert.equal(result.data.nome, 'Vários campos');
    assert.equal(result.data.referencia, '');
    assert.equal(result.data.motivo_notificacoes_cobranca, null);
    await integrity();
    assert.equal((await put({ id: 25, cpf: '55566677788' }, 25)).status, 200);
  });
  await t.test('ID livre + nome: vínculos e valores financeiros preservados', async () => {
    await fixture();
    const before = await snapshot();
    const result = await put({ id: 40, nome: 'Mesmo cliente atualizado' });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.id, 40);
    assert.equal(result.data.nome, 'Mesmo cliente atualizado');
    const after = await snapshot();
    assert.equal(after.clientes.length, 2);
    assert.equal(after.emprestimos.length, before.emprestimos.length);
    assert.deepEqual(after.emprestimos.filter(e => e.cliente_id === 40).map(e => e.codigo_cliente), ['40-1','40-2']);
    for (const table of ['caixa_movimentos','clientes_telefones']) assert.equal(after[table][0].cliente_id, 40);
    for (const table of ['parcelas','pagamentos','renegociacoes_historico','notificacoes']) assert.deepEqual(after[table], before[table]);
    assert.deepEqual(after.caixa_movimentos.map(({cliente_id,...rest}) => rest), before.caixa_movimentos.map(({cliente_id,...rest}) => rest));
    assert.deepEqual(after.emprestimos.map(({cliente_id,codigo_cliente,...rest}) => rest), before.emprestimos.map(({cliente_id,codigo_cliente,...rest}) => rest));
    await integrity();
  });
  await t.test('ID ocupado, ID mantido e formatos inválidos', async () => {
    await fixture();
    const before = await snapshot();
    const conflict = await put({ id: 25, nome: 'Não deve salvar' });
    assert.equal(conflict.status, 409);
    assert.match(conflict.data.error, /ID 25/);
    assert.deepEqual(await snapshot(), before);
    for (const id of ['',0,-1,1.5,'15x',true,Number.MAX_SAFE_INTEGER + 1]) assert.equal((await put({ id })).status, 400);
    assert.equal((await put({ id: 15, nome: 'ID mantido' })).status, 200);
    await integrity();
  });
  await t.test('falha nas referências causa rollback completo', async () => {
    await fixture();
    const before = await snapshot();
    await exec(db, "CREATE TRIGGER falha_cliente BEFORE UPDATE OF cliente_id ON caixa_movimentos BEGIN SELECT RAISE(ABORT, 'Falha simulada'); END;");
    try {
      assert.equal((await put({ id: 40, nome: 'Não deve salvar' })).status, 500);
      assert.deepEqual(await snapshot(), before);
      await integrity();
    } finally { await exec(db, 'DROP TRIGGER falha_cliente'); }
  });
  await t.test('duas edições concorrentes não conseguem ocupar o mesmo ID', async () => {
    await fixture();
    const results = await Promise.all([
      put({ id: 40, nome: 'Cliente A atualizado' }),
      put({ id: 40, nome: 'Cliente B atualizado', cpf: '55566677788' }, 25),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
    const winner = results.findIndex(r => r.status === 200);
    const loserId = winner === 0 ? 25 : 15;
    const clients = await all(db, 'SELECT id,nome FROM clientes ORDER BY id');
    assert.equal(clients.length, 2);
    assert.equal(clients.filter(c => c.id === 40).length, 1);
    assert.equal(clients.find(c => c.id === loserId).nome, winner === 0 ? 'Cliente B' : 'Cliente A');
    await integrity();
  });
  await t.test('fotos: adicionar, trocar, editar dados e mudar ID com foto', async () => {
    await fixture();
    const photoDir = require('../utils/paths').getClientPhotosDir();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9QAAAABJRU5ErkJggg==', 'base64');
    const upload = async id => {
      const form = new FormData();
      form.append('foto', new Blob([png], { type: 'image/png' }), 'foto.png');
      const response = await fetch(`${baseUrl}/${id}/foto`, { method: 'POST', body: form });
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await upload(15);
    assert.ok(fs.existsSync(path.join(photoDir, first.foto_cliente)));
    const edited = await put({ nome: 'Cliente com foto' });
    assert.equal(edited.data.foto_cliente, first.foto_cliente);
    const renamed = await put({ id: 40 });
    assert.equal(renamed.data.foto_cliente, first.foto_cliente);
    assert.equal((await fetch(`${baseUrl}/40/foto`)).status, 200);
    const second = await upload(renamed.data.id);
    assert.ok(!fs.existsSync(path.join(photoDir, first.foto_cliente)));
    assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}/40/foto`)).arrayBuffer()), png);
    const third = await upload(40); // Mesma rota usada pelo menu alternativo.
    assert.ok(!fs.existsSync(path.join(photoDir, second.foto_cliente)));
    assert.ok(fs.existsSync(path.join(photoDir, third.foto_cliente)));
    await integrity();
  });
  await t.test('reabrir banco antigo restaurado aplica migrations de forma idempotente', async () => {
    await db.closeConnection();
    const old = new sqlite3.Database(dbFile);
    await exec(old, 'ALTER TABLE clientes DROP COLUMN receber_notificacoes_cobranca; ALTER TABLE clientes DROP COLUMN motivo_notificacoes_cobranca;');
    await close(old);
    await db.reopenConnection();
    await esperarSchema();
    const before = await snapshot();
    await db.reopenConnection();
    await esperarSchema();
    await runMigrations();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await put({ id: 40, nome: 'Após restauração' }, 40)).status, 200);
    await integrity();
  });
});
