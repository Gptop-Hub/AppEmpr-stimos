const sqlite3 = require('sqlite3').verbose();
const { ensureActionContractReady } = require('./actionIdentityService');
const { ensureEntityIdentityV1 } = require('./entityIdentityService');
const { capturarEstadoCliente } = require('./clienteActionService');

function clienteIdValido(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value).trim())) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function erro(status, message) {
  return Object.assign(new Error(message), { status });
}

// Uma conexão exclusiva impede que operações de outras requisições entrem
// na transação de edição e sejam afetadas por seu eventual rollback.
async function salvarEdicaoCliente({ dbPath, idAtual, novoId, cpf, sql, valores, registrarAcao = null }) {
  const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
  connection.configure('busyTimeout', 5000);
  const run = (query, params = []) => new Promise((resolve, reject) => {
    connection.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
  const get = (query, params = []) => new Promise((resolve, reject) => {
    connection.get(query, params, (err, row) => err ? reject(err) : resolve(row));
  });
  let emTransacao = false;
  try {
    await run('PRAGMA foreign_keys = ON');
    if (registrarAcao) {
      await ensureEntityIdentityV1(connection);
      await ensureActionContractReady(connection);
    }
    await run('BEGIN IMMEDIATE');
    emTransacao = true;
    // Os telefones antigos não possuem ON UPDATE CASCADE. Adiamos a
    // verificação até o COMMIT, mantendo a fiscalização das foreign keys.
    await run('PRAGMA defer_foreign_keys = ON');
    if (!await get('SELECT id FROM clientes WHERE id = ?', [idAtual])) {
      throw erro(404, 'Cliente não encontrado.');
    }
    const antes = registrarAcao
      ? await capturarEstadoCliente(idAtual, { dbHandle: connection })
      : null;
    if (novoId !== idAtual && await get('SELECT id FROM clientes WHERE id = ?', [novoId])) {
      throw erro(409, `Já existe um cliente com o ID ${novoId}.`);
    }
    if (await get("SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND id != ? LIMIT 1", [cpf, idAtual])) {
      throw erro(409, 'CPF já cadastrado para outro cliente.');
    }
    if (novoId !== idAtual) {
      await run(`UPDATE emprestimos
        SET codigo_cliente = CASE WHEN codigo_cliente LIKE ? THEN ? || substr(codigo_cliente, ?) ELSE codigo_cliente END,
            cliente_id = ? WHERE cliente_id = ?`,
      [`${idAtual}-%`, `${novoId}-`, String(idAtual).length + 2, novoId, idAtual]);
      await run('UPDATE caixa_movimentos SET cliente_id = ? WHERE cliente_id = ?', [novoId, idAtual]);
      await run('UPDATE clientes_telefones SET cliente_id = ? WHERE cliente_id = ?', [novoId, idAtual]);
    }
    await run(sql, valores);
    if (registrarAcao) {
      const depois = await capturarEstadoCliente(novoId, { dbHandle: connection });
      await registrarAcao({ dbHandle: connection, antes, depois });
    }
    await run('COMMIT');
    emTransacao = false;
  } catch (err) {
    if (emTransacao) await run('ROLLBACK');
    if (String(err.message).includes('UNIQUE constraint failed: clientes.id')) {
      throw erro(409, `Já existe um cliente com o ID ${novoId}.`);
    }
    if (String(err.message).includes('UNIQUE constraint failed: clientes.cpf')) {
      throw erro(409, 'CPF já cadastrado para outro cliente.');
    }
    throw err;
  } finally {
    await new Promise((resolve, reject) => connection.close((err) => err ? reject(err) : resolve()));
  }
}

module.exports = { clienteIdValido, salvarEdicaoCliente };
