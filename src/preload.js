'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

const MAX_IPC_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;

function invokeWithBoundedBuffer(channel, payload = {}, maxBytes = MAX_IPC_BINARY_BYTES) {
  const bytes = Number(payload.buffer?.byteLength ?? payload.buffer?.length ?? 0);
  if (bytes > maxBytes) {
    return Promise.reject(new Error('한 번에 전송할 수 있는 데이터 크기를 초과했습니다.'));
  }
  return ipcRenderer.invoke(channel, payload);
}

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
  captureScreenshotSource: (payload) => ipcRenderer.invoke('screenshot:capture-source', payload),
  captureAndSaveScreenshot: (payload) => ipcRenderer.invoke('screenshot:capture-save', payload),

  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  getRecordingThumbnail: (filePath) => ipcRenderer.invoke('recording:thumbnail', filePath),
  startRecording: (meta) => ipcRenderer.invoke('recording:start', meta),
  writeRecordingChunk: (payload) => invokeWithBoundedBuffer('recording:write', payload),
  stopRecording: (payload) => ipcRenderer.invoke('recording:stop', payload),
  saveScreenshot: (payload) => invokeWithBoundedBuffer('screenshot:save', payload, MAX_SCREENSHOT_BYTES),
  cancelConversion: (jobId) => ipcRenderer.invoke('convert:cancel', jobId),

  openRecordingsFolder: () => ipcRenderer.invoke('folder:open-recordings'),
  chooseRecordingsFolder: () => ipcRenderer.invoke('folder:choose-recordings'),
  showFile: (filePath) => ipcRenderer.invoke('file:show', filePath),
  playRecording: (filePath) => ipcRenderer.invoke('file:play', filePath),
  deleteRecording: (filePath) => ipcRenderer.invoke('file:delete', filePath),

  getAppSettings: () => ipcRenderer.invoke('settings:get'),
  setSelectedPreset: (key) => ipcRenderer.invoke('settings:selected-preset', key),
  saveProfile: (profile) => ipcRenderer.invoke('settings:profile', profile),
  saveProfileState: (payload) => ipcRenderer.invoke('settings:profile-state', payload),
  setOptions: (options) => ipcRenderer.invoke('settings:options', options),
  saveCustomPreset: (preset) => ipcRenderer.invoke('settings:custom-preset:save', preset),
  deleteCustomPreset: (id) => ipcRenderer.invoke('settings:custom-preset:delete', id),

  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  setHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),

  reportSmoke: (report) => ipcRenderer.invoke('smoke:report', report),
  reportCaptureState: (captureState) => ipcRenderer.invoke('capture:state', captureState),

  onHotkey: (callback) => subscribe('hotkey:trigger', callback),
  onNotice: (callback) => subscribe('app:notice', callback),
  onConvertProgress: (callback) => subscribe('recording:convert-progress', callback),
  onOptimizeState: (callback) => subscribe('recording:optimize', callback),
  onVerifyState: (callback) => subscribe('recording:verify', callback),
  onDiskFull: (callback) => subscribe('recording:disk-full', callback),
  // Fired when the app is closing so the renderer can flush and finalize a recording
  // before the window goes away.
  onFinalizeRecordings: (callback) => subscribe('app:finalize-recordings', callback),
  reportFinalizeAccepted: (requestId) => ipcRenderer.send('app:shutdown-accepted', { requestId }),
  reportFinalizeProgress: (requestId, progress = {}) => (
    ipcRenderer.send('app:shutdown-progress', { requestId, progress })
  ),
  reportFinalizeFailed: (requestId, error) => (
    ipcRenderer.send('app:shutdown-failed', { requestId, error: String(error || '').slice(0, 500) })
  ),
  reportFinalizeComplete: (requestId, result = {}) => (
    ipcRenderer.send('app:shutdown-ready', { requestId, ok: result.ok !== false })
  ),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close')
  }
});
