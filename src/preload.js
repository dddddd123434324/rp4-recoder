'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

/** Wraps an ipcRenderer listener and hands back an unsubscribe function. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('rp4', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  listSources: () => ipcRenderer.invoke('sources:list'),
  selectArea: () => ipcRenderer.invoke('area:select'),
  getWindowClientCrop: (sourceId) => ipcRenderer.invoke('window:client-crop', sourceId),

  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  startRecording: (meta) => ipcRenderer.invoke('recording:start', meta),
  writeRecordingChunk: (payload) => ipcRenderer.invoke('recording:write', payload),
  stopRecording: (payload) => ipcRenderer.invoke('recording:stop', payload),
  saveClip: (payload) => ipcRenderer.invoke('clip:save', payload),
  saveScreenshot: (payload) => ipcRenderer.invoke('screenshot:save', payload),
  cancelConversion: (jobId) => ipcRenderer.invoke('convert:cancel', jobId),

  openRecordingsFolder: () => ipcRenderer.invoke('folder:open-recordings'),
  chooseRecordingsFolder: () => ipcRenderer.invoke('folder:choose-recordings'),
  showFile: (filePath) => ipcRenderer.invoke('file:show', filePath),

  getAppSettings: () => ipcRenderer.invoke('settings:get'),
  setSelectedPreset: (key) => ipcRenderer.invoke('settings:selected-preset', key),
  saveProfile: (profile) => ipcRenderer.invoke('settings:profile', profile),
  setOptions: (options) => ipcRenderer.invoke('settings:options', options),
  saveCustomPreset: (preset) => ipcRenderer.invoke('settings:custom-preset:save', preset),
  deleteCustomPreset: (id) => ipcRenderer.invoke('settings:custom-preset:delete', id),

  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  setHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),

  reportSmoke: (report) => ipcRenderer.invoke('smoke:report', report),

  onHotkey: (callback) => subscribe('hotkey:trigger', callback),
  onNotice: (callback) => subscribe('app:notice', callback),
  onConvertProgress: (callback) => subscribe('recording:convert-progress', callback),
  onOptimizeState: (callback) => subscribe('recording:optimize', callback),
  onDiskFull: (callback) => subscribe('recording:disk-full', callback),
  // Fired when the app is closing so the renderer can flush and finalize a recording
  // before the window goes away.
  onFinalizeRecordings: (callback) => subscribe('app:finalize-recordings', callback),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close')
  }
});
