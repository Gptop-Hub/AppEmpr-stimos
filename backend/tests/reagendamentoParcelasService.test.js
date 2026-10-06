const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, allAsync, getAsync } = require('../utils/sqliteAsync');
const { reagendarParcelas } = require('../services/reagendamentoParcelasService');
const actionService = require('../services/actionService');

const actionMigrationSql = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'),
  'utf8'
);

async function fixture(dates = ['2026-12-13', '2027-01-13', '2027-02-13']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reagendamento-'));
  const db = new sqlite3.Database(path.join(dir, 'fixture.db'));
  await runAsync(db, 'CREATE TABLE emprestimos (id INTEGER PRIMARY KEY, cliente_id INTEGER, versao_atual INTEGER, dia_pagamento INTEGER)');
  await runAsync(db, `CREATE TABLE parcelas (
    id INTEGER PRIMARY KEY, emprestimo_id INTEGER, numero INTEGER, vencimento TEXT,
    pago INTEGER, valor_pago REAL, data_pagamento TEXT, versao INTEGER,
    valor_capital REAL, valor_juros REAL, valor_total REAL, juros_adicionais REAL
  )`);
  await runAsync(db, 'INSERT INTO emprestimos VALUES (1, 4, 1, 13)');
  await new Promise((resolve, reject) => db.exec(actionMigrationSql, (error) => error ? reject(error) : resolve()));
  for (let index = 0; index < dates.length; index += 1) {
    await runAsync(db, `INSERT INTO parcelas VALUES (?, 1, ?, ?, 0, 0, NULL, 1, 100, 10, 110, 0)`, [index + 1, index + 1, dates[index]]);
  }
  return {
    db,
    async rows() { return allAsync(db, 'SELECT * FROM parcelas ORDER BY numero'); },
    async close() { await new Promise((resolve) => db.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('single altera somente a parcela e preserva dia-base e valores financeiros', async () => {
  const f = await fixture();
  try {
    await reagendarParcelas({ parcelaId: 1, tipo: 'single', novaDataISO: '2026-12-21' }, { dbHandle: f.db });
    const rows = await f.rows();
    assert.deepEqual(rows.map((p) => p.vencimento), ['2026-12-21', '2027-01-13', '2027-02-13']);
    assert.equal((await getAsync(f.db, 'SELECT dia_pagamento FROM emprestimos WHERE id=1')).dia_pagamento, 13);
    assert.deepEqual(rows.map((p) => [p.valor_capital, p.valor_juros, p.valor_total, p.valor_pago, p.juros_adicionais]), [[100, 10, 110, 0, 0], [100, 10, 110, 0, 0], [100, 10, 110, 0, 0]]);
    const action = await actionService.listarAcoes({ tipo: 'reagendamento_parcela', cliente_id: 4, emprestimo_id: 1, status: 'aplicada' }, { dbHandle: f.db });
    assert.equal(action.length, 1);
    const detail = await actionService.buscarAcaoPorId(action[0].id, { dbHandle: f.db });
    assert.deepEqual(detail.entidades.map((item) => [item.entidade, item.entidade_id, item.papel]), [['cliente', 4, 'contexto'], ['emprestimo', 1, 'contexto'], ['parcela', 1, 'alvo']]);
    assert.equal(detail.snapshots.find((item) => item.momento === 'antes').dados.vencimento, '2026-12-13');
    assert.equal(detail.snapshots.find((item) => item.momento === 'depois').dados.vencimento, '2026-12-21');
    assert.equal(detail.snapshots.every((item) => item.entidade !== 'parcela' || item.entidade_id === 1), true);
  } finally { await f.close(); }
});

test('cascade usa a nova data como âncora mensal e sincroniza dia_pagamento', async () => {
  const f = await fixture();
  try {
    const result = await reagendarParcelas({ parcelaId: 1, tipo: 'cascade', novaDataISO: '2027-02-21' }, { dbHandle: f.db });
    assert.deepEqual((await f.rows()).map((p) => p.vencimento), ['2027-02-21', '2027-03-21', '2027-04-21']);
    assert.equal(result.dia_pagamento, 21);
    assert.equal((await getAsync(f.db, 'SELECT dia_pagamento FROM emprestimos WHERE id=1')).dia_pagamento, 21);
    const action = (await actionService.listarAcoes({ tipo: 'reagendamento_cascata' }, { dbHandle: f.db }))[0];
    const detail = await actionService.buscarAcaoPorId(action.id, { dbHandle: f.db });
    assert.deepEqual(detail.snapshots.filter((item) => item.entidade === 'parcela' && item.momento === 'antes').map((item) => item.entidade_id), [1, 2, 3]);
    assert.equal(detail.snapshots.filter((item) => item.entidade === 'emprestimo').length, 2);
  } finally { await f.close(); }
});

test('change_day aplica esta e próximas abertas e ajusta fevereiro em ano normal e bissexto', async () => {
  const normal = await fixture(['2027-01-13', '2027-02-13', '2027-04-13']);
  try {
    await reagendarParcelas({ parcelaId: 1, tipo: 'change_day', novoDia: 31 }, { dbHandle: normal.db });
    assert.deepEqual((await normal.rows()).map((p) => p.vencimento), ['2027-01-31', '2027-02-28', '2027-04-30']);
  } finally { await normal.close(); }
  const leap = await fixture(['2028-01-13', '2028-02-13']);
  try {
    await reagendarParcelas({ parcelaId: 1, tipo: 'change_day', novoDia: 31 }, { dbHandle: leap.db });
    assert.deepEqual((await leap.rows()).map((p) => p.vencimento), ['2028-01-31', '2028-02-29']);
  } finally { await leap.close(); }
});

test('parcela com qualquer indicador de pagamento fica intacta e não pode ser alvo', async () => {
  const f = await fixture();
  try {
    await runAsync(f.db, "UPDATE parcelas SET valor_pago = 5, data_pagamento = '2027-01-14' WHERE id = 2");
    await assert.rejects(
      () => reagendarParcelas({ parcelaId: 2, tipo: 'single', novaDataISO: '2027-01-20' }, { dbHandle: f.db }),
      /pagamento registrado/
    );
    const row = await getAsync(f.db, 'SELECT vencimento, valor_pago, data_pagamento FROM parcelas WHERE id=2');
    assert.deepEqual({ ...row }, { vencimento: '2027-01-13', valor_pago: 5, data_pagamento: '2027-01-14' });
  } finally { await f.close(); }
});

test('colisão de período é bloqueada atomicamente', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => reagendarParcelas({ parcelaId: 1, tipo: 'single', novaDataISO: '2027-02-21' }, { dbHandle: f.db }),
      (error) => error.code === 'SCHEDULE_COLLISION'
    );
    assert.deepEqual((await f.rows()).map((p) => p.vencimento), ['2026-12-13', '2027-01-13', '2027-02-13']);
  } finally { await f.close(); }
});
