'use strict';

const { app, BrowserWindow, dialog, ipcMain, session } = require('electron/main');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const ffmpeg = require('./main/ffmpeg');
const paths = require('./main/paths');
const windows = require('./main/windows');
const { HotkeyManager } = require('./main/hotkeys');
const { RecordingManager } = require('./main/recording');
const { SettingsStore } = require('./main/settings');
const { WindowCropService } = require('./main/window-crop');
const { registerIpcHandlers } = require('./main/ipc');

const IS_SMOKE = process.env.RP4_SMOKE === '1';
const SMOKE_TIMEOUT_MS = Math.max(5000, Number(process.env.RP4_SMOKE_TIMEOUT_MS) || 30000);

const settings = new SettingsStore();
const windowCrop = new WindowCropService();

let mainWindow = null;
let tray = null;
let recordings = null;
let hotkeys = null;
let isQuitting = false;
let smokeFinished = false;
let rendererCaptureState = { recordingActive: false, clipActive: false, clipSaving: false };
const failedRendererIds = new Set();
let rendererUnresponsivePromptOpen = false;
let fatalAsyncShutdownScheduled = false;

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  try {
    mainWindow.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** Only one instance may hold the global hotkeys and write to the recordings folder. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  bootstrap();
}

function finishSmoke(code, message) {
  if (smokeFinished) return;
  smokeFinished = true;
  if (!message) {
    app.exit(code);
    return;
  }
  process.stdout.write(`${message}\n`, () => app.exit(code));
}

function reportFatalAsyncFailure(error, source = 'asynchronous task') {
  process.stderr.write(`${source} failed: ${error?.stack || error}\n`);
  if (fatalAsyncShutdownScheduled || isQuitting) return;
  fatalAsyncShutdownScheduled = true;
  void (async () => {
    if (isQuitting) {
      app.exit(1);
      return;
    }
    await shutdown({
      rendererUnavailable: true,
      failureReason: '처리되지 않은 비동기 오류로 녹화를 안전하게 마무리합니다.',
      exitCode: 1
    });
  })().catch((shutdownError) => {
    process.stderr.write(`fatal asynchronous shutdown failed: ${shutdownError?.stack || shutdownError}\n`);
    app.exit(1);
  });
}

function requestShutdown(options = {}) {
  void shutdown(options).catch((error) => {
    process.stderr.write(`shutdown failed: ${error?.stack || error}\n`);
    app.exit(1);
  });
}

function rendererUnresponsiveGraceMs() {
  return rendererCaptureState.recordingActive
    || rendererCaptureState.clipActive
    || rendererCaptureState.clipSaving
    ? windows.UNRESPONSIVE_RECORDING_GRACE_MS
    : windows.UNRESPONSIVE_GRACE_MS;
}

/**
 * Cleanly shuts down: finalizes any in-flight recording, releases hotkeys, stops the
 * helper process and cancels background ffmpeg work.
 *
 * `before-quit` cannot be used for this on its own because Electron ignores the promise
 * returned by an async listener, so the process could exit before the files were closed.
 */
async function shutdown({
  clipShutdownMode = 'discard',
  rendererUnavailable = false,
  failureReason = null,
  exitCode = 0
} = {}) {
  if (isQuitting) return;
  isQuitting = true;

  const cleanup = async (label, task) => {
    try {
      await task();
    } catch (error) {
      process.stderr.write(`shutdown ${label} error: ${error?.message || error}\n`);
    }
  };

  await cleanup('hotkeys', () => hotkeys?.unregisterAll());
  await cleanup('area selector', () => windows.closeAreaSelector());
  let drainResult = null;
  if (recordings) {
    if (rendererUnavailable) {
      // A crashed renderer cannot participate in the IPC shutdown handshake, but it must
      // still use the same bounded finalization/recovery policy as a normal close.
      await cleanup('recordings', async () => {
        drainResult = await windows.drainRecordings(null, recordings, {
          timeoutMs: 20000,
          clipShutdownMode: 'discard',
          timeoutFailureReason: failureReason
        });
      });
    } else {
      try {
        drainResult = await windows.drainRecordings(mainWindow, recordings, {
          timeoutMs: 20000,
          clipShutdownMode,
          timeoutFailureReason: failureReason
        });
      } catch (error) {
        process.stderr.write(`shutdown recordings error: ${error?.message || error}\n`);
      }
      if (drainResult?.shutdownFailed && clipShutdownMode !== 'discard') {
        const decision = await windows.confirmClipSaveFailure(
          mainWindow,
          drainResult.error,
          settings.value.language
        );
        if (decision === 'return') {
          isQuitting = false;
          try {
            hotkeys?.register(settings.value.hotkeys);
          } catch {
            // The app remains usable even if a global shortcut cannot be restored.
          }
          return false;
        }
        await windows.drainRecordings(mainWindow, recordings, {
          timeoutMs: 20000,
          clipShutdownMode: 'discard',
          timeoutFailureReason: failureReason
        });
      }
    }
    await cleanup('session handles', () => recordings.closeAllSessions());
    await cleanup('verifications', () => recordings.cancelAndDrainVerifications());
    await cleanup('optimizations', () => recordings.cancelAndDrainOptimizations());
  }
  // Also covers an FFmpeg job that was started outside RecordingManager.
  await cleanup('ffmpeg', () => ffmpeg.cancelAll({ timeoutMs: 5000 }));
  await cleanup('window crop', () => windowCrop.dispose());

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.rp4AllowClose = true;
    mainWindow.destroy();
  }
  tray?.destroy();
  tray = null;

  app.exit(exitCode);
  return true;
}

/**
 * Runs when the user tries to close the window. Confirms first when a recording is in
 * progress so a take is never discarded by accident.
 */
async function handleQuitRequest(win) {
  if (isQuitting) return;

  let clipShutdownMode = 'discard';
  if (rendererCaptureState.clipActive || rendererCaptureState.clipSaving) {
    const decision = await windows.confirmCloseWhileClip(win, {
      saving: rendererCaptureState.clipSaving,
      language: settings.value.language
    });
    if (decision === 'cancel') return;
    clipShutdownMode = decision;
  } else if (recordings?.hasPendingRecordings()) {
    const shouldSave = await windows.confirmCloseWhileRecording(win, settings.value.language);
    if (!shouldSave) return;
  }

  await shutdown({ clipShutdownMode });
}

async function handleRendererGone(win, detail) {
  const rendererId = win?.webContents?.id;
  if (isQuitting || (rendererId != null && failedRendererIds.has(rendererId))) return;
  if (rendererId != null) failedRendererIds.add(rendererId);
  await shutdown({
    rendererUnavailable: true,
    failureReason: `렌더러 프로세스 종료: ${detail?.reason || '알 수 없는 오류'}`,
    exitCode: 1
  });
}

async function handleRendererUnresponsive(win) {
  if (isQuitting || rendererUnresponsivePromptOpen) return;
  rendererUnresponsivePromptOpen = true;
  try {
    const decision = await windows.confirmRendererUnresponsive(win, {
      language: settings.value.language,
      recordingActive: rendererCaptureState.recordingActive
        || rendererCaptureState.clipActive
        || rendererCaptureState.clipSaving
    });
    if (decision !== 'exit' || isQuitting) return;
    await shutdown({
      clipShutdownMode: rendererCaptureState.clipSaving
        ? 'wait-current-save'
        : rendererCaptureState.clipActive ? 'save-current-buffer' : 'discard',
      failureReason: '렌더러 응답 없음 상태에서 사용자가 안전 종료를 선택했습니다.',
      exitCode: 1
    });
  } finally {
    rendererUnresponsivePromptOpen = false;
  }
}

async function bootstrap() {
  try {
    await app.whenReady();
  } catch (error) {
    dialog.showErrorBox('RP4 Recorder', `앱을 초기화할 수 없습니다.\n\n${error?.message || error}`);
    app.exit(1);
    return;
  }

  try {
    const loaded = await settings.load();
    if (IS_SMOKE) {
      await settings.update({
        recordingsDir: path.join(app.getPath('userData'), 'smoke-recordings')
      });
    }
    await paths.ensureRecordingDirs(settings.recordingsDir);

    recordings = new RecordingManager({ settings, emit: send });
    const indexRecovery = await recordings.loadIndex();

    hotkeys = new HotkeyManager({
      onTrigger: (action) => send('hotkey:trigger', action)
    });

    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) return false;
      const owner = BrowserWindow.fromWebContents(webContents);
      if (!owner) return false;
      try {
        return paths.isInside(windows.SRC_DIR, fileURLToPath(webContents.getURL()));
      } catch {
        return false;
      }
    };
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isTrustedAppContents(webContents) && ['media', 'display-capture'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
      isTrustedAppContents(webContents) && ['media', 'display-capture'].includes(permission)
    ));
    registerIpcHandlers({
      settings,
      recordings,
      windowCrop,
      hotkeys,
      isSmoke: IS_SMOKE,
      setCaptureState: (value) => { rendererCaptureState = value; }
    });

    ipcMain.handle('smoke:report', async (_event, report = {}) => {
      if (!IS_SMOKE) return false;
      if (report.ok) {
        finishSmoke(0, `SMOKE OK ${JSON.stringify(report)}`);
      } else {
        finishSmoke(1, `SMOKE FAIL ${JSON.stringify(report)}`);
      }
      return true;
    });

    mainWindow = windows.createMainWindow({
      isSmoke: IS_SMOKE,
      onRendererGone: (win, details) => handleRendererGone(win, details)
        .catch((error) => reportFatalAsyncFailure(error, 'renderer-gone recovery')),
      onRendererUnresponsive: (win) => handleRendererUnresponsive(win)
        .catch((error) => reportFatalAsyncFailure(error, 'renderer-unresponsive recovery')),
      getRendererUnresponsiveGraceMs: rendererUnresponsiveGraceMs
    });
    if (!IS_SMOKE) {
      tray = windows.createTray({
        getMainWindow: () => mainWindow,
        getLanguage: () => settings.value.language,
        onQuitRequested: handleQuitRequest
      });
    }
    const rendererLoaded = mainWindow.rp4Loaded;

    hotkeys.register(settings.value.hotkeys);

    await rendererLoaded;
    // The window becomes interactive before media probing/recovery. These jobs can
    // decode large files and must never hold the first paint hostage.
    const sweep = await recordings.sweepTempDir();
    const reconciliation = await recordings.reconcileRecordingsDir();
    void recordings.resumePendingMediaJobs().catch((error) => {
      process.stderr.write(`resume media jobs failed: ${error?.stack || error}\n`);
      send('app:notice', {
        level: 'warn',
        messageKey: 'mediaJobsResumeFailed',
        params: { error: error?.message || String(error) }
      });
    });
    if (sweep.recovered.length > 0 || reconciliation.restored > 0) {
      send('recordings:changed', { reason: 'startup-recovery' });
    }
    {
      if (loaded.settingsRecovered) {
        send('app:notice', {
          level: 'warn',
          messageKey: loaded.settingsBackupPath
            ? 'settingsRecoveredWithBackup'
            : 'settingsRecoveredWithoutBackup',
          params: loaded.settingsBackupPath ? { backupPath: loaded.settingsBackupPath } : {}
        });
      }
      if (indexRecovery.recovered) {
        send('app:notice', {
          level: 'warn',
          messageKey: indexRecovery.backupPath
            ? 'indexRecoveredWithBackup'
            : 'indexRecoveredWithoutBackup',
          params: indexRecovery.backupPath ? { backupPath: indexRecovery.backupPath } : {}
        });
      }
      if (loaded.recordingsDirFellBack) {
        send('app:notice', {
          level: 'warn',
          messageKey: loaded.recordingsDirFallbackReason === 'invalid'
            ? 'recordingsDirFallbackInvalid'
            : 'recordingsDirFallbackUnwritable',
          params: {
            requestedDir: loaded.requestedRecordingsDir,
            recordingsDir: settings.recordingsDir
          }
        });
      }
      if (sweep.recovered.length > 0) {
        send('app:notice', {
          level: 'info',
          messageKey: 'recordingsRecovered',
          params: { count: sweep.recovered.length }
        });
      }
      if (sweep.failed.length > 0) {
        send('app:notice', {
          level: 'warn',
          messageKey: 'recordingsRecoveryFailed',
          params: { count: sweep.failed.length, tempDir: settings.tempDir }
        });
      }
      if (reconciliation.restored > 0) {
        send('app:notice', {
          level: 'info',
          messageKey: 'optimizationRecovered',
          params: { count: reconciliation.restored }
        });
      }
      if (reconciliation.failed.length > 0) {
        send('app:notice', {
          level: 'warn',
          messageKey: 'optimizationRecoveryFailed',
          params: { count: reconciliation.failed.length }
        });
      }
    }

    if (IS_SMOKE) {
      setTimeout(() => finishSmoke(1, 'SMOKE FAIL timeout'), SMOKE_TIMEOUT_MS);
    }
  } catch (error) {
    // Startup used to fail silently here, leaving no window and no explanation.
    dialog.showErrorBox(
      'RP4 Recorder',
      `앱을 시작할 수 없습니다.\n\n${error?.message || error}\n\n설정 폴더: ${paths.configDir()}`
    );
    app.exit(1);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = windows.createMainWindow({
        isSmoke: IS_SMOKE,
        onRendererGone: (win, details) => handleRendererGone(win, details)
          .catch((error) => reportFatalAsyncFailure(error, 'renderer-gone recovery')),
        onRendererUnresponsive: (win) => handleRendererUnresponsive(win)
          .catch((error) => reportFatalAsyncFailure(error, 'renderer-unresponsive recovery')),
        getRendererUnresponsiveGraceMs: rendererUnresponsiveGraceMs
      });
    } else {
      windows.showMainWindow(mainWindow);
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    requestShutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      requestShutdown();
    }
  });
}

process.on('uncaughtExceptionMonitor', (error) => {
  process.stderr.write(`uncaught: ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
  reportFatalAsyncFailure(reason, 'unhandled rejection');
});
