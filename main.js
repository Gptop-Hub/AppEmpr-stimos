// main.js – robusto para obter app/ipcMain mesmo em ambientes esquisitos
// (fallback para 'electron/main'), updater lazy e IPCs após 'ready'

const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');
const { sanitizePath } = require('./backend/utils/paths');
const {
  isExpectedBackendHealth,
  requestBackendHealth,
  selectBackendPort,
} = require('./backend/utils/backendRuntime');

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
    shell: (e && e.shell) || (em && em.shell),
    net: (e && e.net) || (em && em.net),
    session: (e && e.session) || (em && em.session),
    systemPreferences: (e && e.systemPreferences) || (em && em.systemPreferences),
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
const shell = E.shell;
const net = E.net;
const session = E.session;
const systemPreferences = E.systemPreferences;

if (!app || !BrowserWindow) {
  console.error(
    '[main] Não consegui obter "app"/"BrowserWindow" de electron. ' +
    'Verifique se está rodando com "electron ." a partir da raiz do projeto.'
  );
  process.exit(1);
}

let updater = null; // será carregado lazy em produção
let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let cachedUserDataDir = null;
let updateStatus = { stage: 'idle' };
const UPDATE_BACKGROUND_CHECK_MS = 60 * 1000;
let updateCheckIntervalId = null;
let onWindowFocusCheck = null;
let isUpdateCheckRunning = false;
let splashShownAtMs = 0;
let splashCloseTimer = null;

const SPLASH_SHOW_FALLBACK_MS = 1200;
const MAIN_REVEAL_FAILSAFE_MS = 20000;
const SPLASH_MIN_VISIBLE_MS = 700;
const ZOOM_MIN_FACTOR = 0.8;
const ZOOM_MAX_FACTOR = 1.3;
const ZOOM_DEFAULT_FACTOR = 1.0;
const ZOOM_STEP_FACTOR = 0.05;
const ZOOM_CHANGE_SUPPRESS_AFTER_WHEEL_MS = 140;

let uiPrefsCache = { zoomFactor: ZOOM_DEFAULT_FACTOR };
let lastWheelZoomAtMs = 0;

function resolveUiPrefsPath() {
  return path.join(resolveAsciiAppDataDir(), 'ui-preferences.json');
}

function normalizeZoomFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ZOOM_DEFAULT_FACTOR;
  const snapped = Math.round(n / ZOOM_STEP_FACTOR) * ZOOM_STEP_FACTOR;
  const clamped = Math.min(ZOOM_MAX_FACTOR, Math.max(ZOOM_MIN_FACTOR, snapped));
  return Number(clamped.toFixed(2));
}

function loadUiPreferences() {
  const file = resolveUiPrefsPath();
  try {
    if (!fs.existsSync(file)) {
      uiPrefsCache = { zoomFactor: ZOOM_DEFAULT_FACTOR };
      return uiPrefsCache;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    uiPrefsCache = {
      zoomFactor: normalizeZoomFactor(parsed && parsed.zoomFactor),
    };
    return uiPrefsCache;
  } catch (e) {
    writeLog('main.log', `[prefs] erro ao carregar preferências: ${e && e.stack || e}`);
    uiPrefsCache = { zoomFactor: ZOOM_DEFAULT_FACTOR };
    return uiPrefsCache;
  }
}

function saveUiPreferences() {
  const file = resolveUiPrefsPath();
  const payload = {
    zoomFactor: normalizeZoomFactor(uiPrefsCache && uiPrefsCache.zoomFactor),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    writeLog('main.log', `[prefs] erro ao salvar preferências: ${e && e.stack || e}`);
  }
}

function getCurrentZoomFactor(win) {
  try {
    if (!win || win.isDestroyed()) return normalizeZoomFactor(uiPrefsCache.zoomFactor);
    return normalizeZoomFactor(win.webContents.getZoomFactor());
  } catch (_) {
    return normalizeZoomFactor(uiPrefsCache.zoomFactor);
  }
}

function applyZoomFactor(win, factor, { persist = true } = {}) {
  const next = normalizeZoomFactor(factor);
  if (!win || win.isDestroyed()) return next;
  try { win.webContents.setZoomFactor(next); } catch (_) {}
  if (persist) {
    uiPrefsCache = { ...uiPrefsCache, zoomFactor: next };
    saveUiPreferences();
  }
  return next;
}

function stepZoom(win, direction) {
  const current = getCurrentZoomFactor(win);
  const next = normalizeZoomFactor(current + (direction > 0 ? ZOOM_STEP_FACTOR : -ZOOM_STEP_FACTOR));
  return applyZoomFactor(win, next, { persist: true });
}

function markWheelZoomInteraction() {
  lastWheelZoomAtMs = Date.now();
}

function isRecentWheelZoomInteraction() {
  const elapsed = Date.now() - lastWheelZoomAtMs;
  return elapsed >= 0 && elapsed <= ZOOM_CHANGE_SUPPRESS_AFTER_WHEEL_MS;
}

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

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'icon.ico'),
  ];
  return candidates.find((p) => fs.existsSync(p));
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

// ---------- Backend inline ----------
async function startBackendInline() {
  const host = '127.0.0.1';
  const preferredPort = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);
  const appDataDir = resolveAsciiAppDataDir();
  const expectedAppDataDir = app.isPackaged ? appDataDir : null;
  let selection;

  try {
    selection = await selectBackendPort({
      host,
      preferredPort,
      expectedAppDataDir,
    });
  } catch (err) {
    writeLog('main.log', `[backend] falha ao selecionar porta: ${err && err.stack || err}`);
    return false;
  }

  const port = selection.port;
  process.env.APP_DATA_DIR = appDataDir;
  process.env.BACKEND_PORT = String(port);

  if (selection.conflicts.length > 0) {
    writeLog('main.log', `[backend] conflitos ignorados: ${JSON.stringify(selection.conflicts)}`);
  }

  if (selection.reuse) {
    writeLog(
      'main.log',
      `[backend] instância válida reutilizada em http://${host}:${port} ` +
        `(db=${selection.health && selection.health.dbPath || 'desconhecido'})`
    );
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

  const backendEnv = {
    ...process.env,
    APP_DATA_DIR: appDataDir,
    HOST_BIND: host,
    PORT: String(port),
    BACKEND_PORT: String(port),
    BACKEND_LOG: path.join(getLogsDir(), 'backend.log'),
  };

  writeLog('main.log', `[backend] spawnando processo -> ${entry} (porta=${port})`);
  backendProcess = fork(entry, [], { env: backendEnv, stdio: 'inherit' });

  backendProcess.on('exit', (code, signal) => {
    writeLog('main.log', `[backend] processo saiu (code=${code} signal=${signal})`);
    backendProcess = null;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const health = await requestBackendHealth({ host, port, timeout: 800 });
    if (isExpectedBackendHealth(health, expectedAppDataDir)) {
      writeLog(
        'main.log',
        `[backend] UP em http://${host}:${port} (fork, db=${health.dbPath})`
      );
      return true;
    }
    if (!backendProcess) {
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

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
  updateStatus = {
    ...(updateStatus || {}),
    ...(payload || {}),
    stage: payload && payload.stage ? payload.stage : (updateStatus && updateStatus.stage) || 'idle',
  };
  try { mainWindow?.webContents.send('updates/status', updateStatus); } catch (_) {}
}

async function checkForUpdatesSafely(source = 'background', throwOnError = false) {
  const statusSnapshot = () => updateStatus || { stage: 'idle' };
  if (!updater) {
    return { started: false, skipped: 'updater-unavailable', status: statusSnapshot() };
  }
  if (isUpdateCheckRunning) {
    return { started: false, skipped: 'already-running', status: statusSnapshot() };
  }

  const currentStage = (updateStatus && updateStatus.stage) || 'idle';
  if (currentStage === 'downloading' || currentStage === 'downloaded' || currentStage === 'backup') {
    return { started: false, skipped: 'stage-blocked', status: statusSnapshot() };
  }

  isUpdateCheckRunning = true;
  try {
    const result = await updater.checkForUpdates();
    return { started: true, skipped: null, result, status: statusSnapshot() };
  } catch (e) {
    writeLog('main.log', `[autoUpdater/check:${source}] ${e && e.stack || e}`);
    if (throwOnError) throw e;
    return { started: false, skipped: 'error', status: statusSnapshot() };
  } finally {
    isUpdateCheckRunning = false;
  }
}

function stopBackgroundUpdateChecks() {
  if (updateCheckIntervalId) {
    clearInterval(updateCheckIntervalId);
    updateCheckIntervalId = null;
  }
  if (onWindowFocusCheck) {
    app.removeListener('browser-window-focus', onWindowFocusCheck);
    onWindowFocusCheck = null;
  }
}

function startBackgroundUpdateChecks() {
  if (!updater) return;

  stopBackgroundUpdateChecks();
  updateCheckIntervalId = setInterval(() => {
    checkForUpdatesSafely('interval').catch(() => {});
  }, UPDATE_BACKGROUND_CHECK_MS);

  onWindowFocusCheck = () => {
    checkForUpdatesSafely('focus').catch(() => {});
  };
  app.on('browser-window-focus', onWindowFocusCheck);

  setTimeout(() => {
    checkForUpdatesSafely('startup').catch(() => {});
  }, 3000);
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
    const backendPort = Number(process.env.BACKEND_PORT || 3001);
    const req = net.request(`http://127.0.0.1:${backendPort}/backup/snapshot`);
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

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    writeLog('main.log', '[splash] createSplashWindow chamado com splash já existente.');
    return splashWindow;
  }

  splashShownAtMs = 0;
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer);
    splashCloseTimer = null;
  }

  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    minWidth: 420,
    minHeight: 260,
    maxWidth: 420,
    maxHeight: 260,
    center: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#020617',
    icon: resolveAppIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  writeLog('main.log', '[splash] janela criada.');

  splashWindow.setMenuBarVisibility(false);
  splashWindow.setAlwaysOnTop(true, 'screen-saver');
  writeLog('main.log', '[splash] alwaysOnTop aplicado.');

  let splashShown = false;
  let showFallbackTimer = null;

  const clearFallbackTimer = () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
  };

  const ensureSplashVisible = (reason) => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    if (!splashShown) {
      try {
        splashWindow.show();
        splashWindow.moveTop();
        splashWindow.focus();
      } catch (_) {}
      splashShown = true;
      splashShownAtMs = Date.now();
      writeLog('main.log', `[splash] mostrada (${reason}).`);
    }
    clearFallbackTimer();
  };

  splashWindow.once('ready-to-show', () => {
    writeLog('main.log', '[splash] evento ready-to-show disparou.');
    ensureSplashVisible('ready-to-show');
  });
  splashWindow.webContents.on('did-finish-load', () => {
    writeLog('main.log', '[splash] conteúdo carregado (did-finish-load).');
    ensureSplashVisible('did-finish-load');
  });
  splashWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    writeLog('main.log', `[splash] did-fail-load code=${code} desc=${desc}`);
    ensureSplashVisible('did-fail-load');
  });
  splashWindow.on('closed', () => {
    clearFallbackTimer();
    if (splashCloseTimer) {
      clearTimeout(splashCloseTimer);
      splashCloseTimer = null;
    }
    splashShownAtMs = 0;
    splashWindow = null;
    writeLog('main.log', '[splash] janela encerrada.');
  });

  const splashFile = path.join(__dirname, 'splash.html');
  showFallbackTimer = setTimeout(() => {
    writeLog('main.log', '[splash] fallback de exibição acionado.');
    ensureSplashVisible('fallback-timer');
  }, SPLASH_SHOW_FALLBACK_MS);

  if (fs.existsSync(splashFile)) {
    writeLog('main.log', `[splash] carregando arquivo: ${splashFile}`);
    splashWindow.loadFile(splashFile).catch((err) => {
      writeLog('main.log', `[splash] falha ao carregar splash.html: ${err && err.stack || err}`);
      try {
        splashWindow?.loadURL(
          'data:text/html;charset=utf-8,' +
          encodeURIComponent('<body style="background:#020617;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;">Inicializando sistema...</body>')
        );
      } catch (_) {}
    });
  } else {
    writeLog('main.log', '[splash] splash.html não encontrado, usando fallback.');
    splashWindow.loadURL(
      'data:text/html;charset=utf-8,' +
      encodeURIComponent('<body style="background:#020617;color:#e5e7eb;font-family:sans-serif;display:flex;align-items:center;justify-content:center;">Inicializando sistema...</body>')
    ).catch(() => {});
  }

  // Garante visibilidade imediata (não depende apenas de ready-to-show).
  ensureSplashVisible('immediate');

  return splashWindow;
}

function closeSplashWindow(reason = 'manual') {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }

  const closeNow = () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.close(); } catch (_) {}
    }
    splashWindow = null;
    if (splashCloseTimer) {
      clearTimeout(splashCloseTimer);
      splashCloseTimer = null;
    }
    splashShownAtMs = 0;
    writeLog('main.log', `[splash] fechamento solicitado (${reason}).`);
  };

  const elapsed = splashShownAtMs ? (Date.now() - splashShownAtMs) : SPLASH_MIN_VISIBLE_MS;
  if (elapsed >= SPLASH_MIN_VISIBLE_MS) {
    closeNow();
    return;
  }

  const waitMs = SPLASH_MIN_VISIBLE_MS - elapsed;
  writeLog(
    'main.log',
    `[splash] aguardando ${waitMs}ms para fechar (${reason}); tempo visível atual=${elapsed}ms.`
  );
  if (splashCloseTimer) clearTimeout(splashCloseTimer);
  splashCloseTimer = setTimeout(() => {
    splashCloseTimer = null;
    closeNow();
  }, waitMs);
}

// ---------- Cria janela principal ----------
async function createMainWindow({ closeSplashOnReady = false } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    writeLog('main.log', '[main] createMainWindow chamado com main já existente.');
    return mainWindow;
  }

  let didRevealMainWindow = false;
  const revealMainWindow = () => {
    if (didRevealMainWindow) return;
    didRevealMainWindow = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { if (!mainWindow.isVisible()) mainWindow.show(); } catch (_) {}
      try { mainWindow.focus(); } catch (_) {}
      writeLog('main.log', '[main] janela principal mostrada.');
    }
    if (closeSplashOnReady) {
      closeSplashWindow('main-ready');
    }
  };

  const backendPort = Number(process.env.BACKEND_PORT || 3001);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: '#020617',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--app-backend-port=${backendPort}`],
    },
    icon: resolveAppIconPath(),
  });
  writeLog('main.log', '[main] janela principal criada.');
  applyZoomFactor(mainWindow, uiPrefsCache.zoomFactor, { persist: false });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Fallback para gestos nativos de zoom (quando disponíveis no SO/Chromium).
  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    if (isRecentWheelZoomInteraction()) {
      try { event.preventDefault(); } catch (_) {}
      return;
    }
    try { event.preventDefault(); } catch (_) {}
    if (zoomDirection === 'in') {
      stepZoom(mainWindow, +1);
      return;
    }
    if (zoomDirection === 'out') {
      stepZoom(mainWindow, -1);
    }
  });

  // Atalhos de zoom (backup e padrão esperado): Ctrl++ / Ctrl+- / Ctrl+0.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    const ctrlOrCmd = Boolean(input.control || input.meta);
    if (!ctrlOrCmd) return;

    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    const isPlus = key === '+' || key === '=' || code === 'NumpadAdd';
    const isMinus = key === '-' || key === '_' || code === 'NumpadSubtract';
    const isZero = key === '0' || code === 'Numpad0';

    if (isPlus) {
      event.preventDefault();
      stepZoom(mainWindow, +1);
      return;
    }
    if (isMinus) {
      event.preventDefault();
      stepZoom(mainWindow, -1);
      return;
    }
    if (isZero) {
      event.preventDefault();
      applyZoomFactor(mainWindow, ZOOM_DEFAULT_FACTOR, { persist: true });
    }
  });

  mainWindow.once('ready-to-show', () => {
    writeLog('main.log', '[main] evento ready-to-show disparou.');
    revealMainWindow();
  });

  const revealFailsafe = setTimeout(() => {
    writeLog('main.log', '[startup] ready-to-show da main demorou; aplicando reveal em failsafe.');
    revealMainWindow();
  }, MAIN_REVEAL_FAILSAFE_MS);

  mainWindow.webContents.on('did-finish-load', () => {
    writeLog('main.log', '[main] conteúdo carregado (did-finish-load).');
    applyZoomFactor(mainWindow, uiPrefsCache.zoomFactor, { persist: false });
    clearTimeout(revealFailsafe);
    revealMainWindow();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    writeLog('main.log', `[mainWindow] did-fail-load code=${code} desc=${desc}`);
    clearTimeout(revealFailsafe);
    revealMainWindow();
  });
  mainWindow.on('closed', () => clearTimeout(revealFailsafe));

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

function setupMicrophonePermissions() {
  try {
    const ses = session && session.defaultSession ? session.defaultSession : null;
    if (!ses) {
      writeLog('main.log', '[assistente/mic] session.defaultSession indisponível.');
      return;
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_webContents, permission, callback) => {
        if (permission === 'media' || permission === 'microphone') {
          callback(true);
          return;
        }
        callback(true);
      });
    }

    if (typeof ses.setDevicePermissionHandler === 'function') {
      ses.setDevicePermissionHandler((details) => {
        const deviceType = details && details.deviceType ? String(details.deviceType) : '';
        if (deviceType.toLowerCase() === 'audio') return true;
        return false;
      });
    }

    writeLog('main.log', '[assistente/mic] handlers de permissão configurados.');
  } catch (err) {
    writeLog('main.log', `[assistente/mic] erro ao configurar permissões: ${err && err.stack || err}`);
  }
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

  const resolveZoomWindow = (eventLike) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(eventLike && eventLike.sender);
      if (senderWin && !senderWin.isDestroyed()) return senderWin;
    } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) return focused;
    } catch (_) {}
    return null;
  };

  ipcMain.handle('app/version', () => app.getVersion());

  ipcMain.handle('zoom/get', (event) => {
    const win = resolveZoomWindow(event);
    if (!win) return { ok: false, error: 'Janela indisponível.' };
    return { ok: true, zoomFactor: getCurrentZoomFactor(win) };
  });

  ipcMain.handle('zoom/step', (event, payload) => {
    const win = resolveZoomWindow(event);
    if (!win) return { ok: false, error: 'Janela indisponível.' };

    const direction = String(payload && payload.direction || '').toLowerCase();
    if (direction !== 'in' && direction !== 'out') {
      return { ok: false, error: 'Direção inválida. Use "in" ou "out".' };
    }

    const source = String(payload && payload.source || '').toLowerCase();
    if (source === 'wheel' || source === 'pinch') {
      markWheelZoomInteraction();
    }

    const zoomFactor = stepZoom(win, direction === 'in' ? +1 : -1);
    return { ok: true, zoomFactor };
  });

  ipcMain.handle('zoom/reset', (event) => {
    const win = resolveZoomWindow(event);
    if (!win) return { ok: false, error: 'Janela indisponível.' };
    const zoomFactor = applyZoomFactor(win, ZOOM_DEFAULT_FACTOR, { persist: true });
    return { ok: true, zoomFactor };
  });

  ipcMain.handle('external/open', async (_event, payload) => {
    if (!shell || typeof shell.openExternal !== 'function') {
      return { ok: false, error: 'Abertura externa indisponivel neste ambiente.' };
    }

    const rawUrl = String(payload && payload.url ? payload.url : '').trim();
    if (!rawUrl) {
      return { ok: false, error: 'URL ausente.' };
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, error: 'URL invalida.' };
    }

    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol !== 'https:' && protocol !== 'http:') {
      return { ok: false, error: 'Protocolo nao permitido.' };
    }

    try {
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (e) {
      writeLog('main.log', `[external/open] ${e && e.stack || e}`);
      return { ok: false, error: e && e.message ? e.message : 'Falha ao abrir link externo.' };
    }
  });

  ipcMain.handle('whatsapp/open', async (_event, payload) => {
    if (!shell || typeof shell.openExternal !== 'function') {
      return { ok: false, error: 'Abertura externa indisponivel neste ambiente.' };
    }

    const phoneDigits = String(payload && payload.phone ? payload.phone : '').replace(/\D/g, '');
    const message = String(
      payload && (payload.message || payload.text)
        ? (payload.message || payload.text)
        : ''
    ).trim();
    const preferredModeRaw = String(payload && payload.mode ? payload.mode : 'desktop').toLowerCase();
    const preferredMode = preferredModeRaw === 'web' ? 'web' : 'desktop';
    const disableFallback = Boolean(payload && payload.disableFallback);

    const logEntry = `[whatsapp/open] entrada mode=${preferredMode} disableFallback=${disableFallback} phoneDigits=${phoneDigits.length} messageLen=${message.length}`;
    writeLog('main.log', logEntry);
    try { console.info(logEntry); } catch (_) {}

    if (!phoneDigits) {
      writeLog('main.log', '[whatsapp/open] erro: numero invalido.');
      return { ok: false, error: 'Numero de telefone invalido.' };
    }

    if (!message) {
      writeLog('main.log', '[whatsapp/open] erro: mensagem vazia.');
      return { ok: false, error: 'Mensagem vazia.' };
    }

    const desktopUrl =
      `whatsapp://send?phone=${encodeURIComponent(phoneDigits)}&text=${encodeURIComponent(message)}`;
    const webUrl =
      `https://wa.me/${encodeURIComponent(phoneDigits)}?text=${encodeURIComponent(message)}`;

    const tentarDesktop = async () => {
      writeLog('main.log', '[whatsapp/open] tentativa desktop: whatsapp://send?...');
      try { console.info('[whatsapp/open] tentativa desktop'); } catch (_) {}
      await shell.openExternal(desktopUrl);
      writeLog('main.log', '[whatsapp/open] desktop aberto com sucesso.');
      try { console.info('[whatsapp/open] desktop aberto com sucesso'); } catch (_) {}
      return {
        ok: true,
        mode: 'desktop',
        usedFallback: false,
        url: desktopUrl,
      };
    };

    const tentarWeb = async ({ usedFallback, desktopError = null }) => {
      const webLog = usedFallback
        ? '[whatsapp/open] fallback web: https://wa.me/...'
        : '[whatsapp/open] modo web direto: https://wa.me/...';
      writeLog('main.log', webLog);
      try { console.info(webLog); } catch (_) {}
      await shell.openExternal(webUrl);
      writeLog('main.log', '[whatsapp/open] web aberto com sucesso.');
      try { console.info('[whatsapp/open] web aberto com sucesso'); } catch (_) {}
      return {
        ok: true,
        mode: 'web',
        usedFallback,
        url: webUrl,
        desktopError,
      };
    };

    if (preferredMode === 'web') {
      try {
        return await tentarWeb({ usedFallback: false, desktopError: null });
      } catch (errWebDirect) {
        const webDirectError =
          errWebDirect && errWebDirect.message ? errWebDirect.message : String(errWebDirect);
        writeLog('main.log', `[whatsapp/open] web direto falhou: ${webDirectError}`);
        try { console.warn('[whatsapp/open] web direto falhou', webDirectError); } catch (_) {}
        return {
          ok: false,
          error: 'Nao foi possivel abrir o WhatsApp Web.',
          webError: webDirectError,
        };
      }
    }

    let desktopError = null;
    try {
      return await tentarDesktop();
    } catch (errDesktop) {
      desktopError = errDesktop && errDesktop.message ? errDesktop.message : String(errDesktop);
      writeLog('main.log', `[whatsapp/open] desktop falhou: ${desktopError}`);
      try { console.warn('[whatsapp/open] desktop falhou', desktopError); } catch (_) {}
    }

    if (disableFallback) {
      writeLog('main.log', '[whatsapp/open] fallback web desabilitado para diagnostico.');
      try { console.info('[whatsapp/open] fallback web desabilitado para diagnostico'); } catch (_) {}
      return {
        ok: false,
        error: 'Nao foi possivel abrir o WhatsApp Desktop.',
        desktopError,
        fallbackSkipped: true,
      };
    }

    try {
      return await tentarWeb({ usedFallback: true, desktopError });
    } catch (errWeb) {
      const webError = errWeb && errWeb.message ? errWeb.message : String(errWeb);
      writeLog('main.log', `[whatsapp/open] web falhou: ${webError}`);
      try { console.warn('[whatsapp/open] web falhou', webError); } catch (_) {}
      return {
        ok: false,
        error: 'Nao foi possivel abrir o WhatsApp (desktop e web).',
        desktopError,
        webError,
      };
    }
  });

  ipcMain.handle('updates/check', async () => {
    if (!updater) return { ok: false, error: 'Updater indisponível (somente em produção).' };
    try {
      const outcome = await checkForUpdatesSafely('manual-ipc', true);
      return {
        ok: true,
        started: Boolean(outcome && outcome.started),
        skipped: (outcome && outcome.skipped) || null,
        status: (outcome && outcome.status) || updateStatus || { stage: 'idle' },
        result: (outcome && outcome.result) || null,
      };
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

  ipcMain.handle('updates/getStatus', () => updateStatus || { stage: 'idle' });

  ipcMain.handle('assistant/request-microphone', async () => {
    try {
      if (
        process.platform === 'darwin' &&
        systemPreferences &&
        typeof systemPreferences.askForMediaAccess === 'function'
      ) {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return {
          ok: Boolean(granted),
          error: granted ? null : 'Permissão de microfone negada no sistema.',
        };
      }
      return { ok: true, error: null };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : 'Falha ao solicitar permissão de microfone.',
      };
    }
  });
}

// ---------- Lifecycle ----------
app.on('ready', async () => {
  writeLog('main.log', `[startup] evento ready recebido (modo=${app.isPackaged ? 'packaged' : 'dev'}).`);
  loadUiPreferences();
  createSplashWindow();
  writeLog('main.log', '[startup] splash solicitada.');

  let backendReady = false;
  try {
    backendReady = await startBackendInline();
    if (!backendReady) writeLog('main.log', '[startup] backend NÃO subiu (inline).');
  } catch (e) {
    writeLog('main.log', `[startup] erro: ${e && e.stack || e}`);
  }

  if (!backendReady) {
    closeSplashWindow('backend-failed');
    const mainLog = path.join(getLogsDir(), 'main.log');
    const backendLog = path.join(getLogsDir(), 'backend.log');
    dialog.showErrorBox(
      'Backend não iniciou',
      `O aplicativo não abriu para evitar exibir dados vazios.\n\nVerifique os logs:\n- ${mainLog}\n- ${backendLog}`
    );
    app.quit();
    return;
  }

  setupAutoUpdater(); // carrega updater (se empacotado)
  setupMicrophonePermissions();
  registerIpcs();    // registra IPCs com ipcMain garantido
  try {
    await createMainWindow({ closeSplashOnReady: true });
  } catch (e) {
    writeLog('main.log', `[startup/main-window] ${e && e.stack || e}`);
    closeSplashWindow();
    dialog.showErrorBox(
      'Falha ao abrir interface',
      `Não foi possível abrir a janela principal.\n\nDetalhes: ${e?.message || String(e)}`
    );
    return;
  }

  startBackgroundUpdateChecks();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  stopBackgroundUpdateChecks();
  closeSplashWindow();
  if (backendProcess) {
    try { backendProcess.kill('SIGINT'); } catch (_) {}
    backendProcess = null;
  }
});
app.on('activate', () => {
  writeLog('main.log', '[app] activate disparado.');
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow().catch(() => {});
});
