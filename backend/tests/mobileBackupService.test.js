const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { createBackupBundle, sha256File } = require('../services/backupBundleService');
const { createMobileBackupFromDesktopBundle, verifyMobileBackup } = require('../services/mobileBackupService');

function open(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(db)));
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())));
}

function close(db) {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-backup-service-'));
  const dbPath = path.join(directory, 'database.db');
  const photosDir = path.join(directory, 'photos');
  const photoName = 'cliente-1-11111111-1111-4111-8111-111111111111.jpg';
  fs.mkdirSync(photosDir);
  fs.writeFileSync(path.join(photosDir, photoName), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const db = await open(dbPath);
  try {
    await exec(db, `
      CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, cpf TEXT, telefone TEXT, endereco TEXT, trabalho TEXT, categoria_trabalho TEXT, mal_pagador INTEGER, foto_cliente TEXT, referencia TEXT, observacao TEXT, criadoEm TEXT, receber_notificacoes_cobranca INTEGER);
      CREATE TABLE clientes_telefones (id INTEGER PRIMARY KEY, cliente_id INTEGER, telefone TEXT, created_at TEXT);
      CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, valor REAL, valor_emprestado REAL, valor_atual REAL, data TEXT, modalidade TEXT, taxa_juros REAL, capital_restante REAL, saldo_devedor REAL, ativo INTEGER, versao_atual INTEGER);
      CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, vencimento TEXT, pago INTEGER, valor_pago REAL, juros_adicionais REAL, juros_pendentes REAL, valor_excedente REAL, versao INTEGER);
      CREATE TABLE pagamentos (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, valor REAL, data TEXT, tipo_pagamento TEXT, parcela_origem INTEGER);
      CREATE TABLE parcelas_originais (id INTEGER PRIMARY KEY, parcela_id INTEGER, emprestimo_id INTEGER, numero INTEGER, valor_total REAL, valor_capital REAL, valor_juros REAL, valor_pago REAL, valor_excedente REAL, pago INTEGER, versao INTEGER);
      CREATE TABLE caixa_movimentos (id INTEGER PRIMARY KEY, tipo TEXT, categoria TEXT, data TEXT, cliente_id INTEGER, cliente_nome TEXT, emprestimo_id INTEGER, parcela_id INTEGER, parcela_numero INTEGER, valor_total REAL, valor_juros REAL, valor_capital REAL, valor_emprestimo REAL, valor_despesa REAL, created_at TEXT);
      CREATE TABLE renegociacoes_historico (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, versao INTEGER, snapshot_emprestimo TEXT, snapshot_parcelas TEXT, created_at TEXT);
      INSERT INTO clientes VALUES(1, 'Cliente Mobile', '12345678901', '11999999999', 'Rua A', 'Autônomo', 'servicos', 0, '${photoName}', 'ref-1', NULL, '2026-01-01', 1);
      INSERT INTO clientes_telefones VALUES(1, 1, '11999999999', '2026-01-01T00:00:00.000Z');
      INSERT INTO emprestimos VALUES(10, 1, 100, 100, 100, '2026-01-01', 'parcelado', 10, 100, 110, 1, 1);
      INSERT INTO parcelas VALUES(100, 10, 1, 110, 100, 10, '2026-02-01', 0, 0, 0, 0, 0, 1);
       INSERT INTO pagamentos VALUES(1000, 10, 10, '2026-01-15', 'juros', 0);
      INSERT INTO parcelas_originais VALUES(200, 100, 10, 1, 110, 100, 10, 0, 0, 0, 1);
       INSERT INTO caixa_movimentos VALUES(300, 'ENTRADA', 'PAGAMENTO', '2026-01-15', 1, 'Cliente Mobile', 10, 100, 1, 10, 10, 0, 0, 0, '2026-01-15T00:00:00.000Z');
       INSERT INTO caixa_movimentos VALUES(301, 'SAIDA', 'OUTROS', '2026-01-16', 1, 'Cliente Mobile', 999, 999, 9, 1, 0, 0, 0, 1, '2026-01-16T00:00:00.000Z');
      INSERT INTO renegociacoes_historico VALUES(400, 10, 1, '{}', '[]', '2026-01-16T00:00:00.000Z');
      ALTER TABLE clientes ADD COLUMN cliente_uid TEXT;
      ALTER TABLE emprestimos ADD COLUMN emprestimo_uid TEXT;
      ALTER TABLE parcelas ADD COLUMN parcela_uid TEXT;
      UPDATE clientes SET cliente_uid = '11111111-1111-4111-8111-111111111111';
      UPDATE emprestimos SET emprestimo_uid = '22222222-2222-4222-8222-222222222222';
      UPDATE parcelas SET parcela_uid = '33333333-3333-4333-8333-333333333333';
    `);
  } finally {
    await close(db);
  }
  const desktopBundle = path.join(directory, 'origem.emprestimos-backup');
  await createBackupBundle({ dbPath, clientPhotosDir: photosDir, outputPath: desktopBundle, referencedPhotoNames: [photoName] });
  return {
    directory,
    desktopBundle,
    output: path.join(directory, 'celular.sistema-backup'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('converte um snapshot V2 sem modificar a origem e valida no esquema Android', async () => {
  const data = await fixture();
  try {
    const before = await sha256File(data.desktopBundle);
    const result = await createMobileBackupFromDesktopBundle({ desktopBundlePath: data.desktopBundle, outputPath: data.output });
    assert.equal(await sha256File(data.desktopBundle), before);
    assert.equal(result.counts.clientes, 1);
    assert.equal(result.counts.emprestimos, 1);
    assert.equal(result.counts.parcelas, 1);
    assert.equal(result.counts.pagamentos, 1);
    assert.equal(result.counts.caixa_movimentos, 2);
    assert.equal(result.counts.local_auditoria, 1);
    assert.equal(result.photoCount, 1);
    const verified = await verifyMobileBackup(data.output, result.counts);
    assert.equal(verified.manifest.formatVersion, 1);
    assert.equal(verified.manifest.photos.length, 1);
    assert.equal(verified.snapshot.database, 'sistema_emprestimos_local');
    assert.equal(verified.snapshot.tables.pagamentos[0].parcela_origem, 100);
    assert.equal(verified.snapshot.tables.clientes[0].cliente_uid, '11111111-1111-4111-8111-111111111111');
    assert.equal(verified.snapshot.tables.emprestimos[0].emprestimo_uid, '22222222-2222-4222-8222-222222222222');
    assert.equal(verified.snapshot.tables.parcelas[0].parcela_uid, '33333333-3333-4333-8333-333333333333');
    assert.deepEqual(
      verified.snapshot.tables.caixa_movimentos.map((movimento) => [movimento.id, movimento.emprestimo_id, movimento.parcela_id]),
      [[300, 10, 100], [301, null, null]]
    );
    assert.match(result.warnings.join('\n'), /Movimento de caixa 301: empréstimo 999 inexistente/);
    assert.match(result.warnings.join('\n'), /Movimento de caixa 301: parcela 999 inexistente/);
  } finally {
    data.cleanup();
  }
});

test('converte parcela_origem do PC pelo numero da parcela e versao atual do emprestimo', () => {
  const warnings = [];
  const tables = require('../services/mobileBackupService').__test.convertTables({
    clientes: [{ id: 1, nome: 'Cliente', cpf: '12345678901', telefone: '11999999999' }],
    clientes_telefones: [],
    emprestimos: [
      { id: 10, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 2 },
      { id: 20, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 1 },
    ],
    parcelas: [
      { id: 100, emprestimo_id: 10, numero: 1, versao: 1, vencimento: '2026-02-01' },
      { id: 101, emprestimo_id: 10, numero: 1, versao: 2, vencimento: '2026-02-01' },
      { id: 102, emprestimo_id: 10, numero: 2, versao: 2, vencimento: '2026-03-01' },
      { id: 103, emprestimo_id: 10, numero: 3, versao: 2, vencimento: '2026-04-01' },
      { id: 104, emprestimo_id: 10, numero: 4, versao: 1, vencimento: '2026-05-01' },
      { id: 105, emprestimo_id: 20, numero: 4, versao: 1, vencimento: '2026-05-01' },
      { id: 106, emprestimo_id: 10, numero: 6, versao: 2, vencimento: '2026-07-01' },
      { id: 107, emprestimo_id: 10, numero: 6, versao: 2, vencimento: '2026-07-01' },
    ],
    pagamentos: [
      { id: 1000, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 0 },
      { id: 1001, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 1 },
      { id: 1002, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 2 },
      { id: 1003, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: null },
      { id: 1004, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 3 },
      { id: 1005, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 4 },
      { id: 1006, emprestimo_id: 10, valor: 1, data: '2026-01-01', parcela_origem: 5 },
    ],
    parcelas_originais: [], caixa_movimentos: [], renegociacoes_historico: [],
  }, '2026-01-01T00:00:00.000Z', warnings);

  assert.deepEqual(tables.pagamentos.map((pagamento) => pagamento.parcela_origem), [101, 102, 103, null, null, null, null]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /Pagamento 1004/);
  assert.match(warnings[1], /Pagamento 1005/);
  assert.match(warnings[2], /Pagamento 1006/);
});

test('calcula saldo_devedor pela regra canonica Android usando somente parcelas abertas da versao atual', () => {
  const tables = require('../services/mobileBackupService').__test.convertTables({
    clientes: [{ id: 1, nome: 'Cliente', cpf: '12345678901', telefone: '11999999999' }],
    clientes_telefones: [],
    emprestimos: [
      { id: 10, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 2 },
      { id: 11, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 1 },
      { id: 12, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 1 },
      { id: 13, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 1 },
      { id: 14, cliente_id: 1, valor: 100, data: '2026-01-01', versao_atual: 1 },
    ],
    parcelas: [
      { id: 100, emprestimo_id: 10, numero: 1, versao: 2, vencimento: '2026-02-01', valor_total: 100, valor_pago: 100, pago: 1 },
      { id: 101, emprestimo_id: 10, numero: 1, versao: 1, vencimento: '2026-02-01', valor_total: 50, valor_pago: 0, pago: 0 },
      { id: 110, emprestimo_id: 11, numero: 1, versao: 1, vencimento: '2026-02-01', valor_total: 100, valor_pago: 25, pago: 0 },
      { id: 120, emprestimo_id: 12, numero: 1, versao: 1, vencimento: '2026-02-01', valor_total: 10, valor_pago: 0, pago: 0 },
      { id: 121, emprestimo_id: 12, numero: 2, versao: 1, vencimento: '2026-03-01', valor_total: 20, juros_adicionais: 3, valor_pago: 0, pago: 0 },
      { id: 130, emprestimo_id: 13, numero: 1, versao: 1, vencimento: '2026-02-01', valor_total: 10, valor_pago: 50, pago: 0 },
      { id: 140, emprestimo_id: 14, numero: 1, versao: 1, vencimento: '2026-02-01', valor_total: 12.346, valor_pago: 0, pago: 0 },
    ],
    pagamentos: [], parcelas_originais: [], caixa_movimentos: [], renegociacoes_historico: [],
  }, '2026-01-01T00:00:00.000Z');

  assert.deepEqual(
    Object.fromEntries(tables.emprestimos.map((emprestimo) => [emprestimo.id, emprestimo.saldo_devedor])),
    { 10: 0, 11: 75, 12: 33, 13: 0, 14: 12.35 }
  );
});

test('preserva somente estados representaveis e avisa sobre referencias orfas do caixa', () => {
  const warnings = [];
  const tables = require('../services/mobileBackupService').__test.convertTables({
    clientes: [{
      id: 1, nome: 'Cliente', cpf: '12345678901', telefone: '11999999999', criadoEm: '2026-01-02T00:00:00.000Z',
      last_activity_at: null, receber_notificacoes_cobranca: 0, motivo_notificacoes_cobranca: 'Pausado',
    }],
    clientes_telefones: [],
    emprestimos: [{
      id: 10, cliente_id: 1, valor: 100, data: '2026-01-01', capital_restante: 42.5, parcelas: 99,
      created_at: '2026-01-03T00:00:00.000Z', last_activity_at: null, versao_atual: 1,
    }],
    parcelas: [{
      id: 100, emprestimo_id: 10, numero: 1, versao: null, vencimento: '2026-02-01', pago: null,
      valor_total: null, valor_capital: null, valor_juros: null, valor_pago: null, juros_adicionais: null,
      juros_pendentes: null, valor_excedente: null, capital_restante: null, parcela_origem_numero: null,
      data_pagamento: null,
    }],
    pagamentos: [], parcelas_originais: [],
    caixa_movimentos: [
      { id: 300, tipo: 'ENTRADA', categoria: 'PAGAMENTO', data: '2026-01-01', cliente_id: 1, emprestimo_id: 999, parcela_id: 998 },
      { id: 301, tipo: 'SAIDA', categoria: 'OUTROS', data: '2026-01-01', cliente_id: 1, emprestimo_id: 10, parcela_id: 100 },
    ],
    renegociacoes_historico: [],
    notificacoes: [{ id: 1, tipo: 'parcela_atrasada' }],
  }, '2026-01-01T00:00:00.000Z', warnings);

  assert.equal(tables.clientes[0].last_activity_at, '2026-01-02T00:00:00.000Z');
  assert.equal(tables.clientes[0].receber_notificacoes_cobranca, 0);
  assert.equal(tables.emprestimos[0].last_activity_at, '2026-01-03T00:00:00.000Z');
  assert.equal(tables.emprestimos[0].capital_restante, 42.5);
  assert.equal('parcelas' in tables.emprestimos[0], false);
  assert.deepEqual(
    tables.parcelas[0],
    {
      id: 100, emprestimo_id: 10, numero: 1, valor_total: 0, valor_capital: 0, valor_juros: 0,
      vencimento: '2026-02-01', pago: 0, observacao: null, valor_pago: 0, data_pagamento: null,
      juros_adicionais: 0, juros_pendentes: 0, valor_excedente: 0, explicacao: null, tipo_pagamento: null,
      capital_restante: null, parcela_origem_numero: null, versao: 1,
    }
  );
  assert.deepEqual(
    tables.caixa_movimentos.map((movimento) => [movimento.tipo, movimento.emprestimo_id, movimento.parcela_id]),
    [['entrada', null, null], ['saida', 10, 100]]
  );
  assert.equal('notificacoes' in tables, false);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Movimento de caixa 300: empréstimo 999 inexistente/);
  assert.match(warnings[1], /Movimento de caixa 300: parcela 998 inexistente/);
});

test('recusa cliente desktop incompatível com a mesma regra do Android', () => {
  assert.throws(
    () => require('../services/mobileBackupService').__test.convertTables({
      clientes: [{ id: 1, nome: 'Sem CPF', cpf: '', telefone: '11999999999' }],
      clientes_telefones: [], emprestimos: [], parcelas: [], pagamentos: [],
      parcelas_originais: [], caixa_movimentos: [], renegociacoes_historico: [],
    }, '2026-01-01T00:00:00.000Z'),
    { code: 'INCOMPATIBLE_CLIENT' }
  );
});
