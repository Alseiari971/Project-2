// Runs before GameShelf's own scripts in the desktop window. It marks the page
// as the desktop app (for the title bar styles) and gives the App settings page
// a narrow way to read and save the API keys. Nothing else from the computer is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameshelfDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  openDataFolder: () => ipcRenderer.invoke('data-folder:open'),
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app', `desktop-${process.platform}`);
});
