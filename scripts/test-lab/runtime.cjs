'use strict';
// Development only. Never import the application's database singleton: it opens the user DB.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sqlite3 = createRequire(require.resolve('../../backend/package.json'))('sqlite3');
const { runAsync: run, getAsync: get, allAsync: all } = require('../../backend/utils/sqliteAsync');
const ROOT = path.resolve(__dirname, '../..');
const LAB = path.join(ROOT, '.test-lab');
const SEED = 'LAB-EMPRESTIMOS-10PCT-V1';
const DATE = '2026-09-14';
const STAMP = `${DATE}T12:00:00.000Z`;
const mark = id => `[${SEED}:${id}] DADOS FICTICIOS DE TESTE`;
function guard() {
  if (path.resolve(process.cwd()).toLowerCase() !== ROOT.toLowerCase()) throw Error('Workspace errado. Nenhuma alteração feita.');
  if (process.env.NODE_ENV === 'production' || process.versions.electron || ROOT.includes('app.asar') || !fs.existsSync(path.join(ROOT, '.git'))) throw Error('Laboratório exclusivo do checkout de desenvolvimento, executado por Node.');
}
async function open(file) {
  const db = await new Promise((resolve, reject) => { const d = new sqlite3.Database(file, e => e ? reject(e) : resolve(d)); });
  await run(db, 'PRAGMA foreign_keys = ON');
  return db;
}
const close = db => new Promise((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
async function schema(db) {
  // Capture the real schema declarations without evaluating openConnection or paths.js.
  const source = fs.readFileSync(path.join(ROOT, 'backend/models/database.js'), 'utf8');
  const start = source.indexOf('function ensureSchema(db) {');
  const end = source.indexOf('\nfunction configureConnection', start);
  if (start < 0 || end < 0) throw Error('Modelo PC mudou: revisar extrator do laboratório.');
  const statements = [];
  vm.runInNewContext(`${source.slice(start, end)}\nensureSchema(db);`, {
    db: { run: sql => statements.push(sql) }, applyMigrations() {}, backfillJurosPendentes() {}, sanitizeDataPagamentoParcelas() {},
  }, { timeout: 1000 });
  if (statements.length < 10) throw Error('Schema incompleto.');
  for (const sql of statements) await run(db, sql);
  const migrationBody = source.slice(source.indexOf('function applyMigrations(db)'), source.indexOf('function backfillJurosPendentes'));
  const migrations = [...migrationBody.matchAll(/applyMigrationIfMissing\(\s*db,\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'/g)];
  for (const [, file, table, column] of migrations) {
    if ((await all(db, `PRAGMA table_info("${table}")`)).some(c => c.name === column)) continue;
    const sql = fs.readFileSync(path.join(ROOT, 'backend/models/migrations', file), 'utf8');
    await new Promise((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
  }
  // Existing startup migrations also supply these; no new schema is introduced.
  if (!(await all(db, 'PRAGMA table_info(parcelas_originais)')).some(c => c.name === 'explicacao')) await run(db, 'ALTER TABLE parcelas_originais ADD COLUMN explicacao TEXT');
  await new Promise((resolve, reject) => db.exec(fs.readFileSync(path.join(ROOT, 'backend/models/migrations/notificacoes.sql'), 'utf8'), e => e ? reject(e) : resolve()));
}
function bindReference(db) {
  const filename = require.resolve('../../backend/models/database');
  if (require.cache[filename]) throw Error('Banco singleton já carregado; isolamento não garantido.');
  require.cache[filename] = { id: filename, filename, loaded: true, exports: db };
}
function fixedClock() {
  process.env.TZ = 'UTC';
  const NativeDate = Date;
  let instant = STAMP;
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return new NativeDate(instant).getTime(); }
  };
  return date => { instant = `${date}T12:00:00.000Z`; };
}
async function invoke(handler, body, params = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(n) { status = n; return this; }, json(value) { status >= 400 ? reject(Error(`PC ${status}: ${JSON.stringify(value)}`)) : resolve(value); } };
    Promise.resolve(handler({ body, params }, res)).catch(reject);
  });
}
function route(router, pattern, method = 'post') {
  const layer = router.stack.find(l => l.route?.path === pattern && l.route.methods[method]);
  if (!layer || layer.route.stack.length !== 1) throw Error(`Rota PC não suportada: ${pattern}`);
  return layer.route.stack[0].handle;
}
module.exports = { fs, path, ROOT, LAB, SEED, DATE, STAMP, mark, guard, open, close, schema, bindReference, fixedClock, invoke, route, run, get, all };
