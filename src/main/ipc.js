'use strict';

const {
  BrowserWindow,
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  shell
} = require('electron/main');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const displays = require('./displays');
const ffmpeg = require('./ffmpeg');
const paths = require('./paths');
const settingsModule = require('./settings');
const windows = require('./windows');
const { parseWindowHandle } = require('./window-crop');

const MEDIA_FILE_PATTERN = /\.(mp4|webm|mkv)$/i;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;

function isTopLevelWindowSender(event) {
  if (!event?.sender || event.sender.isDestroyed()) return false;
  const owner = BrowserWindow.fromWebContents(event.sender);
  return Boolean(owner && event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

async function resolveRecordingMediaFile(recordingsDir, filePath) {
  if (typeof filePath !== 'string' || !filePath || !MEDIA_FILE_PATTERN.test(filePath)) return null;

  const root = path.resolve(recordingsDir);
  const target = path.resolve(filePath);
  if (path.dirname(target).toLowerCase() !== root.toLowerCase()) return null;

  try {
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (path.dirname(realTarget).toLowerCase() !== realRoot.toLowerCase()) return null;
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * Wires every IPC handler.
 *
 * @param {object} context
 * @param {import('./settings').SettingsStore} context.settings
 * @param {import('./recording').RecordingManager} context.recordings
 * @param {import('./window-crop').WindowCropService} context.windowCrop
 * @param {import('./hotkeys').HotkeyManager} context.hotkeys
 * @param {boolean} context.isSmoke
 */
function registerIpcHandlers(context) {
  const { settings, recordings, windowCrop, hotkeys, isSmoke } = context;
  let folderDialogActive = false;

  function settingsDto() {
    const value = settings.value;
    return {
      selectedPreset: value.selectedPreset,
      customPresets: value.customPresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        profile: { ...preset.profile }
      })),
      // null until the user has actually changed something, so the renderer knows to fall
      // back to the selected preset.
      profile: value.profile ? { ...value.profile } : null,
      recordingsDir: value.recordingsDir,
      defaultRecordingsDir: paths.defaultRecordingsDir(),
      settingsFile: paths.settingsFile(),
      optimizeMp4: value.optimizeMp4,
      screenshotFormat: value.screenshotFormat,
      screenshotQuality: value.screenshotQuality,
      clipBufferLimitMb: value.clipBufferLimitMb,
      maxCustomPresets: settingsModule.MAX_CUSTOM_PRESETS
    };
  }

  ipcMain.handle('app:info', async () => ({
    appRoot: windows.APP_ROOT,
    configDir: paths.configDir(),
    settingsFile: paths.settingsFile(),
    recordingsDir: settings.recordingsDir,
    screenshotsDir: settings.screenshotsDir,
    version: app.getVersion(),
    minSelectionPx: displays.MIN_SELECTION_PX,
    ffmpegAvailable: Boolean(ffmpeg.resolveExecutable()),
    isSmoke
  }));

  ipcMain.handle('sources:list', async () => {
    const allDisplays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    const displayMap = new Map(allDisplays.map((display, index) => [
      String(display.id),
      {
        index: index + 1,
        id: display.id,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        primary: display.id === primaryId
      }
    ]));

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });

    return sources.map((source) => {
      const displayId = source.display_id ? String(source.display_id) : null;
      return {
        id: source.id,
        name: source.name,
        type: source.id.startsWith('screen:') ? 'screen' : 'window',
        hwnd: parseWindowHandle(source.id),
        displayId,
        display: displayId ? displayMap.get(displayId) || null : null,
        thumbnail: source.thumbnail && !source.thumbnail.isEmpty()
          ? source.thumbnail.toDataURL()
          : null,
        appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
      };
    });
  });

  ipcMain.handle('area-selector:data', async () => displays.getDisplayPayload());

  ipcMain.handle('area:select', async () => windows.selectDesktopArea({ isSmoke }));

  ipcMain.handle('window:client-crop', async (_event, sourceId) => {
    const hwnd = parseWindowHandle(sourceId);
    if (!hwnd) return null;
    return windowCrop.query(hwnd);
  });

  ipcMain.handle('screenshot:capture-source', async (_event, sourceId) => {
    const id = String(sourceId || '');
    const type = id.startsWith('screen:') ? 'screen' : id.startsWith('window:') ? 'window' : null;
    if (!type) throw new Error('스크린샷 소스가 올바르지 않습니다.');

    let width;
    let height;
    let clientCrop = null;

    if (type === 'screen') {
      const available = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      });
      const source = available.find((item) => item.id === id);
      if (!source) throw new Error('스크린샷 화면을 찾을 수 없습니다.');
      const display = screen.getAllDisplays().find((item) => (
        String(item.id) === String(source.display_id)
      ));
      if (!display) throw new Error('스크린샷 화면 크기를 확인할 수 없습니다.');
      width = Math.round(display.bounds.width * display.scaleFactor);
      height = Math.round(display.bounds.height * display.scaleFactor);
    } else {
      const hwnd = parseWindowHandle(id);
      clientCrop = hwnd ? await windowCrop.query(hwnd) : null;
      if (!clientCrop) {
        throw new Error('최소화된 창은 원본 크기로 캡처할 수 없습니다. 창을 복원해 주세요.');
      }
      width = clientCrop.frameWidth;
      height = clientCrop.frameHeight;
    }

    width = Math.max(2, Math.min(7680, Math.round(Number(width) || 0)));
    height = Math.max(2, Math.min(4320, Math.round(Number(height) || 0)));
    const sources = await desktopCapturer.getSources({
      types: [type],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item.id === id);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('스크린샷 원본 프레임을 가져올 수 없습니다.');
    }
    const size = source.thumbnail.getSize();
    const buffer = source.thumbnail.toPNG();
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      throw new Error('원본 스크린샷이 안전한 전송 한도(256MB)를 초과했습니다.');
    }
    return {
      buffer,
      width: size.width,
      height: size.height,
      clientCrop
    };
  });

  ipcMain.handle('recordings:list', async () => recordings.list());

  ipcMain.handle('recording:thumbnail', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return null;
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return null;
    return recordings.thumbnail(target).catch(() => null);
  });

  ipcMain.handle('recording:start', async (event, meta = {}) => {
    if (folderDialogActive) {
      throw new Error('저장 폴더를 선택하는 동안에는 녹화를 시작할 수 없습니다.');
    }
    return recordings.start(meta, { webContentsId: event.sender.id });
  });

  ipcMain.handle('recording:write', async (event, payload = {}) => recordings.write(payload, {
    webContentsId: event.sender.id
  }));

  ipcMain.handle('recording:stop', async (event, payload = {}) => recordings.stop(payload, {
    webContentsId: event.sender.id
  }));

  ipcMain.handle('screenshot:save', async (_event, payload = {}) => recordings.saveScreenshot(payload));

  ipcMain.handle('convert:cancel', async (_event, jobId) => ffmpeg.cancel(String(jobId || '')));

  ipcMain.handle('folder:open-recordings', async () => {
    await paths.ensureRecordingDirs(settings.recordingsDir);
    await shell.openPath(settings.recordingsDir);
    return settings.recordingsDir;
  });

  ipcMain.handle('folder:choose-recordings', async (event) => {
    if (folderDialogActive || recordings.hasPendingRecordings()) {
      return {
        canceled: false,
        failed: true,
        error: '녹화 또는 저장 작업 중에는 저장 경로를 바꿀 수 없습니다.',
        recordingsDir: settings.recordingsDir
      };
    }

    folderDialogActive = true;
    try {
      // Electron 41 has no globalShortcut.setSuspended(). Temporarily unregister the
      // app-owned bindings while the native picker is open, then restore them below.
      hotkeys.unregisterAll();
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: '녹화 파일 저장 경로 선택',
        defaultPath: settings.recordingsDir,
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true, recordingsDir: settings.recordingsDir };
      }

      const chosen = result.filePaths[0];
      if (!paths.isPlausibleRecordingsDir(chosen)) {
        return {
          canceled: false,
          failed: true,
          error: '이 위치는 저장 폴더로 사용할 수 없습니다.',
          recordingsDir: settings.recordingsDir
        };
      }
      // Confirm we can actually write there before committing the setting.
      if (!(await paths.isDirectoryWritable(chosen))) {
        return {
          canceled: false,
          failed: true,
          error: '선택한 폴더에 쓸 수 없습니다. 다른 폴더를 선택해 주세요.',
          recordingsDir: settings.recordingsDir
        };
      }
      if (recordings.hasPendingRecordings()) {
        return {
          canceled: false,
          failed: true,
          error: '녹화가 시작되어 저장 경로 변경을 취소했습니다.',
          recordingsDir: settings.recordingsDir
        };
      }

      await settings.update({ recordingsDir: chosen });
      await paths.ensureRecordingDirs(settings.recordingsDir);
      return { canceled: false, failed: false, recordingsDir: settings.recordingsDir };
    } finally {
      try {
        hotkeys.register(settings.value.hotkeys);
      } catch {
        // App shutdown may have released the shortcut service while the dialog closed.
      }
      folderDialogActive = false;
    }
  });

  ipcMain.handle('file:show', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return false;
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('file:play', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return { ok: false, error: '요청을 처리할 수 없습니다.' };
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return { ok: false, error: '이 녹화 파일을 열 수 없습니다.' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('file:delete', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return { deleted: false };
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return { deleted: false };
    return {
      deleted: await recordings.trashRecording(target, {
        trash: (ownedFile) => shell.trashItem(ownedFile)
      })
    };
  });

  ipcMain.handle('settings:get', async () => settingsDto());

  ipcMain.handle('settings:selected-preset', async (_event, key) => {
    await settings.update({ selectedPreset: key });
    return settingsDto();
  });

  // Persists the live recording profile so ad-hoc tweaks survive a restart instead of
  // silently reverting to the selected preset.
  ipcMain.handle('settings:profile', async (_event, profile = {}) => {
    await settings.update({ profile });
    return settingsDto();
  });

  ipcMain.handle('settings:profile-state', async (_event, payload = {}) => {
    await settings.update({
      selectedPreset: payload.selectedPreset == null ? null : payload.selectedPreset,
      profile: payload.profile
    });
    return settingsDto();
  });

  ipcMain.handle('settings:options', async (_event, options = {}) => {
    const patch = {};
    if (typeof options.optimizeMp4 === 'boolean') patch.optimizeMp4 = options.optimizeMp4;
    if (typeof options.screenshotFormat === 'string') {
      patch.screenshotFormat = options.screenshotFormat;
    }
    if (Number.isFinite(Number(options.screenshotQuality))) {
      patch.screenshotQuality = Number(options.screenshotQuality);
    }
    if (Number.isFinite(Number(options.clipBufferLimitMb))) {
      patch.clipBufferLimitMb = Number(options.clipBufferLimitMb);
    }
    await settings.update(patch);
    return settingsDto();
  });

  ipcMain.handle('settings:custom-preset:save', async (_event, payload = {}) => {
    const id = typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : crypto.randomUUID();

    const nextPreset = {
      id,
      name: settingsModule.sanitizePresetName(payload.name),
      profile: settingsModule.normalizeProfile(payload.profile)
    };

    const existing = [...settings.value.customPresets];
    const index = existing.findIndex((preset) => preset.id === id);
    if (index >= 0) {
      existing[index] = nextPreset;
    } else {
      existing.unshift(nextPreset);
    }

    // Report the limit instead of silently dropping the oldest entry.
    const dropped = Math.max(0, existing.length - settingsModule.MAX_CUSTOM_PRESETS);
    await settings.update({
      selectedPreset: `custom:${id}`,
      customPresets: existing.slice(0, settingsModule.MAX_CUSTOM_PRESETS),
      profile: nextPreset.profile
    });

    return { ...settingsDto(), dropped };
  });

  ipcMain.handle('settings:custom-preset:delete', async (_event, id) => {
    const targetId = String(id || '');
    const value = settings.value;
    const selectedPreset = value.selectedPreset === `custom:${targetId}`
      ? settingsModule.DEFAULT_SELECTED_PRESET
      : value.selectedPreset;

    const patch = {
      selectedPreset,
      customPresets: value.customPresets.filter((preset) => preset.id !== targetId)
    };
    if (value.selectedPreset === `custom:${targetId}`) {
      patch.profile = settingsModule.DEFAULT_PROFILE;
    }
    await settings.update(patch);
    return settingsDto();
  });

  ipcMain.handle('hotkeys:get', async () => hotkeys.dto(settings.value.hotkeys));

  ipcMain.handle('hotkeys:set', async (_event, next = {}) => {
    await settings.update({ hotkeys: next });
    hotkeys.register(settings.value.hotkeys);
    return hotkeys.dto(settings.value.hotkeys);
  });

  ipcMain.handle('hotkeys:reset', async () => {
    await settings.update({ hotkeys: settingsModule.DEFAULT_HOTKEYS });
    hotkeys.register(settings.value.hotkeys);
    return hotkeys.dto(settings.value.hotkeys);
  });

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('window:maximize-toggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

module.exports = { registerIpcHandlers, resolveRecordingMediaFile, isTopLevelWindowSender };
