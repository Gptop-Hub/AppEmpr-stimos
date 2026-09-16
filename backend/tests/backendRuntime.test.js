const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const test = require('node:test');

const {
  isExpectedBackendHealth,
  isPortReachable,
  requestBackendHealth,
  selectBackendPort,
} = require('../utils/backendRuntime');

function listenAsync(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeAsync(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('aceita somente health do diretorio de dados esperado', () => {
  const health = {
    ok: true,
    service: 'app-emprestimos-backend',
    appDataDir: 'C:\\Users\\teste\\AppData\\Roaming\\app-emprestimos',
    dbPath: 'C:\\Users\\teste\\AppData\\Roaming\\app-emprestimos\\emprestimos-data\\database.db',
  };

  assert.equal(
    isExpectedBackendHealth(
      health,
      'C:\\Users\\teste\\AppData\\Roaming\\app-emprestimos'
    ),
    true
  );
  assert.equal(
    isExpectedBackendHealth(health, 'C:\\Projetos\\Sistema de emprestimos'),
    false
  );
  assert.equal(isExpectedBackendHealth({ ...health, service: undefined }, null), false);
  assert.equal(isExpectedBackendHealth({ ok: true }, null), false);
});

test('nao considera HTML do Vite como health do backend', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Vite</title>');
  });
  t.after(() => closeAsync(server));
  const port = await listenAsync(server);

  assert.equal(await requestBackendHealth({ port }), null);
});

test('pula porta ocupada por frontend e escolhe uma porta livre', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Frontend</title>');
  });
  t.after(() => closeAsync(server));
  const occupiedPort = await listenAsync(server);

  assert.equal(await isPortReachable({ port: occupiedPort }), true);

  const selected = await selectBackendPort({
    preferredPort: occupiedPort,
    expectedAppDataDir: path.join(process.cwd(), 'dados-esperados-do-teste'),
    maxAttempts: 20,
  });

  assert.notEqual(selected.port, occupiedPort);
  assert.equal(selected.reuse, false);
  assert.equal(selected.conflicts[0].port, occupiedPort);
});
