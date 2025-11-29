// main.js – robusto para obter app/ipcMain mesmo em ambientes esquisitos
// (fallback para 'electron/main'), updater lazy e IPCs após 'ready'

const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');
const { sanitizePath } = require('./backend/utils/paths');

// --- Pega referências do Electron de forma robusta ---
function getElectronMainExports() {
  // Primeiro tenta o pacote padrão
  let e = null;
  try { e = require('electron'); } catch (_) {}
  // Se não achou app/ipcMain aqui, tenta o entry do processo principal
  let em = null;
  try { em = require('electron/main'); } catch (_) {}
  // Mescla o que tiver
  return {
    app: (e && e.app) || (em && em.app),
    BrowserWindow: (e && e.BrowserWindow) || (em && em.BrowserWindow),
    dialog: (e && e.dialog) || (em && em.dialog),
    Menu: (e && e.Menu) || (em && em.Menu),
    net: (e && e.net) || (em && em.net),
    // ipcMain só usamos depois do ready, mas deixo aqui também
    ipcMain: (e && e.ipcMain) || (em && em.ipcMain),
    _rawElectron: e || em,
  };
}

const E = getElectronMainExports();
const app = E.app;
const BrowserWindow = E.BrowserWindow;
const dialog = E.dialog;
const Menu = E.Menu;
const net = E.net;

if (!app || !BrowserWindow) {
  console.error(
    '[main] Não consegui obter "app"/"BrowserWindow" de electron. ' +
    'Verifique se está rodando com "electron ." a partir da raiz do projeto.'
  );
  process.exit(1);
}

let updater = null; // será carregado lazy em produção
let mainWindow = null;
let backendProcess = null;
let cachedUserDataDir = null;

function resolveAsciiAppDataDir() {
  if (cachedUserDataDir) return cachedUserDataDir;
  const raw = app.getPath('userData');
  const sanitized = sanitizePath(raw);
  if (sanitized !== raw) {
    console.info(`[main] Normalizando APP_DATA_DIR: ${raw} -> ${sanitized}`);
  }
  try { fs.mkdirSync(sanitized, { recursive: true }); } catch (_) {}
  cachedUserDataDir = sanitized;
  return cachedUserDataDir;
}

// ---------- util de logs ----------
function getLogsDir() {
  const dir = path.join(resolveAsciiAppDataDir(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}
function writeLog(name, text) {
  const file = path.join(getLogsDir(), name);
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`); } catch(_) {}
  return file;
}

// ---------- health ping ----------
function requestPing(host = '127.0.0.1', port = 3001, timeout = 800) {
  return new Promise(resolve => {
    const req = http.request({ method: 'GET', host, port, path: '/health', timeout }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch(_){} resolve(false); });
    req.end();
  });
}

// ---------- Backend inline ----------
async function startBackendInline() {
  const host = '127.0.0.1';
  const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  if (await requestPing(host, port, 500)) {
    writeLog('main.log', `[backend] já estava UP em http://${host}:${port}`);
    return true;
  }

  const candidates = [
    path.join(__dirname, 'backend', 'index.js'),
    path.join(__dirname, 'backend', 'server.js'),
    path.join(__dirname, 'index.js'),
  ];
  const entry = candidates.find(p => fs.existsSync(p));
  if (!entry) {
    writeLog('main.log', '[backend] Nenhum entrypoint encontrado (backend/index.js ou server.js ausente).');
    return false;
  }

  const appDataDir = resolveAsciiAppDataDir();
  const backendEnv = {
    ...process.env,
    APP_DATA_DIR: appDataDir,
    HOST_BIND: host,
    PORT: String(port),
    BACKEND_PORT: String(port),
    BACKEND_LOG: path.join(getLogsDir(), 'backend.log'),
  };

  process.env.APP_DATA_DIR = backendEnv.APP_DATA_DIR;
  process.env.BACKEND_PORT = backendEnv.BACKEND_PORT;

  writeLog('main.log', `[backend] spawnando processo -> ${entry}`);
  backendProcess = fork(entry, [], { env: backendEnv, stdio: 'inherit' });

  backendProcess.on('exit', (code, signal) => {
    writeLog('main.log', `[backend] processo saiu (code=${code} signal=${signal})`);
    backendProcess = null;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await requestPing(host, port, 800)) {
      writeLog('main.log', `[backend] UP em http://${host}:${port} (fork)`);
      return true;
    }
    if (!backendProcess) {
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const mainLog = path.join(getLogsDir(), 'main.log');
  const backendLog = path.join(getLogsDir(), 'backend.log');
  dialog.showErrorBox('Backend não iniciou',
    `Mesmo inline, o servidor não respondeu /health.\n\nVerifique os logs:\n- ${mainLog}\n- ${backendLog}`);
  if (backendProcess) {
    try { backendProcess.kill('SIGINT'); } catch (_) {}
    backendProcess = null;
  }
  return false;
}

// ---------- Detecta dev server do renderer ----------
async function detectRendererDevServer() {
  const host = '127.0.0.1';
  const ports = [3000, 5173];
  for (const port of ports) {
    const ok = await new Promise(resolve => {
      const req = http.request({ method: 'GET', host, port, path: '/', timeout: 600 }, res => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch(_){} resolve(false); });
      req.end();
    });
    if (ok) return `http://${host}:${port}`;
  }
  return null;
}

function sendUpdateStatus(payload) {
  try { mainWindow?.webContents.send('updates/status', payload); } catch (_) {}
}

// ---------- AutoUpdater (lazy; só em produção) ----------
function setupAutoUpdater() {
  try {
    if (!app.isPackaged) {
      writeLog('main.log', '[autoUpdater] ignorado em dev (app não empacotado)');
      return;
    }
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;

    updater.on('checking-for-update', () => sendUpdateStatus({ stage: 'checking' }));
    updater.on('update-available', (info) => sendUpdateStatus({ stage: 'available', info }));
    updater.on('update-not-available', (info) => sendUpdateStatus({ stage: 'none', info }));
    updater.on('error', (err) => {
      sendUpdateStatus({ stage: 'error', message: err?.message || String(err) });
      writeLog('main.log', `[autoUpdater] error: ${err && err.stack || err}`);
    });
    updater.on('download-progress', (p) => {
      sendUpdateStatus({ stage: 'downloading', progress: p && p.percent || 0 });
    });
    updater.on('update-downloaded', (info) => {
      sendUpdateStatus({ stage: 'downloaded', info });
    });
  } catch (e) {
    writeLog('main.log', `[autoUpdater] lazy require falhou: ${e && e.stack || e}`);
  }
}

// ---------- Snapshot antes do update ----------
async function makeSnapshotBackup() {
  return new Promise((resolve) => {
    const req = net.request('http://127.0.0.1:3001/backup/snapshot');
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => data += c.toString('utf8'));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ success: false }); }
      });
    });
    req.on('error', () => resolve({ success: false }));
    req.end();
  });
}

// ---------- Cria janela ----------
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.ico'))
      ? path.join(__dirname, 'build', 'icon.ico')
      : (fs.existsSync(path.join(__dirname, 'icon.ico')) ? path.join(__dirname, 'icon.ico') : undefined),
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  const template = [{
    label: 'Exibir',
    submenu: [
      {
        label: 'Alternar DevTools',
        accelerator: 'Ctrl+Shift+I',
        click: () => {
          if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
          else {
            mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
            setTimeout(() => { try { mainWindow.focus(); } catch(_){} }, 50);
          }
        },
      },
      { role: 'reload' },
      { role: 'togglefullscreen' },
    ],
  }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (!app.isPackaged) {
    const devUrl = await detectRendererDevServer();
    if (devUrl) { await mainWindow.loadURL(devUrl); return mainWindow; }
  }

  const candidates = [
    path.join(__dirname, 'frontend', 'dist', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { await mainWindow.loadFile(p); return mainWindow; }
  }

  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <h3>Build não encontrado</h3>
    <p>Rode <code>npm run build:renderer</code> na pasta raiz antes.</p>
  `));
  return mainWindow;
}

// ---------- Registra IPCs (depois do ready) ----------
function registerIpcs() {
  // Pega ipcMain robusto (padrão + fallback)
  let ipcMain = null;
  try { ipcMain = (require('electron').ipcMain) || (require('electron/main').ipcMain); } catch (_) {}
  if (!ipcMain) {
    writeLog('main.log', '[ipc] ipcMain indisponível');
    return;
  }

  ipcMain.handle('app/version', () => app.getVersion());

  ipcMain.handle('updates/check', async () => {
    if (!updater) return { ok: false, error: 'Updater indisponível (somente em produção).' };
    try {
      const r = await updater.checkForUpdates();
      return { ok: true, r };
    } catch (e) {
      writeLog('main.log', `[updates/check] ${e && e.stack || e}`);
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('updates/download', async () => {
    if (!updater) return { ok: false, error: 'Updater indisponível (somente em produção).' };
    try { await updater.downloadUpdate(); return { ok: true }; }
    catch (e) {
      writeLog('main.log', `[updates/download] ${e && e.stack || e}`);
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('updates/apply', async () => {
    if (!updater) return { ok: false, error: 'Updater indisponível (somente em produção).' };
    const backup = await makeSnapshotBackup();
    sendUpdateStatus({ stage: 'backup', result: backup });
    setTimeout(() => { try { updater.quitAndInstall(false, true); } catch (_) {} }, 500);
    return { ok: true, backup };
  });
}

// ---------- Lifecycle ----------
app.on('ready', async () => {
  try {
    const ok = await startBackendInline();
    if (!ok) writeLog('main.log', '[startup] backend NÃO subiu (inline).');
  } catch (e) {
    writeLog('main.log', `[startup] erro: ${e && e.stack || e}`);
  }

  setupAutoUpdater(); // carrega updater (se empacotado)
  registerIpcs();    // registra IPCs com ipcMain garantido
  await createWindow();

  if (updater) {
    setTimeout(() => { updater.checkForUpdates().catch(()=>{}); }, 3000);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (backendProcess) {
    try { backendProcess.kill('SIGINT'); } catch (_) {}
    backendProcess = null;
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
