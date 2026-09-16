// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const backendPortArg = process.argv.find((arg) =>
  String(arg).startsWith('--app-backend-port=')
);
const backendPort = Number(String(backendPortArg || '').split('=')[1]) || 3001;

contextBridge.exposeInMainWorld('runtimeConfig', {
  apiBaseUrl: `http://127.0.0.1:${backendPort}`,
});

try {
  console.info('[preload][whatsapp] preload carregado.');
} catch (_) {}

contextBridge.exposeInMainWorld('updates', {
  check: () => ipcRenderer.invoke('updates/check'),
  download: () => ipcRenderer.invoke('updates/download'),
  apply: () => ipcRenderer.invoke('updates/apply'),
  getStatus: () => ipcRenderer.invoke('updates/getStatus'),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('updates/status', handler);
    return () => ipcRenderer.removeListener('updates/status', handler);
  }
});

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app/version')
});

contextBridge.exposeInMainWorld('appZoom', {
  get: () => ipcRenderer.invoke('zoom/get'),
  step: (direction, source = 'manual') =>
    ipcRenderer.invoke('zoom/step', { direction, source }),
  reset: () => ipcRenderer.invoke('zoom/reset'),
});

contextBridge.exposeInMainWorld('assistantVoice', {
  requestMicrophoneAccess: () => ipcRenderer.invoke('assistant/request-microphone'),
});

const appExternalApi = {
  open: (url) => {
    try {
      console.info('[preload][whatsapp] appExternal.open chamado');
    } catch (_) {}
    return ipcRenderer.invoke('external/open', { url });
  },
  openWhatsApp: (payload) => {
    const mode = payload && payload.mode ? String(payload.mode) : 'desktop';
    const disableFallback = Boolean(payload && payload.disableFallback);
    try {
      console.info(
        `[preload][whatsapp] appExternal.openWhatsApp chamado mode=${mode} disableFallback=${disableFallback}`
      );
    } catch (_) {}
    return ipcRenderer.invoke('whatsapp/open', payload || {});
  },
};

contextBridge.exposeInMainWorld('appExternal', appExternalApi);
try {
  console.info(
    `[preload][whatsapp] appExternal exposto (open=${typeof appExternalApi.open}, openWhatsApp=${typeof appExternalApi.openWhatsApp})`
  );
} catch (_) {}
