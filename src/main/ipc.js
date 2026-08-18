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
const { fileURLToPath } = require('node:url');

const displays = require('./displays');
const ffmpeg = require('./ffmpeg');
const paths = require('./paths');
const settingsModule = require('./settings');
const windows = require('./windows');
const { parseWindowHandle } = require('./window-crop');

const MEDIA_FILE_PATTERN = /\.(mp4|webm|mkv)$/i;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 7680 * 4320;
const MAX_WEBP_RENDERER_PIXELS = 4096 * 2160;

function clampCropRect(rect, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.round(Number(rect.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.round(Number(rect.y) || 0)));
  const cropWidth = Math.max(1, Math.min(width - x, Math.round(Number(rect.width) || width)));
  const cropHeight = Math.max(1, Math.min(height - y, Math.round(Number(rect.height) || height)));
  return { x, y, width: cropWidth, height: cropHeight };
}

function isTrustedFileSender(event, fileName) {
  if (!event?.sender || event.sender.isDestroyed()) return false;
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const senderPath = path.resolve(fileURLToPath(event.senderFrame.url || event.sender.getURL()));
    return senderPath.toLowerCase() === path.join(windows.SRC_DIR, fileName).toLowerCase();
  } catch {
    return false;
  }
}

function isTopLevelWindowSender(event) {
  return isTrustedFileSender(event, 'index.html');
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
  const { settings, recordings, windowCrop, hotkeys, isSmoke, setCaptureState } = context;
  let folderDialogActive = false;
  const handleMain = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!isTopLevelWindowSender(event)) throw new Error('허용되지 않은 IPC 송신자입니다.');
    return handler(event, ...args);
  });
  const handleArea = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedFileSender(event, 'area-selector.html')) {
      throw new Error('허용되지 않은 영역 선택 IPC 송신자입니다.');
    }
    return handler(event, ...args);
  });

  function settingsDto() {
    const value = settings.value;
    return {
      language: value.language,
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

  async function captureScreenshotImage(sourceId, snapshot = {}) {
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
      const display = source && screen.getAllDisplays().find((item) => (
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
      width = Math.round(clientCrop.frameWidth);
      height = Math.round(clientCrop.frameHeight);
    }

    if (width < 1 || height < 1 || width * height > MAX_SCREENSHOT_PIXELS) {
      throw new Error('스크린샷 원본 해상도가 안전한 처리 한도를 초과했습니다. 이미지를 축소하지 않고 저장을 중단합니다.');
    }
    const sources = await desktopCapturer.getSources({
      types: [type],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item.id === id);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('스크린샷 원본 프레임을 가져올 수 없습니다.');
    }

    let image = source.thumbnail;
    const size = image.getSize();
    if (size.width !== width || size.height !== height) {
      throw new Error(`원본 해상도 캡처에 실패했습니다. 요청 ${width}x${height}, 결과 ${size.width}x${size.height}`);
    }
    let crop = { x: 0, y: 0, width: size.width, height: size.height };
    if (snapshot.mode === 'area' && snapshot.hasAreaSelection !== false) {
      const area = snapshot.areaSelection || {};
      crop = clampCropRect({
        x: Number(area.x) * size.width,
        y: Number(area.y) * size.height,
        width: Number(area.width) * size.width,
        height: Number(area.height) * size.height
      }, size.width, size.height);
    } else if (type === 'window' && clientCrop && snapshot.applyCrop !== false) {
      const scaleX = size.width / Math.max(1, clientCrop.frameWidth);
      const scaleY = size.height / Math.max(1, clientCrop.frameHeight);
      crop = clampCropRect({
        x: clientCrop.x * scaleX,
        y: clientCrop.y * scaleY,
        width: clientCrop.width * scaleX,
        height: clientCrop.height * scaleY
      }, size.width, size.height);
    }
    if (crop.x || crop.y || crop.width !== size.width || crop.height !== size.height) {
      image = image.crop(crop);
    }
    const outputSize = image.getSize();
    return { image, width: outputSize.width, height: outputSize.height, clientCrop };
  }

  handleMain('app:info', async () => ({
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

  handleMain('capture:state', async (_event, value = {}) => {
    setCaptureState?.({
      recordingActive: value.recordingActive === true,
      clipActive: value.clipActive === true,
      clipSaving: value.clipSaving === true
    });
    return true;
  });

  handleMain('sources:list', async () => {
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

    const [sources, nativeWindows] = await Promise.all([
      desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
      }),
      windowCrop.listWindows()
    ]);

    const toDto = (source, extra = {}) => {
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
        appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
        ...extra
      };
    };

    const screens = sources.filter((source) => source.id.startsWith('screen:')).map(toDto);
    const capturedWindows = new Map(sources
      .filter((source) => source.id.startsWith('window:'))
      .map((source) => [parseWindowHandle(source.id), source]));
    const mergedWindows = [];
    const includedHandles = new Set();
    for (const nativeWindow of nativeWindows) {
      const hwnd = String(nativeWindow.hwnd);
      if (Number(nativeWindow.processId) === process.pid || includedHandles.has(hwnd)) continue;
      includedHandles.add(hwnd);
      const captured = capturedWindows.get(hwnd);
      if (captured) {
        mergedWindows.push(toDto(captured, { minimized: Boolean(nativeWindow.minimized) }));
      } else {
        mergedWindows.push({
          id: `window:${hwnd}:0`,
          name: nativeWindow.title.trim().slice(0, 500),
          type: 'window',
          hwnd,
          displayId: null,
          display: null,
          thumbnail: null,
          appIcon: null,
          minimized: Boolean(nativeWindow.minimized),
          requiresRestore: true
        });
      }
    }
    for (const [hwnd, source] of capturedWindows) {
      if (!includedHandles.has(hwnd)) mergedWindows.push(toDto(source));
    }
    return [...screens, ...mergedWindows];
  });

  handleMain('window:prepare-source', async (_event, sourceId) => {
    const hwnd = parseWindowHandle(sourceId);
    if (!hwnd || !(await windowCrop.restore(hwnd))) return null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 120));
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
      });
      const source = sources.find((item) => parseWindowHandle(item.id) === hwnd);
      if (!source) continue;
      return {
        id: source.id,
        name: source.name,
        type: 'window',
        hwnd,
        displayId: null,
        display: null,
        thumbnail: source.thumbnail && !source.thumbnail.isEmpty()
          ? source.thumbnail.toDataURL()
          : null,
        appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
        minimized: false,
        requiresRestore: false
      };
    }
    return null;
  });

  handleArea('area-selector:data', async () => ({
    ...displays.getDisplayPayload(),
    language: settings.value.language
  }));

  handleMain('area:select', async () => windows.selectDesktopArea({ isSmoke }));

  handleMain('window:client-crop', async (_event, sourceId) => {
    const hwnd = parseWindowHandle(sourceId);
    if (!hwnd) return null;
    return windowCrop.query(hwnd);
  });

  handleMain('screenshot:capture-source', async (_event, payload = {}) => {
    const captured = await captureScreenshotImage(payload.sourceId, payload);
    if (captured.width * captured.height > MAX_WEBP_RENDERER_PIXELS) {
      throw new Error('WebP 스크린샷의 원본 영역이 안전한 처리 한도를 초과했습니다. 화질을 낮추지 않고 저장을 중단합니다.');
    }
    const buffer = captured.image.toPNG();
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      throw new Error('원본 스크린샷이 안전한 전송 한도(256MB)를 초과했습니다.');
    }
    return {
      buffer,
      width: captured.width,
      height: captured.height,
      clientCrop: null
    };
  });

  handleMain('screenshot:capture-save', async (_event, payload = {}) => {
    if (folderDialogActive) {
      throw new Error('저장 폴더를 선택하는 동안에는 스크린샷을 저장할 수 없습니다.');
    }
    const format = payload.format === 'jpeg' ? 'jpeg' : 'png';
    const captured = await captureScreenshotImage(payload.sourceId, payload);
    const quality = Math.max(10, Math.min(100, Math.round(Number(payload.quality) || 100)));
    // PNG is lossless and never resized. JPEG is encoded once at the explicitly selected quality.
    const buffer = format === 'jpeg'
      ? captured.image.toJPEG(quality)
      : captured.image.toPNG();
    if (!buffer.length || buffer.length > MAX_SCREENSHOT_BYTES) {
      throw new Error('스크린샷 인코딩 결과가 안전한 저장 한도를 초과했습니다.');
    }
    const saved = await recordings.saveScreenshot({ buffer });
    return { ...saved, width: captured.width, height: captured.height };
  });

  handleMain('recordings:list', async () => recordings.list());

  handleMain('recording:thumbnail', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return null;
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return null;
    return recordings.thumbnail(target).catch(() => null);
  });

  handleMain('recording:start', async (event, meta = {}) => {
    if (folderDialogActive) {
      throw new Error('저장 폴더를 선택하는 동안에는 녹화를 시작할 수 없습니다.');
    }
    return recordings.start(meta, { webContentsId: event.sender.id });
  });

  handleMain('recording:write', async (event, payload = {}) => recordings.write(payload, {
    webContentsId: event.sender.id
  }));

  handleMain('recording:stop', async (event, payload = {}) => recordings.stop(payload, {
    webContentsId: event.sender.id
  }));

  handleMain('screenshot:save', async (_event, payload = {}) => {
    if (folderDialogActive) {
      throw new Error('저장 폴더를 선택하는 동안에는 스크린샷을 저장할 수 없습니다.');
    }
    return recordings.saveScreenshot(payload);
  });

  handleMain('convert:cancel', async (_event, jobId) => ffmpeg.cancel(String(jobId || '')));

  handleMain('folder:open-recordings', async () => {
    await paths.ensureRecordingDirs(settings.recordingsDir);
    await shell.openPath(settings.recordingsDir);
    return settings.recordingsDir;
  });

  handleMain('folder:choose-recordings', async (event) => {
    if (folderDialogActive || recordings.hasPendingFileMutations()) {
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

      const chosen = path.resolve(result.filePaths[0]);
      if (!paths.isPlausibleRecordingsDir(chosen)) {
        return {
          canceled: false,
          failed: true,
          error: '이 위치는 저장 폴더로 사용할 수 없습니다.',
          recordingsDir: settings.recordingsDir
        };
      }
      // Prepare and validate the complete app-owned structure before persisting the path.
      // A conflicting temp/screenshots entry must never poison the next startup.
      try {
        await paths.ensureRecordingDirs(chosen);
      } catch (error) {
        return {
          canceled: false,
          failed: true,
          error: error?.message || '선택한 폴더를 사용할 수 없습니다.',
          recordingsDir: settings.recordingsDir
        };
      }
      if (recordings.hasPendingFileMutations()) {
        return {
          canceled: false,
          failed: true,
          error: '녹화가 시작되어 저장 경로 변경을 취소했습니다.',
          recordingsDir: settings.recordingsDir
        };
      }

      await settings.update({ recordingsDir: chosen });
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

  handleMain('file:show', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return false;
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  handleMain('file:play', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return { ok: false, error: '요청을 처리할 수 없습니다.' };
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return { ok: false, error: '이 녹화 파일을 열 수 없습니다.' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  handleMain('file:delete', async (event, filePath) => {
    if (!isTopLevelWindowSender(event)) return { deleted: false };
    const target = await resolveRecordingMediaFile(settings.recordingsDir, filePath);
    if (!target) return { deleted: false };
    return {
      deleted: await recordings.trashRecording(target, {
        trash: (ownedFile) => shell.trashItem(ownedFile)
      })
    };
  });

  handleMain('settings:get', async () => settingsDto());

  handleMain('settings:selected-preset', async (_event, key) => {
    await settings.update({ selectedPreset: key });
    return settingsDto();
  });

  // Persists the live recording profile so ad-hoc tweaks survive a restart instead of
  // silently reverting to the selected preset.
  handleMain('settings:profile', async (_event, profile = {}) => {
    await settings.update({ profile });
    return settingsDto();
  });

  handleMain('settings:profile-state', async (_event, payload = {}) => {
    await settings.update({
      selectedPreset: payload.selectedPreset == null ? null : payload.selectedPreset,
      profile: payload.profile
    });
    return settingsDto();
  });

  handleMain('settings:options', async (_event, options = {}) => {
    const patch = {};
    if (options.language === 'ko' || options.language === 'en') patch.language = options.language;
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

  handleMain('settings:custom-preset:save', async (_event, payload = {}) => {
    const id = typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : crypto.randomUUID();

    const nextPreset = {
      id,
      name: settingsModule.sanitizePresetName(payload.name),
      profile: settingsModule.normalizeProfile(payload.profile)
    };

    let dropped = 0;
    await settings.update((current) => {
      const existing = [...current.customPresets];
      const index = existing.findIndex((preset) => preset.id === id);
      if (index >= 0) existing[index] = nextPreset;
      else existing.unshift(nextPreset);
      dropped = Math.max(0, existing.length - settingsModule.MAX_CUSTOM_PRESETS);
      return {
        selectedPreset: `custom:${id}`,
        customPresets: existing.slice(0, settingsModule.MAX_CUSTOM_PRESETS),
        profile: nextPreset.profile
      };
    });

    return { ...settingsDto(), dropped };
  });

  handleMain('settings:custom-preset:delete', async (_event, id) => {
    const targetId = String(id || '');
    await settings.update((current) => {
      const wasSelected = current.selectedPreset === `custom:${targetId}`;
      return {
        selectedPreset: wasSelected ? settingsModule.DEFAULT_SELECTED_PRESET : current.selectedPreset,
        customPresets: current.customPresets.filter((preset) => preset.id !== targetId),
        ...(wasSelected ? { profile: settingsModule.DEFAULT_PROFILE } : {})
      };
    });
    return settingsDto();
  });

  handleMain('hotkeys:get', async () => hotkeys.dto(settings.value.hotkeys));

  handleMain('hotkeys:set', async (_event, next = {}) => {
    await settings.update({ hotkeys: next });
    hotkeys.register(settings.value.hotkeys);
    return hotkeys.dto(settings.value.hotkeys);
  });

  handleMain('hotkeys:reset', async () => {
    await settings.update({ hotkeys: settingsModule.DEFAULT_HOTKEYS });
    hotkeys.register(settings.value.hotkeys);
    return hotkeys.dto(settings.value.hotkeys);
  });

  handleMain('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  handleMain('window:maximize-toggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });

  handleMain('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

module.exports = {
  registerIpcHandlers,
  resolveRecordingMediaFile,
  isTopLevelWindowSender,
  isTrustedFileSender
};
