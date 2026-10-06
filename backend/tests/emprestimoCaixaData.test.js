const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emprestimos-caixa-data-'));
process.env.APP_DATA_DIR = tempDir;

const db = require('../models/database');
const emprestimosRouter = require('../routes/emprestimo');
const fluxoCaixaRouter = require('../routes/fluxoCaixa');

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

async function iniciarServidor() {
  const app = express();
  app.use(express.json());
  app.use('/emprestimos', emprestimosRouter);
  app.use('/fluxo-caixa', fluxoCaixaRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test.after(async () => {
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('saída do empréstimo usa a data contratual no Fluxo de Caixa', async () => {
  const cliente = await run("INSERT INTO clientes (nome) VALUES ('Cliente de teste')");
  const server = await iniciarServidor();
  const { port } = server.address();

  try {
    const resposta = await fetch(`http://127.0.0.1:${port}/emprestimos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cliente_id: cliente.lastID,
        valor: 1000,
        data: '2026-02-20',
        modalidade: 'parcelado',
        parcelas: 2,
        taxa_juros: 10,
        data_pagamento: '2026-03-20',
      }),
    });

    if (resposta.status !== 200) {
      assert.fail(await resposta.text());
    }
    const emprestimo = await resposta.json();
    const movimento = await get(
      `SELECT data, cliente_id, emprestimo_id, tipo, categoria,
              valor_emprestimo, descricao
         FROM caixa_movimentos
        WHERE emprestimo_id = ?`,
      [emprestimo.id]
    );

    assert.deepEqual(movimento, {
      data: '2026-02-20',
      cliente_id: cliente.lastID,
      emprestimo_id: emprestimo.id,
      tipo: 'SAIDA',
      categoria: 'EMPRESTIMO',
      valor_emprestimo: 1000,
      descricao: 'Emprestimo concedido',
    });

    const fevereiro = await fetch(
      `http://127.0.0.1:${port}/fluxo-caixa/linhas?periodo=custom&de=2026-02-01&ate=2026-02-28`
    );
    const linhas = await fevereiro.json();
    assert.ok(linhas.linhas.some((linha) => linha.emprestimo_id === emprestimo.id));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
