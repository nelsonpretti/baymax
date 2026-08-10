'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('face', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (next) => ipcRenderer.invoke('set-settings', next),
  resetColours: () => ipcRenderer.invoke('reset-colours'),
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, d) => fn(d)),
  onSpeech: (fn) => ipcRenderer.on('speech', (_e, d) => fn(d)),
  onActivity: (fn) => ipcRenderer.on('activity', (_e, d) => fn(d)),
  onBattery: (fn) => ipcRenderer.on('battery', (_e, d) => fn(d)),
  onListen: (fn) => ipcRenderer.on('listen', (_e, d) => fn(d)),
  onHotkey: (fn) => ipcRenderer.on('hotkey', (_e, d) => fn(d)),
  onLimit: (fn) => ipcRenderer.on('limit', (_e, d) => fn(d)),
  onFaceSize: (fn) => ipcRenderer.on('face-size', (_e, d) => fn(d)),
  captureHotkey: () => ipcRenderer.invoke('capture-hotkey'),
  panel: (open, needed) => ipcRenderer.send('panel', open, needed),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  quit: () => ipcRenderer.send('quit'),
  debug: process.env.FACE_DEBUG === '1',
});
