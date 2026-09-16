const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const backendEntry = path.resolve(__dirname, '../index.js');
const projectRoot = path.resolve(__dirname, '../..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startBackend(appDataDir) {
  if (!fs.existsSync(path.join(appDataDir, 'emprestimos-data', 'database.db'))) {
    const initialized = spawnSync(
      process.execPath,
      ['-e', "const db=require('./backend/models/database');setTimeout(()=>db.closeConnection().catch(()=>{}),1000)"],
      {
        cwd: projectRoot,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, APP_DATA_DIR: appDataDir },
        timeout: 10000,
      }
    );
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  }
  const port = await freePort();
  let logs = '';
  const child = spawn(process.execPath, [backendEntry], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      APP_DATA_DIR: appDataDir,
      PORT: String(port),
      BACKEND_PORT: String(port),
      NOTIFICACOES_SCHEDULER: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Backend encerrou antes de iniciar.\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        return {
          port,
          child,
          logs: () => logs,
          async stop() {
            if (child.exitCode != null) return;
            child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
          },
        };
      }
    } catch {
      // O servidor ainda esta iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Backend nao iniciou no prazo.\n${logs}`);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

test('backup e restauração preservam fotos disponíveis mesmo com fotos ausentes na origem e no destino', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fotos-integracao-'));
  const sourceRoot = path.join(root, 'origem');
  const targetRoot = path.join(root, 'destino');
  let source = null;
  let target = null;
  try {
    source = await startBackend(sourceRoot);
    const sourceUrl = `http://127.0.0.1:${source.port}`;
    const cliente = await jsonRequest(`${sourceUrl}/clientes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: 'Cliente com foto',
        cpf: '12345678901',
        telefone: '(11) 99999-9999',
        criadoEm: '2026-09-15',
      }),
    });

    const photoBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const photoForm = new FormData();
    photoForm.append('foto', new Blob([photoBytes], { type: 'image/png' }), 'cliente.png');
    const withPhoto = await jsonRequest(`${sourceUrl}/clientes/${cliente.id}/foto`, {
      method: 'POST',
      body: photoForm,
    });
    assert.match(withPhoto.foto_cliente, /^cliente-\d+-[a-f0-9-]+\.png$/i);

    async function cadastrarFotoAusente(baseUrl, appDataRoot) {
      const extra = await jsonRequest(`${baseUrl}/clientes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: 'Foto ausente de teste', cpf: '98765432100', telefone: '(11) 98888-7777', criadoEm: '2026-09-15' }),
      });
      const form = new FormData();
      form.append('foto', new Blob([photoBytes], { type: 'image/png' }), 'teste.png');
      const uploaded = await jsonRequest(`${baseUrl}/clientes/${extra.id}/foto`, { method: 'POST', body: form });
      assert.match(uploaded.foto_cliente, /^cliente-\d+-[a-f0-9-]+\.png$/i);
      // Somente arquivo criado por este teste, dentro do seu diretório temporário.
      fs.unlinkSync(path.join(appDataRoot, 'emprestimos-data', 'uploads', 'client-photos', uploaded.foto_cliente));
    }
    await cadastrarFotoAusente(sourceUrl, sourceRoot);

    const download = await fetch(`${sourceUrl}/backup/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-backup-format-version'), '2');
    assert.equal(download.headers.get('x-backup-photo-count'), '1');
    const bundle = Buffer.from(await download.arrayBuffer());
    assert(bundle.length > photoBytes.length);
    await source.stop();
    source = null;

    target = await startBackend(targetRoot);
    const targetUrl = `http://127.0.0.1:${target.port}`;
    await cadastrarFotoAusente(targetUrl, targetRoot);
    await jsonRequest(`${targetUrl}/seguranca/protecoes/excluir_cliente/senha`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senhaAtual: '1otimodia', novaSenha: 'senha-do-destino', confirmacao: 'senha-do-destino' }),
    });
    await jsonRequest(`${targetUrl}/seguranca/protecoes/excluir_cliente/estado`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ativo: false, senhaAtual: 'senha-do-destino' }),
    });
    const restoreForm = new FormData();
    restoreForm.append(
      'file',
      new Blob([bundle], { type: 'application/octet-stream' }),
      'transferencia.emprestimos-backup'
    );
    const restored = await jsonRequest(`${targetUrl}/backup/restore`, {
      method: 'POST',
      body: restoreForm,
    });
    assert.equal(restored.formatVersion, 2);
    assert.equal(restored.photosRestored, 1);
    const security = await jsonRequest(`${targetUrl}/seguranca/protecoes/excluir_cliente`);
    assert.equal(security.ativo, false, 'Restore não redefine proteção ou senha do destino');
    assert.ok((await jsonRequest(`${targetUrl}/seguranca/protecoes/excluir_cliente/validar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: 'senha-do-destino' }),
    })).token);

    const clients = await jsonRequest(`${targetUrl}/clientes`);
    assert.equal(clients.length, 2);
    assert.equal(clients[0].nome, 'Cliente com foto');
    assert.equal(clients[0].foto_cliente, withPhoto.foto_cliente);
    const photoResponse = await fetch(`${targetUrl}/clientes/${clients[0].id}/foto`);
    assert.equal(photoResponse.status, 200);
    assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), photoBytes);

  } finally {
    if (source) await source.stop();
    if (target) await target.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
