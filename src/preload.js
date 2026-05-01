const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('rp4', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectArea: () => ipcRenderer.invoke('area:select'),
  getWindowClientCrop: (sourceId) => ipcRenderer.invoke('window:client-crop', sourceId),
  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  startRecording: (meta) => ipcRenderer.invoke('recording:start', meta),
  writeRecordingChunk: (payload) => ipcRenderer.invoke('recording:write', payload),
  stopRecording: (payload) => ipcRenderer.invoke('recording:stop', payload),
  saveClip: (payload) => ipcRenderer.invoke('clip:save', payload),
  saveScreenshot: (payload) => ipcRenderer.invoke('screenshot:save', payload),
  openRecordingsFolder: () => ipcRenderer.invoke('folder:open-recordings'),
  showFile: (filePath) => ipcRenderer.invoke('file:show', filePath),
  appInfo: () => ipcRenderer.invoke('app:info'),
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  setHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
  onHotkey: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('hotkey:trigger', listener);
    return () => ipcRenderer.removeListener('hotkey:trigger', listener);
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close')
  }
});
