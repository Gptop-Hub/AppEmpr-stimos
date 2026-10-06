const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const actions = require('../services/actionService');
const { ACTION_TYPES } = require('../services/actionTypeContract');

const migration = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'action-type-contract-'));
  const db = new sqlite3.Database(path.join(directory, 'fixture.db'));
  await new Promise((resolve, reject) => db.exec(migration, (error) => error ? reject(error) : resolve()));
  return { db, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('aliases historicos permanecem legiveis e novos registros usam somente o tipo canonico', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, `INSERT INTO acoes
      (tipo, origem, status, resumo, acao_uid, origin_device_id, origin_sequence, metadata_version)
      VALUES ('despesa_criada', 'interface', 'aplicada', 'Historica', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 1, 1)`);
    const historical = (await actions.listarAcoes({ tipo: ACTION_TYPES.DESPESA_CRIADA }, { dbHandle: f.db }))[0];
    assert.equal(historical.tipo, 'despesa_criada');
    assert.equal(historical.tipo_canonico, ACTION_TYPES.DESPESA_CRIADA);

    const created = await actions.iniciarAcao({
      tipo: 'reagendamento_cascata', origem: 'interface', resumo: 'Novo contrato',
    }, { dbHandle: f.db });
    await actions.finalizarAcaoAplicada(created);
    assert.equal(
      (await getAsync(f.db, 'SELECT tipo FROM acoes WHERE id = ?', [created.actionId])).tipo,
      ACTION_TYPES.PARCELAS_REAGENDADAS
    );
    assert.equal(
      (await actions.listarAcoes({ tipo: 'reagendamento_cascata' }, { dbHandle: f.db })).length,
      1
    );
  } finally { await f.close(); }
});

test('tipos de cliente da Fase 2F pertencem ao contrato canonico compartilhado', () => {
  assert.deepEqual([
    ACTION_TYPES.CLIENTE_TELEFONE_ADICIONADO,
    ACTION_TYPES.CLIENTE_FOTO_ATUALIZADA,
    ACTION_TYPES.CLIENTE_MAL_PAGADOR_ATUALIZADO,
    ACTION_TYPES.CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA,
    ACTION_TYPES.NOTIFICACOES_GERADAS,
    ACTION_TYPES.CONFIG_NOTIFICACOES_ATUALIZADA,
  ], [
    'CLIENTE_TELEFONE_ADICIONADO',
    'CLIENTE_FOTO_ATUALIZADA',
    'CLIENTE_MAL_PAGADOR_ATUALIZADO',
    'CLIENTE_PREFERENCIA_COBRANCA_ATUALIZADA',
    'NOTIFICACOES_GERADAS',
    'CONFIG_NOTIFICACOES_ATUALIZADA',
  ]);
});
