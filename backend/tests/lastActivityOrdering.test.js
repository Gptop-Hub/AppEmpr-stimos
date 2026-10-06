const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emprestimos-last-activity-'));
process.env.APP_DATA_DIR = tempDir;

const db = require('../models/database');
const pagamentoRouter = require('../routes/pagamento');
const parcelasRouter = require('../routes/parcelas');
const emprestimosRouter = require('../routes/emprestimo');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function criarCenario() {
  await run('DELETE FROM pagamentos');
  await run('DELETE FROM parcelas');
  await run('DELETE FROM emprestimos');
  await run('DELETE FROM clientes');

  const clientes = [];
  for (const nome of ['Ana', 'Bruno', 'Carla']) {
    const result = await run('INSERT INTO clientes (nome, criadoEm) VALUES (?, ?)', [nome, '2020-01-01']);
    clientes.push({ id: result.lastID, nome });
  }

  const criarEmprestimo = async (clienteId, activity) => {
    const result = await run(
      `INSERT INTO emprestimos
        (cliente_id, modalidade, valor, capital_restante, versao_atual, last_activity_at)
       VALUES (?, 'parcelado', 110, 100, 1, ?)`,
      [clienteId, activity]
    );
    const parcela = await run(
      `INSERT INTO parcelas
        (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, versao)
       VALUES (?, 1, 110, 100, 10, '2026-10-10', 0, 1)`,
      [result.lastID]
    );
    return { id: result.lastID, parcelaId: parcela.lastID };
  };

  const emprestimoA = await criarEmprestimo(clientes[0].id, '2026-01-01T10:00:00.000Z');
  const emprestimoB1 = await criarEmprestimo(clientes[1].id, '2026-02-01T10:00:00.000Z');
  const emprestimoB2 = await criarEmprestimo(clientes[1].id, '2026-01-15T10:00:00.000Z');
  const emprestimoC = await criarEmprestimo(clientes[2].id, '2026-03-01T10:00:00.000Z');

  // A atividade do cadastro do cliente não participa de “Último trabalhado”.
  await run("UPDATE clientes SET last_activity_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [clientes[0].id]);

  return { clientes, emprestimoA, emprestimoB1, emprestimoB2, emprestimoC };
}

async function clientesComEmprestimos() {
  const clientes = await all('SELECT id, nome, last_activity_at FROM clientes ORDER BY id');
  const emprestimos = await all('SELECT id, cliente_id, last_activity_at FROM emprestimos ORDER BY id');
  return clientes.map((cliente) => ({
    ...cliente,
    emprestimos: emprestimos.filter((emprestimo) => Number(emprestimo.cliente_id) === Number(cliente.id)),
  }));
}

async function iniciarServidor() {
  const app = express();
  app.use(express.json());
  app.use('/pagamentos', pagamentoRouter);
  app.use('/parcelas', parcelasRouter);
  app.use('/emprestimos', emprestimosRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test.after(async () => {
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Último trabalhado usa a maior atividade persistida entre todos os empréstimos do cliente', async () => {
  const { compareClientesByLastActivity } = await import(
    pathToFileURL(path.resolve(__dirname, '../../frontend/src/componentes/Emprestimos/lastActivityOrder.js')).href
  );
  const { clientes, emprestimoA, emprestimoB1, emprestimoC } = await criarCenario();
  const server = await iniciarServidor();
  const { port } = server.address();

  try {
    const ordenar = async () => (await clientesComEmprestimos())
      .sort(compareClientesByLastActivity)
      .map((cliente) => cliente.nome);

    assert.deepEqual(await ordenar(), ['Carla', 'Bruno', 'Ana']);

    // Teste 1: a criação real via API registra a atividade já no novo
    // empréstimo e move Ana ao topo, sem depender de estado do React.
    const criacao = await fetch(`http://127.0.0.1:${port}/emprestimos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cliente_id: clientes[0].id,
        valor: 1000.5,
        data: '2026-09-24',
        modalidade: 'parcelado',
        parcelas: 2,
        taxa_juros: 10,
        data_pagamento: '2026-10-24',
      }),
    });
    assert.equal(criacao.status, 200, await criacao.text());
    assert.deepEqual(await ordenar(), ['Ana', 'Carla', 'Bruno']);

    // Teste 2: pagamento em um empréstimo de Bruno o leva ao topo.
    const pagamento = await fetch(`http://127.0.0.1:${port}/pagamentos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emprestimo_id: emprestimoB1.id, valor: 110, data: '2026-09-24' }),
    });
    assert.equal(pagamento.status, 200, await pagamento.text());
    assert.deepEqual(await ordenar(), ['Bruno', 'Ana', 'Carla']);

    // Teste 3: uma simples leitura não altera a atividade de Ana.
    const atividadeAnaAntes = await get('SELECT last_activity_at FROM emprestimos WHERE id = ?', [emprestimoA.id]);
    const leitura = await fetch(`http://127.0.0.1:${port}/emprestimos/${emprestimoA.id}`);
    assert.equal(leitura.status, 200, await leitura.text());
    const atividadeAnaDepois = await get('SELECT last_activity_at FROM emprestimos WHERE id = ?', [emprestimoA.id]);
    assert.equal(atividadeAnaDepois.last_activity_at, atividadeAnaAntes.last_activity_at);

    // Teste 4: alteração persistente de vencimento de Carla passa Bruno.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const vencimento = await fetch(`http://127.0.0.1:${port}/parcelas/${emprestimoC.parcelaId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vencimento: '2026-11-10' }),
    });
    assert.equal(vencimento.status, 200, await vencimento.text());
    assert.deepEqual(await ordenar(), ['Carla', 'Bruno', 'Ana']);

    // Testes 4 e 5: Bruno tem vários empréstimos; a ação em apenas um deles
    // determinou a posição do cliente inteiro e a nova consulta preserva a ordem.
    const recarregado = await clientesComEmprestimos();
    const bruno = recarregado.find((cliente) => cliente.id === clientes[1].id);
    assert.equal(bruno.emprestimos.length, 2);
    assert.deepEqual(recarregado.sort(compareClientesByLastActivity).map((cliente) => cliente.nome), ['Carla', 'Bruno', 'Ana']);

    // Empate usa ID crescente de forma estável, sem inventar atividade.
    assert.ok(compareClientesByLastActivity({ id: 10 }, { id: 11 }) < 0);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
