// The overlay window only ever receives subtitles to show or hide.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gsOverlay', {
  onShow: (callback) => ipcRenderer.on('gs-overlay:show', (_event, subtitle) => callback(subtitle)),
  onHide: (callback) => ipcRenderer.on('gs-overlay:hide', () => callback()),
});
