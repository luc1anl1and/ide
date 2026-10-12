const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cursorApi', { on: (cb) => ipcRenderer.on('cursor:go', (_e, m) => cb(m)) });
