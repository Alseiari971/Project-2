// Runs before GameShelf's own scripts in the desktop window. It marks the page
// as the desktop app (for the title bar styles) and gives the App settings page
// a narrow way to read and save the API keys, and the Play buttons a way to find
// and start installed games. Nothing else from the computer is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameshelfDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  openDataFolder: () => ipcRenderer.invoke('data-folder:open'),
  installedGames: () => ipcRenderer.invoke('installed:list'),
  findInstalled: (game) => ipcRenderer.invoke('installed:find', game),
  launch: (key) => ipcRenderer.invoke('installed:launch', key),
  stop: (key) => ipcRenderer.invoke('installed:stop', key),
  gameStates: () => ipcRenderer.invoke('installed:states'),
  // Calls back with { key: 'starting' | 'running' } whenever a game starts or stops.
  onGameStates: (callback) => {
    const listener = (_event, states) => callback(states);
    ipcRenderer.on('installed:states', listener);
    return () => ipcRenderer.removeListener('installed:states', listener);
  },
  pickGameFile: () => ipcRenderer.invoke('custom:pick'),
  addGame: (details) => ipcRenderer.invoke('custom:add', details),
  addedGames: () => ipcRenderer.invoke('custom:list'),
  removeAddedGame: (key) => ipcRenderer.invoke('custom:remove', key),
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app', `desktop-${process.platform}`);
});
