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
let systemSessionShutdownPromise = null;
const SYSTEM_SESSION_END_DRAIN_TIMEOUT_MS = 4000;
const SYSTEM_SESSION_END_MAX_TOTAL_MS = 12000;
const SYSTEM_SESSION_END_HARD_DEADLINE_MS = 15000;

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
    const rendererUnavailable = !mainWindow || mainWindow.isDestroyed()
      || mainWindow.webContents.isDestroyed();
    await shutdown({
      // An unhandled main-process task does not imply that the renderer crashed.  When it
      // is still alive, let it flush MediaRecorder's terminal data before the main process
      // closes its staging handles.
      rendererUnavailable,
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

function hasVolatileCaptureWork() {
  return Boolean(
    rendererCaptureState.recordingActive
    || rendererCaptureState.clipActive
    || rendererCaptureState.clipSaving
    || recordings?.hasPendingRecordings()
  );
}

function systemSessionClipShutdownMode() {
  if (rendererCaptureState.clipSaving) return 'wait-current-save';
  return rendererCaptureState.clipActive ? 'save-current-buffer' : 'discard';
}

/**
 * Windows bypasses Electron's ordinary quit events while ending a user session.  Do a
 * short, non-interactive finalization attempt here, then leave journals/raw staging in
 * place for next-start recovery if the OS deadline wins.
 */
function beginSystemSessionShutdown() {
  if (systemSessionShutdownPromise) return systemSessionShutdownPromise;
  const failureReason = 'Windows 종료 또는 로그아웃으로 녹화를 안전하게 마무리합니다.';
  const hardTimer = setTimeout(() => {
    recordings?.abandonForRecovery('Windows 종료 제한 시간 초과');
    void recordings?.closeAllSessions().catch(() => {});
    app.exit(0);
  }, SYSTEM_SESSION_END_HARD_DEADLINE_MS);
  systemSessionShutdownPromise = shutdown({
    clipShutdownMode: systemSessionClipShutdownMode(),
    failureReason,
    systemSessionEnding: true,
    drainTimeoutMs: SYSTEM_SESSION_END_DRAIN_TIMEOUT_MS,
    drainMaxTotalMs: SYSTEM_SESSION_END_MAX_TOTAL_MS
  }).catch((error) => {
    process.stderr.write(`Windows session shutdown failed: ${error?.stack || error}\n`);
    recordings?.abandonForRecovery(failureReason);
    app.exit(1);
  }).finally(() => {
    clearTimeout(hardTimer);
  });
  return systemSessionShutdownPromise;
}

function handleQuerySessionEnd() {
  if (isQuitting || !hasVolatileCaptureWork()) return false;
  void beginSystemSessionShutdown();
  return true;
}

function handleSessionEnd() {
  if (isQuitting || !hasVolatileCaptureWork()) return;
  void beginSystemSessionShutdown();
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
  exitCode = 0,
  systemSessionEnding = false,
  drainTimeoutMs = 20000,
  drainMaxTotalMs = windows.MAX_TOTAL_SHUTDOWN_MS
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
          timeoutMs: drainTimeoutMs,
          maxTotalMs: drainMaxTotalMs,
          clipShutdownMode: 'discard',
          timeoutFailureReason: failureReason
        });
      });
    } else {
      try {
        drainResult = await windows.drainRecordings(mainWindow, recordings, {
          timeoutMs: drainTimeoutMs,
          maxTotalMs: drainMaxTotalMs,
          clipShutdownMode,
          timeoutFailureReason: failureReason
        });
      } catch (error) {
        process.stderr.write(`shutdown recordings error: ${error?.message || error}\n`);
      }
      if (drainResult?.shutdownFailed && clipShutdownMode !== 'discard') {
        if (systemSessionEnding) {
          await windows.drainRecordings(mainWindow, recordings, {
            timeoutMs: Math.min(drainTimeoutMs, 3000),
            maxTotalMs: Math.min(drainMaxTotalMs, 5000),
            clipShutdownMode: 'discard',
            timeoutFailureReason: failureReason
          });
        } else {
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
          timeoutMs: drainTimeoutMs,
          maxTotalMs: drainMaxTotalMs,
          clipShutdownMode: 'discard',
          timeoutFailureReason: failureReason
        });
        }
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
      getRendererUnresponsiveGraceMs: rendererUnresponsiveGraceMs,
      onQuerySessionEnd: handleQuerySessionEnd,
      onSessionEnd: handleSessionEnd
    });
    if (!IS_SMOKE) {
      tray = windows.createTray({
        getMainWindow: () => mainWindow,
        getLanguage: () => settings.value.language,
        onQuitRequested: handleQuitRequest
      });
    }
    const rendererLoaded = mainWindow.rp4Loaded;
    // Start recovery immediately after the window begins loading.  Recording start IPC is
    // already registered, so RecordingManager's mutation gate owns the recovery slot
    // before the renderer can become interactive, while first paint still proceeds.
    const startupRecovery = recordings.recoverAtStartup();

    hotkeys.register(settings.value.hotkeys);

    await rendererLoaded;
    // The window becomes interactive before media probing/recovery finishes.  Starts wait
    // behind RecordingManager's mutation gate so a live staging file cannot be mistaken
    // for a crash leftover while this work is in progress.
    const { sweep, reconciliation } = await startupRecovery;
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
        getRendererUnresponsiveGraceMs: rendererUnresponsiveGraceMs,
        onQuerySessionEnd: handleQuerySessionEnd,
        onSessionEnd: handleSessionEnd
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

process.on('uncaughtException', (error) => {
  reportFatalAsyncFailure(error, 'uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  reportFatalAsyncFailure(reason, 'unhandled rejection');
});
