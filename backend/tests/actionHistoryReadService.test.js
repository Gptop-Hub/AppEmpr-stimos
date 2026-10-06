const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { runAsync, allAsync } = require('../utils/sqliteAsync');
const {
  presentationFor,
  listActionHistory,
  getActionHistoryDetail,
} = require('../services/actionHistoryReadService');

const actionSchema = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'migrations', 'create_action_tables.sql'),
  'utf8'
);

function execAsync(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'action-history-read-'));
  const db = new sqlite3.Database(path.join(directory, 'fixture.db'));
  await execAsync(db, `
    CREATE TABLE clientes (
      id INTEGER PRIMARY KEY,
      nome TEXT,
      cliente_uid TEXT
    );
    CREATE TABLE emprestimos (
      id INTEGER PRIMARY KEY,
      cliente_id INTEGER,
      valor REAL,
      valor_emprestado REAL,
      valor_atual REAL,
      emprestimo_uid TEXT
    );
    ${actionSchema}
  `);
  await runAsync(db, "INSERT INTO clientes (id, nome, cliente_uid) VALUES (1, 'Ana Souza', 'cliente-ana')");
  await runAsync(db, 'INSERT INTO emprestimos (id, cliente_id, valor, valor_emprestado, valor_atual) VALUES (10, 1, 1000, 1000, 700)');

  const actions = [
    ['00000000-0000-4000-8000-000000000001', 'CLIENTE_EDITADO', '2026-09-27 09:00:00', 1, 'Cadastro de Ana atualizado', 1, null, '{"campos_confirmados":["nome"]}'],
    ['00000000-0000-4000-8000-000000000002', 'EMPRESTIMO_CRIADO', '2026-09-28 10:00:00', 2, 'Empréstimo criado para Ana', 1, 10, '{"parametros":{"valor":1000,"parcelas":3}}'],
    ['00000000-0000-4000-8000-000000000003', 'PAGAMENTO_NORMAL_REGISTRADO', '2026-09-29 11:00:00', 3, 'Pagamento normal registrado', 1, 10, '{"parametros":{"valor":300}}'],
    ['00000000-0000-4000-8000-000000000004', 'NOTIFICACOES_GERADAS', '2026-09-29 12:00:00', 4, 'Notificações geradas', null, null, '{"data":"2026-09-29"}'],
  ];
  for (const action of actions) {
    await runAsync(db, `INSERT INTO acoes
      (acao_uid, origin_device_id, origin_sequence, metadata_version, tipo, origem,
       created_at, status, resumo, cliente_id, emprestimo_id, metadata_json)
      VALUES (?, '00000000-0000-4000-8000-000000000099', ?, 1, ?, 'teste', ?, 'aplicada', ?, ?, ?, ?)`,
    [action[0], action[3], action[1], action[2], action[4], action[5], action[6], action[7]]);
  }
  const payment = await allAsync(db, "SELECT id FROM acoes WHERE tipo = 'PAGAMENTO_NORMAL_REGISTRADO'");
  await runAsync(db, 'INSERT INTO acao_entidades (acao_id, entidade, entidade_id, entidade_uid, papel) VALUES (?, ?, ?, ?, ?)',
    [payment[0].id, 'clientes', 1, 'cliente-ana', 'relacionado']);
  await runAsync(db, 'INSERT INTO acao_snapshots (acao_id, momento, entidade, entidade_id, dados_json) VALUES (?, ?, ?, ?, ?)',
    [payment[0].id, 'antes', 'emprestimos', 10, '{"estado":{"emprestimo":{"saldo_devedor":1000},"cliente":{"nome":"Ana Souza"}}}']);
  await runAsync(db, 'INSERT INTO acao_snapshots (acao_id, momento, entidade, entidade_id, dados_json) VALUES (?, ?, ?, ?, ?)',
    [payment[0].id, 'depois', 'emprestimos', 10, '{"estado":{"emprestimo":{"saldo_devedor":700},"cliente":{"nome":"Ana Souza"}}}']);
  return {
    db,
    async close() {
      await new Promise((resolve) => db.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function databaseState(db) {
  const tables = ['clientes', 'emprestimos', 'acoes', 'acao_entidades', 'acao_snapshots', 'action_origin_state'];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [
    table,
    await allAsync(db, `SELECT * FROM ${table} ORDER BY id`),
  ])));
}

test('centraliza nomes amigáveis, categorias e destaque secundário', () => {
  assert.deepEqual(presentationFor('PAGAMENTO_NORMAL_REGISTRADO'), {
    tipo_canonico: 'PAGAMENTO_NORMAL_REGISTRADO',
    nome: 'Pagamento registrado',
    categoria: 'pagamentos',
    secundaria: false,
  });
  assert.equal(presentationFor('reagendamento_parcela').nome, 'Vencimento reagendado');
  assert.equal(presentationFor('NOTIFICACOES_GERADAS').secundaria, true);
});

test('lista em ordem recente, pagina, filtra e pesquisa com dados amigáveis', async () => {
  const f = await fixture();
  try {
    const firstPage = await listActionHistory({ page: 1, limit: 2 }, { dbHandle: f.db });
    assert.deepEqual(firstPage.items.map((item) => item.tipo_canonico), [
      'NOTIFICACOES_GERADAS',
      'PAGAMENTO_NORMAL_REGISTRADO',
    ]);
    assert.equal(firstPage.pagination.total, 4);
    assert.equal(firstPage.pagination.has_more, true);
    assert.equal(firstPage.items[1].nome, 'Pagamento registrado');
    assert.equal(firstPage.items[1].cliente.nome, 'Ana Souza');
    assert.equal(firstPage.items[1].valor, 300);

    const clients = await listActionHistory({ category: 'clientes' }, { dbHandle: f.db });
    assert.deepEqual(clients.items.map((item) => item.tipo_canonico), ['CLIENTE_EDITADO']);
    const loans = await listActionHistory({ category: 'emprestimos' }, { dbHandle: f.db });
    assert.deepEqual(loans.items.map((item) => item.tipo_canonico), ['EMPRESTIMO_CRIADO']);
    const payments = await listActionHistory({ category: 'pagamentos' }, { dbHandle: f.db });
    assert.deepEqual(payments.items.map((item) => item.tipo_canonico), ['PAGAMENTO_NORMAL_REGISTRADO']);
    const financial = await listActionHistory({ category: 'financeiro' }, { dbHandle: f.db });
    assert.deepEqual(financial.items.map((item) => item.tipo_canonico), ['PAGAMENTO_NORMAL_REGISTRADO']);
    const search = await listActionHistory({ search: 'Ana' }, { dbHandle: f.db });
    assert.equal(search.items.length, 3);
  } finally {
    await f.close();
  }
});

test('detalhe entrega snapshots estruturados e nenhuma consulta altera tabelas', async () => {
  const f = await fixture();
  try {
    const before = await databaseState(f.db);
    const detail = await getActionHistoryDetail(
      '00000000-0000-4000-8000-000000000003',
      { dbHandle: f.db }
    );
    assert.equal(detail.nome, 'Pagamento registrado');
    assert.equal(detail.snapshots.length, 2);
    assert.equal(detail.snapshots[0].dados.estado.emprestimo.saldo_devedor, 1000);
    assert.deepEqual(detail.entidades, [{ entidade: 'clientes', entidade_uid: 'cliente-ana', papel: 'relacionado' }]);
    await listActionHistory({ page: 1, limit: 20, search: 'pagamento' }, { dbHandle: f.db });
    const after = await databaseState(f.db);
    assert.deepEqual(after, before);
  } finally {
    await f.close();
  }
});

test('valida paginação, categoria e pesquisa sem executar consultas permissivas', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => listActionHistory({ page: 0 }, { dbHandle: f.db }), /paginação/);
    await assert.rejects(() => listActionHistory({ limit: 51 }, { dbHandle: f.db }), /paginação/);
    await assert.rejects(() => listActionHistory({ category: 'inexistente' }, { dbHandle: f.db }), /categoria/);
    await assert.rejects(() => listActionHistory({ search: 'x'.repeat(121) }, { dbHandle: f.db }), /120/);
  } finally {
    await f.close();
  }
});
