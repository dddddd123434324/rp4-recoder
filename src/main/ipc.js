'use strict';

const { BrowserWindow, app, desktopCapturer, dialog, ipcMain, screen, shell } = require('electron/main');
const crypto = require('node:crypto');

const displays = require('./displays');
const ffmpeg = require('./ffmpeg');
const paths = require('./paths');
const settingsModule = require('./settings');
const windows = require('./windows');
const { parseWindowHandle } = require('./window-crop');

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

  ipcMain.handle('recordings:list', async () => recordings.list());

  ipcMain.handle('recording:start', async (event, meta = {}) => recordings.start(meta, {
    webContentsId: event.sender.id
  }));

  ipcMain.handle('recording:write', async (event, payload = {}) => recordings.write(payload, {
    webContentsId: event.sender.id
  }));

  ipcMain.handle('recording:stop', async (event, payload = {}) => recordings.stop(payload, {
    webContentsId: event.sender.id
  }));

  ipcMain.handle('clip:save', async (_event, payload = {}) => recordings.saveClip(payload));

  ipcMain.handle('screenshot:save', async (_event, payload = {}) => recordings.saveScreenshot(payload));

  ipcMain.handle('convert:cancel', async (_event, jobId) => ffmpeg.cancel(String(jobId || '')));

  ipcMain.handle('folder:open-recordings', async () => {
    await paths.ensureRecordingDirs(settings.recordingsDir);
    await shell.openPath(settings.recordingsDir);
    return settings.recordingsDir;
  });

  ipcMain.handle('folder:choose-recordings', async (event) => {
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

    await settings.update({ recordingsDir: chosen });
    await paths.ensureRecordingDirs(settings.recordingsDir);
    return { canceled: false, failed: false, recordingsDir: settings.recordingsDir };
  });

  ipcMain.handle('file:show', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return false;
    // Only reveal files this app owns, rather than accepting any path from the renderer.
    if (!paths.isInside(settings.recordingsDir, filePath)) return false;
    if (!(await paths.pathExists(filePath))) return false;
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('file:play', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: '파일 경로가 없습니다.' };
    if (!paths.isInside(settings.recordingsDir, filePath)) {
      return { ok: false, error: '이 파일을 열 수 없습니다.' };
    }
    if (!(await paths.pathExists(filePath))) return { ok: false, error: '파일을 찾을 수 없습니다.' };
    const error = await shell.openPath(filePath);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('file:delete', async (_event, filePath) => ({
    deleted: await recordings.trashRecording(filePath, {
      trash: (target) => shell.trashItem(target)
    })
  }));

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

  ipcMain.handle('settings:options', async (_event, options = {}) => {
    const patch = {};
    if (typeof options.optimizeMp4 === 'boolean') patch.optimizeMp4 = options.optimizeMp4;
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
      customPresets: existing.slice(0, settingsModule.MAX_CUSTOM_PRESETS)
    });

    return { ...settingsDto(), dropped };
  });

  ipcMain.handle('settings:custom-preset:delete', async (_event, id) => {
    const targetId = String(id || '');
    const value = settings.value;
    const selectedPreset = value.selectedPreset === `custom:${targetId}`
      ? settingsModule.DEFAULT_SELECTED_PRESET
      : value.selectedPreset;

    await settings.update({
      selectedPreset,
      customPresets: value.customPresets.filter((preset) => preset.id !== targetId)
    });
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

module.exports = { registerIpcHandlers };
