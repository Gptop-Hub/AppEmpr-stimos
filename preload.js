// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updates', {
  check: () => ipcRenderer.invoke('updates/check'),
  download: () => ipcRenderer.invoke('updates/download'),
  apply: () => ipcRenderer.invoke('updates/apply'),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('updates/status', handler);
    return () => ipcRenderer.removeListener('updates/status', handler);
  }
});

contextBridge.exposeInMainWorld('appInfo', {
  version: () => ipcRenderer.invoke('app/version')
});