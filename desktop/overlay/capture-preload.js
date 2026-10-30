// The hidden capture window's only link to the app: it's told what to watch,
// and reports subtitles to read and areas that cleared.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gsCapture', {
  onStart: (callback) => ipcRenderer.on('gs-capture:start', (_event, config) => callback(config)),
  onStop: (callback) => ipcRenderer.on('gs-capture:stop', () => callback()),
  onWindow: (callback) => ipcRenderer.on('gs-capture:window', (_event, windowRect) => callback(windowRect)),
  read: (image) => ipcRenderer.send('gs-capture:read', image),
  clear: () => ipcRenderer.send('gs-capture:clear'),
  status: (status) => ipcRenderer.send('gs-capture:status', status),
});
