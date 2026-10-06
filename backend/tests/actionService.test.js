const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync, allAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');
const { createBackupBundle, extractBackupBundle } = require('../services/backupBundleService');
const { purgeDatabase } = require('../services/systemPurgeService');

const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture({ legacy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'action-service-'));
  const dbPath = path.join(directory, 'fixture.db');
  const db = new sqlite3.Database(dbPath);
  if (legacy) await runAsync(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await new Promise((resolve, reject) => db.exec(migrationSql, (error) => error ? reject(error) : resolve()));
  return {
    db, directory, dbPath,
    async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('migration cria schema vazio, suporta banco existente e e idempotente sem inventar historico', async () => {
  const f = await fixture({ legacy: true });
  try {
    await runAsync(f.db, "INSERT INTO clientes VALUES (7, 'Legado')");
    await new Promise((resolve, reject) => f.db.exec(migrationSql, (error) => error ? reject(error) : resolve()));
    const tables = await allAsync(f.db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('acoes','acao_entidades','acao_snapshots') ORDER BY name");
    assert.deepEqual(tables.map((row) => row.name), ['acao_entidades', 'acao_snapshots', 'acoes']);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT nome FROM clientes WHERE id=7')).nome, 'Legado');
  } finally { await f.close(); }
});

test('registra acao, entidades e snapshots deterministas sem cliente ou emprestimo', async () => {
  const f = await fixture();
  try {
    const context = await actions.iniciarAcao({ tipo: 'teste_fundacao', origem: 'teste', resumo: 'Acao isolada', metadata: { z: null, a: 12.5 } }, { dbHandle: f.db });
    await actions.registrarEntidade(context, { entidade: 'parcela', entidade_id: 9, papel: 'alterada' });
    await actions.registrarEntidade(context, { entidade: 'pagamento', entidade_id: 721, papel: 'criado' });
    await actions.registrarSnapshot(context, { momento: 'antes', entidade: 'parcela', entidade_id: 9, dados: { data_pagamento: null, valor_total: 10.25, vencimento: '2026-09-26' } });
    await actions.registrarSnapshot(context, { momento: 'depois', entidade: 'parcela', entidade_id: 9, dados: { data_pagamento: '2026-09-26', valor_total: 0, vencimento: '2026-09-26' } });
    const action = await actions.finalizarAcaoAplicada(context);
    assert.equal(action.cliente_id, null);
    assert.equal(action.emprestimo_id, null);
    assert.equal(action.entidades.length, 2);
    assert.deepEqual(action.snapshots[0].dados, { data_pagamento: null, valor_total: 10.25, vencimento: '2026-09-26' });
    assert.equal((await getAsync(f.db, 'SELECT dados_json FROM acao_snapshots WHERE acao_id=? AND momento=?', [context.actionId, 'antes'])).dados_json, '{"data_pagamento":null,"valor_total":10.25,"vencimento":"2026-09-26"}');
  } finally { await f.close(); }
});

test('vincula acao de origem e aplica filtros basicos', async () => {
  const f = await fixture();
  try {
    const first = await actions.iniciarAcao({ tipo: 'ajuste', origem: 'teste', cliente_id: 4, emprestimo_id: 11, resumo: 'Primeira' }, { dbHandle: f.db });
    await actions.finalizarAcaoAplicada(first);
    const second = await actions.iniciarAcao({ tipo: 'reversao', origem: 'teste', cliente_id: 4, emprestimo_id: 11, acao_origem_id: first.actionId, resumo: 'Compensacao' }, { dbHandle: f.db });
    await actions.finalizarAcaoAplicada(second);
    assert.equal((await actions.buscarAcaoPorId(second.actionId, { dbHandle: f.db })).acao_origem_id, first.actionId);
    assert.deepEqual((await actions.listarAcoes({ cliente_id: 4, emprestimo_id: 11, tipo: 'reversao', status: 'aplicada', de: '2000-01-01', ate: '2999-01-01' }, { dbHandle: f.db })).map((row) => row.id), [second.actionId]);
  } finally { await f.close(); }
});

test('foreign keys impedem origem e registros filhos orfaos quando habilitadas', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, 'PRAGMA foreign_keys = ON');
    await assert.rejects(
      () => actions.iniciarAcao({ tipo: 'reversao', origem: 'teste', acao_origem_id: 999, resumo: 'Orfa' }, { dbHandle: f.db }),
      /FOREIGN KEY/
    );
    const context = await actions.iniciarAcao({ tipo: 'origem', origem: 'teste', resumo: 'Protegida' }, { dbHandle: f.db });
    await actions.registrarEntidade(context, { entidade: 'emprestimo', entidade_id: 1, papel: 'afetado' });
    await assert.rejects(() => runAsync(f.db, 'DELETE FROM acoes WHERE id = ?', [context.actionId]), /FOREIGN KEY/);
  } finally { await f.close(); }
});

test('historico nao permite editar conteudo, entidades ou snapshots', async () => {
  const f = await fixture();
  try {
    const context = await actions.iniciarAcao({ tipo: 'imutavel', origem: 'teste', resumo: 'Original' }, { dbHandle: f.db });
    await actions.registrarEntidade(context, { entidade: 'emprestimo', entidade_id: 1, papel: 'afetado' });
    await actions.registrarSnapshot(context, { momento: 'antes', entidade: 'emprestimo', entidade_id: 1, dados: { valor: 100 } });
    await actions.finalizarAcaoAplicada(context);
    await assert.rejects(() => runAsync(f.db, "UPDATE acoes SET resumo = 'Alterado' WHERE id = ?", [context.actionId]), /imutaveis/);
    await assert.rejects(() => runAsync(f.db, "UPDATE acao_entidades SET papel = 'outro' WHERE acao_id = ?", [context.actionId]), /imutaveis/);
    await assert.rejects(() => runAsync(f.db, "UPDATE acao_snapshots SET dados_json = '{}' WHERE acao_id = ?", [context.actionId]), /imutaveis/);
    const falha = await actions.iniciarAcao({ tipo: 'falha', origem: 'teste', resumo: 'Falhara' }, { dbHandle: f.db });
    await actions.marcarAcaoFalha(falha);
    assert.equal((await actions.buscarAcaoPorId(falha.actionId, { dbHandle: f.db })).status, 'falhou');
  } finally { await f.close(); }
});

test('participa da mesma transaction: rollback remove mutation de teste e toda a acao', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, 'CREATE TABLE mutation_teste (id INTEGER PRIMARY KEY, valor TEXT)');
    await runAsync(f.db, 'BEGIN IMMEDIATE');
    const context = await actions.iniciarAcao({ tipo: 'teste_atomicidade', origem: 'teste', resumo: 'Rollback' }, { dbHandle: f.db });
    await actions.registrarSnapshot(context, { momento: 'antes', entidade: 'mutation_teste', entidade_id: 1, dados: { valor: null } });
    await runAsync(f.db, "INSERT INTO mutation_teste VALUES (1, 'gravado')");
    await actions.registrarEntidade(context, { entidade: 'mutation_teste', entidade_id: 1, papel: 'criada' });
    await runAsync(f.db, 'ROLLBACK');
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM mutation_teste')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acao_entidades')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acao_snapshots')).total, 0);
  } finally { await f.close(); }
});

test('backup e extracao preservam as novas tabelas e seus registros', async () => {
  const f = await fixture();
  try {
    const context = await actions.iniciarAcao({ tipo: 'backup_teste', origem: 'teste', resumo: 'Preservar' }, { dbHandle: f.db });
    await actions.registrarSnapshot(context, { momento: 'antes', entidade: 'emprestimo', entidade_id: 35, dados: { valor: 100 } });
    await actions.finalizarAcaoAplicada(context);
    const photos = path.join(f.directory, 'photos');
    fs.mkdirSync(photos);
    const bundle = path.join(f.directory, 'backup.emprestimos-backup');
    await createBackupBundle({ dbPath: f.dbPath, clientPhotosDir: photos, outputPath: bundle });
    const extracted = await extractBackupBundle({ backupPath: bundle, destinationDir: path.join(f.directory, 'extract') });
    const restored = new sqlite3.Database(extracted.dbPath);
    assert.equal((await getAsync(restored, 'SELECT COUNT(*) AS total FROM acoes')).total, 1);
    assert.equal((await getAsync(restored, 'SELECT COUNT(*) AS total FROM acao_snapshots')).total, 1);
    await new Promise((resolve) => restored.close(resolve));
  } finally { await f.close(); }
});

test('rejeita getter, undefined e valores monetarios nao finitos no snapshot', () => {
  assert.throws(() => actions.serializeDeterministic({ valor: Number.NaN }), { code: 'invalid_snapshot' });
  assert.throws(() => actions.serializeDeterministic({ valor: undefined }), { code: 'invalid_snapshot' });
  const getter = {};
  Object.defineProperty(getter, 'valor', { enumerable: true, get() { throw new Error('nao executar'); } });
  assert.throws(() => actions.serializeDeterministic(getter), { code: 'invalid_snapshot' });
});

test('purge generico atual continua limpando as tabelas de acoes', async () => {
  const f = await fixture();
  try {
    const context = await actions.iniciarAcao({ tipo: 'purge_teste', origem: 'teste', resumo: 'Limpar' }, { dbHandle: f.db });
    await actions.registrarEntidade(context, { entidade: 'emprestimo', entidade_id: 1, papel: 'afetado' });
    await actions.registrarSnapshot(context, { momento: 'antes', entidade: 'emprestimo', entidade_id: 1, dados: { valor: 100 } });
    await actions.finalizarAcaoAplicada(context);
    const originStateBeforePurge = await getAsync(f.db, 'SELECT origin_device_id, next_sequence FROM action_origin_state WHERE id = 1');
    await purgeDatabase(f.db);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acao_entidades')).total, 0);
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acao_snapshots')).total, 0);
    assert.deepEqual(
      await getAsync(f.db, 'SELECT origin_device_id, next_sequence FROM action_origin_state WHERE id = 1'),
      originStateBeforePurge
    );
  } finally { await f.close(); }
});
