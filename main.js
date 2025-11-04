// main.js (com auto-update e backup antes de aplicar)
const { app, BrowserWindow, dialog, Menu, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { autoUpdater } = require('electron-updater');

function getLogsDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}
function writeLog(name, text) {
  const file = path.join(getLogsDir(), name);
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`); } catch(_) {}
  return file;
}

function requestPing(host = '127.0.0.1', port = 3001, timeout = 800) {
  return new Promise(resolve => {
    const req = http.request({ method: 'GET', host, port, path: '/health', timeout }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch(_){} resolve(false); });
    req.end();
  });
}

// >>> Backend inline (require)
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

  process.env.APP_DATA_DIR = app.getPath('userData');
  process.env.HOST_BIND = host;
  process.env.PORT = String(port);
  process.env.BACKEND_LOG = path.join(getLogsDir(), 'backend.log');

  writeLog('main.log', `[backend] iniciando INLINE -> ${entry}`);
  try {
    require(entry);
  } catch (e) {
    writeLog('main.log', `[backend] require falhou: ${e && e.stack || e}`);
    return false;
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await requestPing(host, port, 800)) {
      writeLog('main.log', `[backend] UP em http://${host}:${port} (inline)`);
      return true;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const mainLog = path.join(getLogsDir(), 'main.log');
  const backendLog = path.join(getLogsDir(), 'backend.log');
  dialog.showErrorBox(
    'Backend não iniciou',
    `Mesmo inline, o servidor não respondeu /health.\n\nVerifique os logs:\n- ${mainLog}\n- ${backendLog}`
  );
  return false;
}

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

let mainWindow;
function sendUpdateStatus(payload) {
  try { mainWindow?.webContents.send('updates/status', payload); } catch (_) {}
}

// AutoUpdater
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ stage: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ stage: 'available', info }));
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus({ stage: 'none', info }));
  autoUpdater.on('error', (err) => {
    sendUpdateStatus({ stage: 'error', message: err?.message || String(err) });
    writeLog('main.log', `[autoUpdater] error: ${err && err.stack || err}`);
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({ stage: 'downloading', progress: p && p.percent || 0 });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ stage: 'downloaded', info });
  });
}

// snapshot backup antes de aplicar update
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

  const template = [
    {
      label: 'Exibir',
      submenu: [
        {
          label: 'Alternar DevTools',
          accelerator: 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.closeDevTools();
            } else {
              mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
              setTimeout(() => { try { mainWindow.focus(); } catch(_){} }, 50);
            }
          },
        },
        { role: 'reload' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (!app.isPackaged) {
    const devUrl = await detectRendererDevServer();
    if (devUrl) {
      await mainWindow.loadURL(devUrl);
      return mainWindow;
    }
  }

  const candidates = [
    path.join(__dirname, 'frontend', 'dist', 'index.html'),
    path.join(__dirname, 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      await mainWindow.loadFile(p);
      return mainWindow;
    }
  }

  await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <h3>Build não encontrado</h3>
    <p>Rode <code>npm run build:renderer</code> na pasta raiz antes.</p>
  `));
  return mainWindow;
}

// IPCs
ipcMain.handle('app/version', () => app.getVersion());
ipcMain.handle('updates/check', async () => {
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, r };
  } catch (e) {
    writeLog('main.log', `[updates/check] ${e && e.stack || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('updates/download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    writeLog('main.log', `[updates/download] ${e && e.stack || e}`);
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('updates/apply', async () => {
  const backup = await makeSnapshotBackup();
  sendUpdateStatus({ stage: 'backup', result: backup });
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 500);
  return { ok: true, backup };
});

app.on('ready', async () => {
  try {
    const ok = await startBackendInline();
    if (!ok) writeLog('main.log', '[startup] backend NÃO subiu (inline).');
  } catch (e) {
    writeLog('main.log', `[startup] erro: ${e && e.stack || e}`);
  }

  setupAutoUpdater();
  await createWindow();

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(()=>{});
  }, 3000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });