'use strict';

const { app, BrowserWindow, dialog, ipcMain, session } = require('electron/main');
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
const SMOKE_TIMEOUT_MS = 30000;

const settings = new SettingsStore();
const windowCrop = new WindowCropService();

let mainWindow = null;
let recordings = null;
let hotkeys = null;
let isQuitting = false;
let smokeFinished = false;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
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
  if (message) {
    process.stdout.write(`${message}\n`);
  }
  app.exit(code);
}

/**
 * Cleanly shuts down: finalizes any in-flight recording, releases hotkeys, stops the
 * helper process and cancels background ffmpeg work.
 *
 * `before-quit` cannot be used for this on its own because Electron ignores the promise
 * returned by an async listener, so the process could exit before the files were closed.
 */
async function shutdown() {
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
  if (recordings) {
    await cleanup('recordings', () => (
      windows.drainRecordings(mainWindow, recordings, { timeoutMs: 20000 })
    ));
    await cleanup('session handles', () => recordings.closeAllSessions());
    await cleanup('optimizations', () => recordings.cancelAndDrainOptimizations());
  }
  // Also covers an FFmpeg job that was started outside RecordingManager.
  await cleanup('ffmpeg', () => ffmpeg.cancelAll());
  await cleanup('window crop', () => windowCrop.dispose());

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.rp4AllowClose = true;
    mainWindow.destroy();
  }

  app.exit(0);
}

/**
 * Runs when the user tries to close the window. Confirms first when a recording is in
 * progress so a take is never discarded by accident.
 */
async function handleQuitRequest(win) {
  if (isQuitting) return;

  if (recordings?.hasPendingRecordings()) {
    const shouldSave = await windows.confirmCloseWhileRecording(win);
    if (!shouldSave) return;
  }

  await shutdown();
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
    await paths.ensureRecordingDirs(settings.recordingsDir);

    recordings = new RecordingManager({ settings, emit: send });
    const indexRecovery = await recordings.loadIndex();
    const reconciliation = await recordings.reconcileRecordingsDir();

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

    registerIpcHandlers({ settings, recordings, windowCrop, hotkeys, isSmoke: IS_SMOKE });

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
      onQuitRequested: handleQuitRequest
    });

    hotkeys.register(settings.value.hotkeys);

    // Recover anything a previous crash left behind, and tell the user if their
    // configured folder was not usable.
    const sweep = await recordings.sweepTempDir();
    mainWindow.webContents.once('did-finish-load', () => {
      if (loaded.settingsRecovered) {
        send('app:notice', {
          level: 'warn',
          message: loaded.settingsBackupPath
            ? `손상된 설정 파일을 ${loaded.settingsBackupPath}에 백업하고 기본 설정으로 복구했습니다.`
            : '설정 파일이 손상되어 기본 설정으로 복구했지만 원본 백업을 만들지 못했습니다.'
        });
      }
      if (indexRecovery.recovered) {
        send('app:notice', {
          level: 'warn',
          message: indexRecovery.backupPath
            ? `손상된 녹화 인덱스를 ${indexRecovery.backupPath}에 백업하고 새 인덱스로 복구했습니다.`
            : '녹화 인덱스를 읽지 못해 빈 인덱스로 시작했습니다. 원본 파일은 보존했습니다.'
        });
      }
      if (loaded.recordingsDirFellBack) {
        const reason = loaded.recordingsDirFallbackReason === 'invalid'
          ? '올바른 절대 경로가 아닙니다.'
          : '폴더를 만들거나 쓸 수 없습니다.';
        send('app:notice', {
          level: 'warn',
          message: `설정된 저장 폴더(${loaded.requestedRecordingsDir})를 사용할 수 없습니다: ${reason} ${settings.recordingsDir} 로 변경했습니다.`
        });
      }
      if (sweep.recovered.length > 0) {
        send('app:notice', {
          level: 'info',
          message: `이전에 완료되지 못한 녹화 ${sweep.recovered.length}개를 복구했습니다.`
        });
      }
      if (sweep.failed.length > 0) {
        send('app:notice', {
          level: 'warn',
          message: `이전 녹화 ${sweep.failed.length}개를 복구하지 못했습니다. 원본은 ${settings.tempDir}에 보존했습니다.`
        });
      }
      if (reconciliation.restored > 0) {
        send('app:notice', {
          level: 'info',
          message: `중단된 MP4 최적화에서 녹화 ${reconciliation.restored}개를 복구했습니다.`
        });
      }
      if (reconciliation.failed.length > 0) {
        send('app:notice', {
          level: 'warn',
          message: `최적화 잔여 파일 ${reconciliation.failed.length}개를 자동 복구하지 못했습니다.`
        });
      }
    });

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
        onQuitRequested: handleQuitRequest
      });
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      void shutdown();
    }
  });
}

process.on('uncaughtExceptionMonitor', (error) => {
  process.stderr.write(`uncaught: ${error?.stack || error}\n`);
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandled rejection: ${reason?.stack || reason}\n`);
});
