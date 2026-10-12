// Preload for the pet window: a tiny, explicit API (no Node access in the page).
const { contextBridge, ipcRenderer } = require('electron');
const IN = new Set(['pet:cfg', 'pet:state', 'pet:event', 'pet:pc', 'pet:open']);
contextBridge.exposeInMainWorld('petApi', {
  ready: () => ipcRenderer.invoke('pet:ready'),
  on: (ch, cb) => { if (!IN.has(ch)) return () => { }; const f = (_e, p) => cb(p); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); },
  sheet: (id) => ipcRenderer.invoke('pet:sheet', id),
  bounds: () => ipcRenderer.invoke('pet:bounds'),
  move: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  savePos: () => ipcRenderer.send('pet:savePos'),
  interactive: (on) => ipcRenderer.send('pet:interactive', !!on),
  resize: (width, height) => ipcRenderer.invoke('pet:resize', { width, height }),
  focusInput: () => ipcRenderer.invoke('pet:focusInput'),
  cmd: (o) => ipcRenderer.invoke('pet:cmd', o),
  revoke: () => ipcRenderer.invoke('pet:revoke'),
  hide: () => ipcRenderer.invoke('pet:hide'),
  openIde: () => ipcRenderer.invoke('pet:openIde'),
  quit: () => ipcRenderer.invoke('pet:quit'),
});
