const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

const { buildParcelasSqlParts } = require('../services/relatorios/queries/parcelasBaseQuery');
const {
  getDiasPagamentoCorrespondentes,
  buildRecebimentosPrevistosSql,
} = require('../services/relatorios/queries/recebimentosPrevistosQuery');

function execAsync(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function getAsync(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

test('inclui somente atrasados cujo dia de pagamento corresponde ao periodo', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.after(() => closeAsync(db));

  await execAsync(
    db,
    `CREATE TABLE clientes (
       id INTEGER PRIMARY KEY,
       nome TEXT
     );
     CREATE TABLE emprestimos (
       id INTEGER PRIMARY KEY,
       cliente_id INTEGER,
       modalidade TEXT,
       valor_emprestado REAL,
       valor_atual REAL,
       dia_pagamento INTEGER,
       versao_atual INTEGER
     );
     CREATE TABLE parcelas (
       id INTEGER PRIMARY KEY,
       emprestimo_id INTEGER,
       numero INTEGER,
       vencimento TEXT,
       valor_total REAL,
       valor_capital REAL,
       valor_juros REAL,
       juros_adicionais REAL,
       juros_pendentes REAL,
       valor_pago REAL,
       pago INTEGER,
       versao INTEGER
     );
     INSERT INTO clientes (id, nome) VALUES (1, 'Cliente teste');
     INSERT INTO emprestimos (
       id, cliente_id, modalidade, valor_emprestado, valor_atual,
       dia_pagamento, versao_atual
     ) VALUES
       (1, 1, 'parcelado', 2000, 2000, 13, 1),
       (2, 1, 'parcelado', 2000, 2000, 12, 1);
     INSERT INTO parcelas (
       id, emprestimo_id, numero, vencimento, valor_total, valor_capital,
       valor_juros, juros_adicionais, juros_pendentes, valor_pago, pago, versao
     ) VALUES
       (1, 1, 1, '2026-07-13', 590, 400, 190, 0, 0, 0, 0, 1),
       (2, 1, 2, '2026-07-10', 300, 200, 100, 0, 0, 0, 0, 1),
       (3, 1, 3, '2026-07-09', 250, 200, 50, 0, 0, 250, 1, 1),
       (4, 1, 4, '2026-07-14', 500, 400, 100, 0, 0, 0, 0, 1),
       (5, 1, 5, '2026-07-13', 100, 80, 20, 0, 0, 100, 1, 1),
       (6, 1, 6, '2026-05-13', 700, 500, 200, 0, 0, 0, 0, 1),
       (7, 2, 1, '2026-07-12', 900, 600, 300, 0, 0, 0, 0, 1);`
  );

  const parcelasCols = new Set([
    'id',
    'emprestimo_id',
    'numero',
    'vencimento',
    'valor_total',
    'valor_capital',
    'valor_juros',
    'juros_adicionais',
    'juros_pendentes',
    'valor_pago',
    'pago',
    'versao',
  ]);
  const emprestimosCols = new Set([
    'id',
    'cliente_id',
    'modalidade',
    'valor_emprestado',
    'valor_atual',
    'dia_pagamento',
    'versao_atual',
  ]);
  const clientesCols = new Set(['id', 'nome']);
  const { baseCte } = buildParcelasSqlParts(
    parcelasCols,
    emprestimosCols,
    clientesCols
  );
  const diasPagamentoCorrespondentes = getDiasPagamentoCorrespondentes(
    '2026-07-13',
    '2026-07-13'
  );
  const sql = buildRecebimentosPrevistosSql({ baseCte, diasPagamentoCorrespondentes });
  const row = await getAsync(db, sql, [
    '2026-07-13',
    '2026-07-13',
    '2026-07-13',
    ...diasPagamentoCorrespondentes,
  ]);

  assert.deepEqual(
    {
      periodo_total: row.periodo_total,
      periodo_capital: row.periodo_capital,
      periodo_juros: row.periodo_juros,
      atrasados_total: row.atrasados_total,
      atrasados_capital: row.atrasados_capital,
      atrasados_juros: row.atrasados_juros,
    },
    {
      periodo_total: 690,
      periodo_capital: 480,
      periodo_juros: 210,
      atrasados_total: 1000,
      atrasados_capital: 700,
      atrasados_juros: 300,
    }
  );
});

test('considera dias contratuais ajustados no ultimo dia do mes', () => {
  assert.deepEqual(getDiasPagamentoCorrespondentes('2026-02-28', '2026-02-28'), [
    28,
    29,
    30,
    31,
  ]);
  assert.deepEqual(getDiasPagamentoCorrespondentes('2026-07-13', '2026-07-19'), [
    13,
    14,
    15,
    16,
    17,
    18,
    19,
  ]);
});
