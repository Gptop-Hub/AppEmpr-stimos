const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emprestimos-juros-parcial-'));
process.env.APP_DATA_DIR = tempDir;

const db = require('../models/database');
const pagamentoRouter = require('../routes/pagamento');

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

async function criarCenario({ incluirTerceira = false } = {}) {
  await run('DELETE FROM caixa_movimentos');
  await run('DELETE FROM pagamentos');
  await run('DELETE FROM parcelas');
  await run('DELETE FROM emprestimos');

  const emprestimo = await run(
    `INSERT INTO emprestimos (modalidade, valor, capital_restante, versao_atual)
     VALUES ('parcelado', ?, ?, 1)`,
    [incluirTerceira ? 1500 : 1000, 1000]
  );
  const emprestimoId = emprestimo.lastID;

  // Cenário solicitado: empréstimo de R$ 1.000,00 em duas parcelas, com o
  // primeiro vencimento em 31/01/2026 já quitado.
  await run(
    `INSERT INTO parcelas
      (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, versao)
     VALUES (?, 1, 550, 500, 50, '2026-01-31', 1, 1),
            (?, 2, 550, 500, 50, '2026-02-28', 0, 1)`,
    [emprestimoId, emprestimoId]
  );

  if (incluirTerceira) {
    await run(
      `INSERT INTO parcelas
        (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, versao)
       VALUES (?, 3, 550, 500, 50, '2026-03-31', 0, 1)`,
      [emprestimoId]
    );
  }
  return emprestimoId;
}

async function criarCronograma(datas, { parcelasPagas = 0 } = {}) {
  await run('DELETE FROM caixa_movimentos');
  await run('DELETE FROM pagamentos');
  await run('DELETE FROM parcelas');
  await run('DELETE FROM emprestimos');

  const abertas = datas.length - parcelasPagas;
  const emprestimo = await run(
    `INSERT INTO emprestimos (modalidade, valor, capital_restante, versao_atual)
     VALUES ('parcelado', ?, ?, 1)`,
    [datas.length * 500, abertas * 500]
  );
  const emprestimoId = emprestimo.lastID;

  for (let indice = 0; indice < datas.length; indice += 1) {
    await run(
      `INSERT INTO parcelas
        (emprestimo_id, numero, valor_total, valor_capital, valor_juros, vencimento, pago, versao)
       VALUES (?, ?, 550, 500, 50, ?, ?, 1)`,
      [emprestimoId, indice + 1, datas[indice], indice < parcelasPagas ? 1 : 0]
    );
  }
  return emprestimoId;
}

async function iniciarServidor() {
  const app = express();
  app.use(express.json());
  app.use('/pagamentos', pagamentoRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return server;
}

async function registrarJurosParcial(server, emprestimoId, proximoVencimento) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}/pagamentos/manual-juros-parcial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      emprestimoId,
      valorPagamento: 20,
      dataPagamento: '2026-02-15',
      proximoVencimento,
    }),
  });
}

test.after(async () => {
  await db.closeConnection();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('pagamento parcial desloca parcelas posteriores em cascata', async () => {
  const emprestimoId = await criarCenario({ incluirTerceira: true });
  const server = await iniciarServidor();
  const { port } = server.address();

  try {
    const resposta = await fetch(`http://127.0.0.1:${port}/pagamentos/manual-juros-parcial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        emprestimoId,
        valorPagamento: 20,
        dataPagamento: '2026-02-15',
        proximoVencimento: '2026-03-28',
        parcela_numero: 2,
      }),
    });

    assert.equal(resposta.status, 200, await resposta.text());
    const terceira = await get('SELECT vencimento FROM parcelas WHERE emprestimo_id = ? AND numero = 3', [emprestimoId]);
    assert.equal(terceira.vencimento, '2026-04-28');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('cascata mensal usa a data escolhida como âncora no cronograma de dia 25', async () => {
  const emprestimoId = await criarCronograma([
    '2026-11-25',
    '2026-12-25',
    '2027-01-25',
    '2027-02-25',
  ]);
  const server = await iniciarServidor();

  try {
    const resposta = await registrarJurosParcial(server, emprestimoId, '2026-12-25');
    assert.equal(resposta.status, 200, await resposta.text());
    const parcelas = await new Promise((resolve, reject) => {
      db.all('SELECT vencimento FROM parcelas WHERE emprestimo_id = ? ORDER BY numero', [emprestimoId], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    assert.deepEqual(parcelas.map((parcela) => parcela.vencimento), [
      '2026-12-25',
      '2027-01-25',
      '2027-02-25',
      '2027-03-25',
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('cascata mensal mantém o cronograma de dia 15', async () => {
  const emprestimoId = await criarCronograma([
    '2026-05-15',
    '2026-06-15',
    '2026-07-15',
    '2026-08-15',
  ]);
  const server = await iniciarServidor();

  try {
    const resposta = await registrarJurosParcial(server, emprestimoId, '2026-06-15');
    assert.equal(resposta.status, 200, await resposta.text());
    const parcelas = await new Promise((resolve, reject) => {
      db.all('SELECT vencimento FROM parcelas WHERE emprestimo_id = ? ORDER BY numero', [emprestimoId], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    assert.deepEqual(parcelas.map((parcela) => parcela.vencimento), [
      '2026-06-15',
      '2026-07-15',
      '2026-08-15',
      '2026-09-15',
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('cascata de dia 31 usa datas válidas e não duplica parcelas abertas', async () => {
  const emprestimoId = await criarCronograma([
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
  const server = await iniciarServidor();

  try {
    const resposta = await registrarJurosParcial(server, emprestimoId, '2026-01-31');
    assert.equal(resposta.status, 200, await resposta.text());
    const parcelas = await new Promise((resolve, reject) => {
      db.all('SELECT vencimento FROM parcelas WHERE emprestimo_id = ? ORDER BY numero', [emprestimoId], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    const vencimentos = parcelas.map((parcela) => parcela.vencimento);
    assert.deepEqual(vencimentos, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    assert.equal(new Set(vencimentos).size, vencimentos.length);
    assert.ok(vencimentos.every((data) => /^\d{4}-\d{2}-\d{2}$/.test(data)));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('cascata não move parcelas já pagas', async () => {
  const emprestimoId = await criarCronograma(
    ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15'],
    { parcelasPagas: 1 }
  );
  const server = await iniciarServidor();

  try {
    const resposta = await registrarJurosParcial(server, emprestimoId, '2026-07-15');
    assert.equal(resposta.status, 200, await resposta.text());
    const parcelas = await new Promise((resolve, reject) => {
      db.all('SELECT vencimento FROM parcelas WHERE emprestimo_id = ? ORDER BY numero', [emprestimoId], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    assert.deepEqual(parcelas.map((parcela) => parcela.vencimento), [
      '2026-05-15',
      '2026-07-15',
      '2026-08-15',
      '2026-09-15',
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('cascata altera somente datas e preserva a matemática financeira', async () => {
  const emprestimoId = await criarCronograma([
    '2026-11-25',
    '2026-12-25',
    '2027-01-25',
  ]);
  const antes = await new Promise((resolve, reject) => {
    db.all(
      `SELECT numero, valor_capital, valor_juros, juros_pendentes, juros_adicionais, valor_total, valor_pago
         FROM parcelas WHERE emprestimo_id = ? ORDER BY numero`,
      [emprestimoId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
  const emprestimoAntes = await get('SELECT capital_restante FROM emprestimos WHERE id = ?', [emprestimoId]);
  const server = await iniciarServidor();

  try {
    const resposta = await registrarJurosParcial(server, emprestimoId, '2026-12-25');
    assert.equal(resposta.status, 200, await resposta.text());
    const depois = await new Promise((resolve, reject) => {
      db.all(
        `SELECT numero, valor_capital, valor_juros, juros_pendentes, juros_adicionais, valor_total, valor_pago
           FROM parcelas WHERE emprestimo_id = ? ORDER BY numero`,
        [emprestimoId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    const emprestimoDepois = await get('SELECT capital_restante FROM emprestimos WHERE id = ?', [emprestimoId]);
    const pagamento = await get('SELECT valor FROM pagamentos WHERE emprestimo_id = ?', [emprestimoId]);
    const caixa = await get('SELECT valor_total FROM caixa_movimentos WHERE emprestimo_id = ?', [emprestimoId]);

    assert.deepEqual(depois.slice(1), antes.slice(1));
    assert.equal(depois[0].valor_capital, antes[0].valor_capital);
    assert.equal(depois[0].valor_juros, antes[0].valor_juros);
    assert.equal(depois[0].juros_pendentes, 30);
    assert.equal(depois[0].valor_total, 580);
    assert.equal(emprestimoDepois.capital_restante, emprestimoAntes.capital_restante);
    assert.equal(pagamento.valor, 20);
    assert.equal(caixa.valor_total, 20);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

for (const proximoVencimento of ['2026-03-31', '2026-03-28']) {
  test(`pagamento parcial persiste a data civil escolhida: ${proximoVencimento}`, async () => {
    const emprestimoId = await criarCenario();
    const server = await iniciarServidor();
    const { port } = server.address();

    try {
      const resposta = await fetch(`http://127.0.0.1:${port}/pagamentos/manual-juros-parcial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          emprestimoId,
          valorPagamento: 20,
          dataPagamento: '2026-02-15',
          proximoVencimento,
          parcela_numero: 2,
        }),
      });

      assert.equal(resposta.status, 200, await resposta.text());
      const segunda = await get('SELECT * FROM parcelas WHERE emprestimo_id = ? AND numero = 2', [emprestimoId]);
      const primeira = await get('SELECT * FROM parcelas WHERE emprestimo_id = ? AND numero = 1', [emprestimoId]);
      const pagamento = await get('SELECT * FROM pagamentos WHERE emprestimo_id = ?', [emprestimoId]);
      const caixa = await get('SELECT * FROM caixa_movimentos WHERE emprestimo_id = ?', [emprestimoId]);

      assert.equal(segunda.vencimento, proximoVencimento);
      assert.equal(segunda.juros_pendentes, 30);
      assert.equal(segunda.valor_capital, 500);
      assert.equal(segunda.valor_total, 580);
      assert.equal(primeira.vencimento, '2026-01-31');
      assert.equal(pagamento.valor, 20);
      assert.equal(caixa.valor_total, 20);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
}

test('pagamento parcial sem próximo vencimento é bloqueado', async () => {
  const emprestimoId = await criarCenario();
  const server = await iniciarServidor();
  const { port } = server.address();

  try {
    const resposta = await fetch(`http://127.0.0.1:${port}/pagamentos/manual-juros-parcial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emprestimoId, valorPagamento: 20, dataPagamento: '2026-02-15' }),
    });

    assert.equal(resposta.status, 400);
    assert.match((await resposta.json()).erro, /próximo vencimento/i);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
