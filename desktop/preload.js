// Runs before GameShelf's own scripts in the desktop window. It marks the page
// as the desktop app (for the title bar styles) and gives the App settings page
// a narrow way to read and save the API keys, the Play buttons a way to find
// and start installed games (and switch Arabic subtitles on), and the window
// buttons a way to minimize, maximize and close the window. Nothing else from
// the computer is exposed.
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
  gameOptions: (key) => ipcRenderer.invoke('installed:options', key),
  gameAction: (key, action, value) => ipcRenderer.invoke('installed:action', key, action, value),
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
  // The "Arabic subtitles" switch next to Play, and the Arabic packs.
  arabicInfo: (key) => ipcRenderer.invoke('arabic:info', key),
  setArabic: (key, on) => ipcRenderer.invoke('arabic:set', key, on),
  arabicPacks: () => ipcRenderer.invoke('arabic:packs'),
  addArabicPack: () => ipcRenderer.invoke('arabic:add-pack'),
  removeArabicPack: (id) => ipcRenderer.invoke('arabic:remove-pack', id),
  arabicOverlayStyle: () => ipcRenderer.invoke('arabic:overlay-style'),
  setArabicOverlayStyle: (style) => ipcRenderer.invoke('arabic:set-overlay-style', style),
  // The minimize, maximize and close buttons the page draws on Windows and Linux.
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app', `desktop-${process.platform}`);
});
