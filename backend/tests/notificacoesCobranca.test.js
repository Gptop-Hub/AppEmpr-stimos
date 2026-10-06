const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const test = require('node:test');

function openDb(file) {
  return new sqlite3.Database(file);
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function close(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

test('migration preserva clientes ativos e a Central oculta notificacoes de cliente silenciado', async (t) => {
  const OriginalDate = global.Date;
  const fixedNow = new OriginalDate('2026-08-10T12:00:00.000Z');
  global.Date = class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow.getTime()]));
    }

    static now() {
      return fixedNow.getTime();
    }
  };
  t.after(() => { global.Date = OriginalDate; });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emprestimos-notif-cobranca-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  process.env.APP_DATA_DIR = tempDir;

  const dbFile = path.join(tempDir, 'emprestimos-data', 'database.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const seedDb = openDb(dbFile);
  await exec(
    seedDb,
    `
      CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cpf TEXT, telefone TEXT, endereco TEXT, trabalho TEXT, referencia TEXT, observacao TEXT, criadoEm TEXT, mal_pagador INTEGER DEFAULT 0);
      CREATE TABLE emprestimos (
        id INTEGER PRIMARY KEY, cliente_id INTEGER, capital_restante REAL, observacao TEXT,
        versao_atual INTEGER DEFAULT 1, dia_pagamento INTEGER, ativo INTEGER DEFAULT 1,
        valor REAL, valor_emprestado REAL, valor_atual REAL, updated_at TEXT
      );
      CREATE TABLE parcelas_originais (id INTEGER PRIMARY KEY, explicacao TEXT);
      CREATE TABLE parcelas (
        id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, vencimento TEXT,
        pago INTEGER, valor_pago REAL, valor_total REAL, valor_capital REAL, valor_juros REAL,
        juros_adicionais REAL, juros_pendentes REAL, versao INTEGER,
        data_pagamento TEXT, observacao TEXT, valor_excedente REAL,
        parcela_origem_numero INTEGER
      );
      INSERT INTO clientes (id, nome) VALUES (1, 'Cliente anterior');
    `
  );
  await close(seedDb);

  const { runMigrations } = require('../models/migrations');
  await runMigrations();

  const migratedDb = openDb(dbFile);
  const columns = await all(migratedDb, 'PRAGMA table_info(clientes)');
  assert.ok(columns.some((column) => column.name === 'receber_notificacoes_cobranca'));
  assert.ok(columns.some((column) => column.name === 'motivo_notificacoes_cobranca'));
  const migratedClient = await all(
    migratedDb,
    'SELECT receber_notificacoes_cobranca, motivo_notificacoes_cobranca FROM clientes WHERE id = 1'
  );
  assert.deepEqual(migratedClient[0], {
    receber_notificacoes_cobranca: 1,
    motivo_notificacoes_cobranca: null,
  });

  await exec(
    migratedDb,
    `
      INSERT INTO clientes (id, nome, receber_notificacoes_cobranca, motivo_notificacoes_cobranca)
        VALUES (2, 'Cliente ativo', 1, NULL), (3, 'Cliente silenciado', 1, NULL);
      INSERT INTO clientes (id, nome) VALUES (4, 'Cliente novo');
      INSERT INTO emprestimos (id, cliente_id, versao_atual) VALUES (20, 2, 1), (30, 3, 1);
      INSERT INTO parcelas (id, emprestimo_id, numero, vencimento, pago, valor_pago, valor_total, versao)
        VALUES (200, 20, 1, '2026-08-09', 0, 0, 100, 1), (300, 30, 1, '2026-08-09', 0, 0, 100, 1);
    `
  );
  const newClient = await all(
    migratedDb,
    'SELECT receber_notificacoes_cobranca, motivo_notificacoes_cobranca FROM clientes WHERE id = 4'
  );
  assert.deepEqual(newClient[0], {
    receber_notificacoes_cobranca: 1,
    motivo_notificacoes_cobranca: null,
  });
  await close(migratedDb);

  const service = require('../services/notificacoesService');
  await service.gerarNotificacoesParaData('2026-08-10');
  let pendentes = await service.listarNotificacoesPendentes();
  assert.equal(pendentes.length, 2);

  const appDb = require('../models/database');
  await exec(
    appDb,
    `
      UPDATE clientes
         SET receber_notificacoes_cobranca = 0,
             motivo_notificacoes_cobranca = 'Cobrança externa'
       WHERE id = 3;
      INSERT INTO parcelas (id, emprestimo_id, numero, vencimento, pago, valor_pago, valor_total, versao)
        VALUES (301, 30, 2, '2026-08-09', 0, 0, 100, 1);
    `
  );

  pendentes = await service.listarNotificacoesPendentes();
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].cliente_id, 2);

  await service.gerarNotificacoesParaData('2026-08-10');
  const geradasParaSilenciado = await all(
    appDb,
    'SELECT id FROM notificacoes WHERE parcela_id = 301'
  );
  assert.equal(geradasParaSilenciado.length, 0);

  await exec(appDb, 'UPDATE clientes SET receber_notificacoes_cobranca = 1 WHERE id = 3');
  await service.gerarNotificacoesParaData('2026-08-10');
  pendentes = await service.listarNotificacoesPendentes();
  assert.equal(pendentes.length, 3);
  const clienteReativado = await all(
    appDb,
    'SELECT motivo_notificacoes_cobranca FROM clientes WHERE id = 3'
  );
  assert.equal(clienteReativado[0].motivo_notificacoes_cobranca, 'Cobrança externa');

  await appDb.closeConnection();
});
