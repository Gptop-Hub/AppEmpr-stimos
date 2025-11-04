// main.js (cole substituindo o existente)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

let backendProc = null;
let frontendProc = null;

function requestPing(host = '127.0.0.1', port = 3001, timeout = 1200) {
  return new Promise(resolve => {
    const req = http.request({ method: 'GET', host, port, path: '/', timeout }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function startBackendIfNeeded() {
  const host = '127.0.0.1';
  const port = process.env.BACKEND_PORT ? Number(process.env.BACKEND_PORT) : 3001;
  if (await requestPing(host, port, 800)) {
    console.info('Backend já respondendo em', `${host}:${port}`);
    return null;
  }

  const candidates = [
    path.join(__dirname, 'backend', 'server.js'),
    path.join(__dirname, 'backend', 'index.js'),
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'index.js')
  ];
  const entry = candidates.find(p => fs.existsSync(p));
  if (!entry) {
    console.warn('startBackendIfNeeded: nenhum entrypoint do backend encontrado. Pulando start do backend.');
    return null;
  }

  return new Promise((resolve, reject) => {
    console.info('Iniciando backend ->', entry);
    backendProc = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    backendProc.stdout?.on('data', d => process.stdout.write(`[backend] ${d}`));
    backendProc.stderr?.on('data', d => process.stderr.write(`[backend.err] ${d}`));
    backendProc.on('exit', code => console.info('Backend finalizou com código', code));

    const deadline = Date.now() + 20000; // 20s timeout
    const ping = async () => {
      if (await requestPing(host, port, 1200)) return resolve({ host, port });
      if (Date.now() > deadline) return reject(new Error('Timeout esperando backend subir'));
      setTimeout(ping, 300);
    };
    setTimeout(() => { if (backendProc.killed) return reject(new Error('Backend saiu imediatamente')); ping(); }, 200);
  });
}

/**
 * tenta detectar servidor renderer em portas conhecidas;
 * se não encontrar, tenta automaticamente iniciar `npm run dev` dentro de ./frontend (dev-only helper)
 */
async function getOrStartRendererDevServer() {
  const host = '127.0.0.1';
  const knownPorts = [3000, 5173];

  // tenta detectar já ativo
  for (const port of knownPorts) {
    if (await requestPing(host, port, 800)) {
      return { host, port, url: `http://${host}:${port}` };
    }
  }

  // se não há, tenta iniciar frontend dev (se existir pasta frontend)
  const frontendDir = path.join(__dirname, 'frontend');
  if (fs.existsSync(frontendDir) && fs.existsSync(path.join(frontendDir, 'package.json'))) {
    console.info('Nenhum dev-server detectado; iniciando automaticamente "npm run dev" em /frontend...');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    frontendProc = spawn(npmCmd, ['run', 'dev'], { cwd: frontendDir, env: process.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    frontendProc.stdout?.on('data', d => process.stdout.write(`[frontend] ${d}`));
    frontendProc.stderr?.on('data', d => process.stderr.write(`[frontend.err] ${d}`));
    frontendProc.on('exit', code => console.info('Frontend dev server finalizou com código', code));

    // aguarda até uma das portas responder (timeout total)
    const deadline = Date.now() + 30000; // 30s
    while (Date.now() < deadline) {
      for (const port of knownPorts) {
        if (await requestPing(host, port, 1000)) {
          return { host, port, url: `http://${host}:${port}` };
        }
      }
      // espera um pouco e tenta de novo
      await new Promise(r => setTimeout(r, 500));
    }
    console.warn('Timeout: frontend dev server não respondeu após iniciar processo.');
  }

  return null;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico')) ? path.join(__dirname, 'build', 'icon.ico') : (fs.existsSync(path.join(__dirname, 'icon.ico')) ? path.join(__dirname, 'icon.ico') : undefined)
  });

  // abre DevTools para debug
  win.webContents.openDevTools({ mode: 'detach' });

  // detecta ou inicia o dev-server do renderer
  const server = await getOrStartRendererDevServer();
  if (server) {
    try {
      console.info('Carregando renderer em', server.url);
      await win.loadURL(server.url);
      return win;
    } catch (e) {
      console.error('Erro ao carregar dev server:', e && e.message);
    }
  } else {
    console.warn('Nenhum dev server encontrado/ativo.');
  }

  // fallback: arquivos buildados
  const candidates = [
    path.join(__dirname, 'frontend', 'dist', 'index.html'),
    path.join(__dirname, 'frontend', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { await win.loadFile(p); return win; } 
      catch (e) { console.error('Erro ao carregar arquivo estático:', p, e && e.message); }
    }
  }

  // fallback final com instruções
  const html = `
    <html><body style="font-family:Segoe UI,sans-serif;padding:24px;">
      <h2>Não foi possível carregar a interface</h2>
      <p>Opções:</p>
      <ol>
        <li>Rode manualmente o frontend: <code>cd frontend && npm run dev</code> e recarregue.</li>
        <li>Ou gere o build: <code>cd frontend && npm run build</code> e depois reabra o app.</li>
      </ol>
      <pre>${JSON.stringify(candidates, null, 2)}</pre>
    </body></html>
  `;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

app.on('ready', async () => {
  try {
    await startBackendIfNeeded().catch(e => console.warn('Falha ao iniciar backend:', e && e.message));
  } catch (err) {
    console.error('Erro iniciando backend:', err && err.message);
  }

  await createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  if (backendProc) try { backendProc.kill(); } catch (e) {}
  if (frontendProc) try { frontendProc.kill(); } catch (e) {}
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });