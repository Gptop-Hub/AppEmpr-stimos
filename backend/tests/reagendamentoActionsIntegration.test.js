const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, getAsync } = require('../utils/sqliteAsync');
const { reagendarParcelas } = require('../services/reagendamentoParcelasService');
const actions = require('../services/actionService');

const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'), 'utf8');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reagendamento-actions-'));
  const db = new sqlite3.Database(path.join(dir, 'fixture.db'));
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, versao_atual INTEGER, dia_pagamento INTEGER);
    CREATE TABLE parcelas (id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, vencimento TEXT, pago INTEGER, valor_pago REAL, data_pagamento TEXT, versao INTEGER, valor_capital REAL, valor_juros REAL, valor_total REAL, juros_adicionais REAL);
    INSERT INTO emprestimos VALUES (10, 4, 1, 13);
    INSERT INTO parcelas VALUES (1, 10, 1, '2026-10-13', 0, 0, NULL, 1, 100, 10, 110, 0);
    INSERT INTO parcelas VALUES (2, 10, 2, '2026-11-13', 0, 0, NULL, 1, 100, 10, 110, 0);
    INSERT INTO parcelas VALUES (3, 10, 3, '2026-12-13', 0, 0, NULL, 1, 100, 10, 110, 0);
  `, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.exec(migrationSql, (error) => error ? reject(error) : resolve()));
  return { db, async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('cascata registra somente parcelas realmente alteradas e o emprestimo cujo dia mudou', async () => {
  const f = await fixture();
  try {
    await reagendarParcelas({ parcelaId: 1, tipo: 'cascade', novaDataISO: '2026-10-21' }, { dbHandle: f.db });
    const action = (await actions.listarAcoes({ tipo: 'reagendamento_cascata', cliente_id: 4, emprestimo_id: 10 }, { dbHandle: f.db }))[0];
    const detail = await actions.buscarAcaoPorId(action.id, { dbHandle: f.db });
    assert.equal(detail.entidades.filter((item) => item.entidade === 'parcela').length, 3);
    assert.deepEqual(detail.snapshots.filter((item) => item.entidade === 'parcela' && item.momento === 'antes').map((item) => item.dados.vencimento), ['2026-10-13', '2026-11-13', '2026-12-13']);
    assert.deepEqual(detail.snapshots.filter((item) => item.entidade === 'parcela' && item.momento === 'depois').map((item) => item.dados.vencimento), ['2026-10-21', '2026-11-21', '2026-12-21']);
    assert.deepEqual(detail.snapshots.filter((item) => item.entidade === 'emprestimo').map((item) => item.dados.dia_pagamento), [13, 21]);
  } finally { await f.close(); }
});

test('falha na acao desfaz junto a alteracao de vencimento', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, "CREATE TRIGGER falha_acao BEFORE INSERT ON acao_snapshots BEGIN SELECT RAISE(ABORT, 'falha da acao'); END;");
    await assert.rejects(
      () => reagendarParcelas({ parcelaId: 1, tipo: 'single', novaDataISO: '2026-10-21' }, { dbHandle: f.db }),
      /falha da acao/
    );
    assert.equal((await getAsync(f.db, 'SELECT vencimento FROM parcelas WHERE id=1')).vencimento, '2026-10-13');
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
  } finally { await f.close(); }
});

test('alteracao de dia sem efeito em parcelas nem dia-base nao gera acao', async () => {
  const f = await fixture();
  try {
    await reagendarParcelas({ parcelaId: 1, tipo: 'change_day', novoDia: 13 }, { dbHandle: f.db });
    assert.equal((await getAsync(f.db, 'SELECT COUNT(*) AS total FROM acoes')).total, 0);
  } finally { await f.close(); }
});
