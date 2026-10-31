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
  rescanGames: () => ipcRenderer.invoke('installed:rescan'),
  arabicBadges: () => ipcRenderer.invoke('installed:arabic'),
  onArabicBadge: (fn) => {
    const listener = (_event, update) => fn(update);
    ipcRenderer.on('installed:arabic', listener);
    return () => ipcRenderer.removeListener('installed:arabic', listener);
  },
  librarySyncSettings: () => ipcRenderer.invoke('library:sync-settings'),
  setLibrarySync: (auto) => ipcRenderer.invoke('library:set-sync', auto),
  syncLibrary: () => ipcRenderer.invoke('library:sync'),
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
  arabicOnline: (key) => ipcRenderer.invoke('arabic:online', key),
  getArabic: (key, options) => ipcRenderer.invoke('arabic:get', key, options),
  approveSubmission: (id) => ipcRenderer.invoke('admin:approve', id),
  requestArabic: (key) => ipcRenderer.invoke('arabic:request', key),
  onArabicProgress: (fn) => {
    const listener = (_event, progress) => fn(progress);
    ipcRenderer.on('arabic:progress', listener);
    return () => ipcRenderer.removeListener('arabic:progress', listener);
  },
  arabicPacks: () => ipcRenderer.invoke('arabic:packs'),
  studio: {
    settings: () => ipcRenderer.invoke('studio:settings'),
    saveSettings: (input) => ipcRenderer.invoke('studio:save-settings', input),
    pick: (kind) => ipcRenderer.invoke('studio:pick', kind),
    makeKeys: (folder) => ipcRenderer.invoke('studio:make-keys', folder),
    build: (options) => ipcRenderer.invoke('studio:build', options),
    cancel: () => ipcRenderer.invoke('studio:cancel'),
    publish: (packDir) => ipcRenderer.invoke('studio:publish', packDir),
    addLocal: (packDir) => ipcRenderer.invoke('studio:add-local', packDir),
    open: (target) => ipcRenderer.invoke('studio:open', target),
    onLog: (fn) => {
      const listener = (_event, entry) => fn(entry);
      ipcRenderer.on('studio:log', listener);
      return () => ipcRenderer.removeListener('studio:log', listener);
    },
    onProgress: (fn) => {
      const listener = (_event, progress) => fn(progress);
      ipcRenderer.on('studio:progress', listener);
      return () => ipcRenderer.removeListener('studio:progress', listener);
    },
  },
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
