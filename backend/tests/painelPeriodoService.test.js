const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getRelatorioPainelPeriodo, getDetalhamentoPainelPeriodo, normalizeParams, buildBuckets } = require('../services/relatorios/painelPeriodoService');

function execAsync(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
}

function closeAsync(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function makeDb() {
  const db = new sqlite3.Database(':memory:');
  await execAsync(db, `
    CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, criadoEm TEXT);
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, valor REAL, valor_emprestado REAL, data TEXT, versao_atual INTEGER, renegociacao_de INTEGER);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, vencimento TEXT, pago INTEGER, valor_pago REAL, juros_adicionais REAL, juros_pendentes REAL, versao INTEGER);
    CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY, tipo TEXT, categoria TEXT, data TEXT, data_pagamento TEXT, valor_total REAL, valor_juros REAL, valor_capital REAL, meta_json TEXT, cliente_id INTEGER, cliente_nome TEXT);
    INSERT INTO clientes VALUES (1, 'Cliente', '2026-02-10');
    INSERT INTO emprestimos VALUES (1, 1, 1000, 1000, '2026-02-10', 2, NULL);
    INSERT INTO emprestimos VALUES (2, 1, 700, 700, '2026-02-10', 1, 1);
    INSERT INTO parcelas VALUES
      (1, 1, 1, 110, 90, 20, '2026-02-10', 0, 30, 0, 0, 2),
      (2, 1, 2, 120, 100, 20, '2026-02-11', 1, 120, 0, 0, 2),
      (3, 1, 1, 999, 900, 99, '2026-02-10', 0, 0, 0, 0, 1),
      (4, 1, -1, 500, 500, 0, '2026-02-10', 0, 0, 0, 0, 2);
    INSERT INTO caixa_movimentos VALUES
      (1, 'ENTRADA', 'PAGAMENTO', '2026-02-10', '2026-02-10', 80, 20, 60, '{"pagamento_id": 1}', NULL, NULL),
      (2, 'ENTRADA', 'PAGAMENTO', '2026-02-12', '2026-02-12', 40, 0, 40, '{"backfill":true,"pagamento_id": 2}', NULL, NULL),
      (3, 'SAIDA', 'EMPRESTIMO', '2026-02-10', NULL, 1000, 0, 0, NULL, NULL, NULL);
    UPDATE caixa_movimentos SET cliente_id = 1, cliente_nome = 'Cliente' WHERE id IN (1, 2);
  `);
  return db;
}

test('valida intervalo e gera baldes inclusivos sem UTC', () => {
  assert.throws(() => normalizeParams({ de: '2026-02-30', ate: '2026-03-01' }));
  assert.throws(() => normalizeParams({ de: '2026-03-02', ate: '2026-03-01' }));
  assert.deepEqual(buildBuckets('2024-02-28', '2024-03-01', 'dia'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(buildBuckets('2026-01-01', '2026-03-31', 'mes'), ['2026-01', '2026-02', '2026-03']);
});

test('calcula previsto, pendente, cobertura e series sem duplicar versoes', async (t) => {
  const db = await makeDb();
  t.after(() => closeAsync(db));
  const report = await getRelatorioPainelPeriodo(
    { de: '2026-02-10', ate: '2026-02-12', agrupamento: 'dia' },
    { dbHandle: db }
  );
  assert.equal(report.indicadores.previsto, 230);
  assert.equal(report.indicadores.pendente, 80);
  assert.equal(report.indicadores.quantidadeParcelasPendentes, 1);
  assert.equal(report.indicadores.recebido, 120);
  assert.equal(report.indicadores.quantidadePagamentos, 2);
  assert.equal(report.indicadores.percentual, Number((120 / 230 * 100).toFixed(2)));
  assert.equal(report.indicadores.capitalRecebido, null);
  assert.equal(report.indicadores.jurosRecebidos, null);
  assert.equal(report.indicadores.jurosAdicionaisRecebidos, null);
  assert.equal(report.indicadores.novosClientes, 1);
  assert.equal(report.indicadores.novosEmprestimos, 1);
  assert.equal(report.indicadores.valorEmprestado, 1000);
  assert.deepEqual(report.serie, [
    { chave: '2026-02-10', previsto: 110, recebido: 80 },
    { chave: '2026-02-11', previsto: 120, recebido: 0 },
    { chave: '2026-02-12', previsto: 0, recebido: 40 },
  ]);
});

test('retorna composicao persistida quando nao ha backfill e previsto zero nao divide por zero', async (t) => {
  const db = await makeDb();
  t.after(() => closeAsync(db));
  await execAsync(db, "DELETE FROM caixa_movimentos WHERE id = 2;");
  const report = await getRelatorioPainelPeriodo(
    { de: '2026-03-01', ate: '2026-03-01', agrupamento: 'dia' },
    { dbHandle: db }
  );
  assert.equal(report.indicadores.previsto, 0);
  assert.equal(report.indicadores.percentual, 0);
  assert.equal(report.indicadores.capitalRecebido, 0);
  assert.equal(report.indicadores.jurosRecebidos, 0);
});

test('detalha os indicadores por cliente sem multiplicar parcelas ou pagamentos', async (t) => {
  const db = await makeDb();
  t.after(() => closeAsync(db));
  const params = { de: '2026-02-10', ate: '2026-02-12', agrupamento: 'dia' };
  const [previsto, recebido, pendente, pagamentos, cobertura, novosClientes, emprestimos, valorEmprestado] = await Promise.all([
    getDetalhamentoPainelPeriodo({ ...params, metric: 'previsto' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'recebido' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'pendente' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'quantidadePagamentos' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'cobertura' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'novosClientes' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'novosEmprestimos' }, { dbHandle: db }),
    getDetalhamentoPainelPeriodo({ ...params, metric: 'valorEmprestado' }, { dbHandle: db }),
  ]);
  assert.deepEqual(previsto.rows, [{ id: 1, nome: 'Cliente', valor: 230 }]);
  assert.deepEqual(recebido.rows, [{ id: 1, nome: 'Cliente', valor: 120 }]);
  assert.deepEqual(pendente.rows, [{ id: 1, nome: 'Cliente', valor: 80 }]);
  assert.deepEqual(pagamentos.rows, [{ id: 1, nome: 'Cliente', valor: 2 }]);
  assert.deepEqual(cobertura.rows, [{ id: 1, nome: 'Cliente', valor: Number((120 / 230 * 100).toFixed(2)) }]);
  assert.deepEqual(novosClientes.rows, [{ id: 1, nome: 'Cliente', valor: 1 }]);
  assert.deepEqual(emprestimos.rows, [{ id: 1, nome: 'Cliente', valor: 1 }]);
  assert.deepEqual(valorEmprestado.rows, [{ id: 1, nome: 'Cliente', valor: 1000 }]);
});
