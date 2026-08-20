'use strict';

const { BrowserWindow, Menu, Tray, ipcMain, shell, dialog } = require('electron/main');
const crypto = require('node:crypto');
const path = require('node:path');

const displays = require('./displays');
const ffmpeg = require('./ffmpeg');

const SRC_DIR = path.resolve(__dirname, '..');
const APP_ROOT = path.resolve(SRC_DIR, '..');
const ICON_PATH = path.join(APP_ROOT, 'icon.ico');
const UNRESPONSIVE_GRACE_MS = 10000;
const UNRESPONSIVE_RECORDING_GRACE_MS = 60000;
const MAX_TOTAL_SHUTDOWN_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks in-app navigation and popups. Nothing in this app should ever leave its own
 * pages, and external links belong in the user's browser.
 */
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch((error) => {
        process.stderr.write(`open external URL failed: ${error?.stack || error}\n`);
      });
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function createMainWindow({
  isSmoke,
  onRendererGone,
  onRendererUnresponsive,
  getRendererUnresponsiveGraceMs
}) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#07080a',
    title: 'RP4 Recorder',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(SRC_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Area and window capture crop frames inside the renderer. Chromium throttles
      // timers and rendering for hidden windows, which would stall capture the moment the
      // user alt-tabs away, which would break background window and area recording.
      backgroundThrottling: false
    }
  });

  hardenWebContents(win.webContents);
  let unresponsiveTimer = null;
  const clearUnresponsiveTimer = () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  };
  win.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveTimer();
    void Promise.resolve(onRendererGone?.(win, details)).catch((error) => {
      process.stderr.write(`renderer-gone handler failed: ${error?.stack || error}\n`);
    });
  });
  win.webContents.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    const requestedGraceMs = Number(getRendererUnresponsiveGraceMs?.(win));
    const graceMs = Math.max(
      UNRESPONSIVE_GRACE_MS,
      Number.isFinite(requestedGraceMs) ? requestedGraceMs : UNRESPONSIVE_GRACE_MS
    );
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      void Promise.resolve(onRendererUnresponsive?.(win)).catch((error) => {
        process.stderr.write(`renderer-unresponsive handler failed: ${error?.stack || error}\n`);
      });
    }, graceMs);
  });
  win.webContents.on('responsive', clearUnresponsiveTimer);
  win.webContents.on('destroyed', clearUnresponsiveTimer);

  win.once('ready-to-show', () => {
    if (isSmoke) return;
    win.show();
  });

  const reportVisibility = (visible) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('app:window-visibility', { visible });
    }
  };
  win.on('hide', () => reportVisibility(false));
  win.on('show', () => reportVisibility(true));

  win.on('close', (event) => {
    if (win.rp4AllowClose) return;
    event.preventDefault();
    win.hide();
  });

  win.rp4Loaded = win.loadFile(path.join(SRC_DIR, 'index.html')).catch(async (error) => {
    if (!isSmoke && !win.isDestroyed()) {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: 'RP4 Recorder',
        message: '프로그램 화면을 불러오지 못했습니다.',
        detail: error?.message || String(error)
      }).catch(() => {});
    }
    if (!win.isDestroyed()) {
      win.rp4AllowClose = true;
      win.destroy();
    }
    throw error;
  });
  return win;
}

function showMainWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray({ getMainWindow, getLanguage, onQuitRequested }) {
  const tray = new Tray(ICON_PATH);
  tray.setToolTip('RP4 Recorder');
  const buildContextMenu = () => Menu.buildFromTemplate([
    {
      label: getLanguage?.() === 'en' ? 'Exit' : '종료',
      click: () => void Promise.resolve(onQuitRequested?.(getMainWindow?.())).catch((error) => {
        process.stderr.write(`tray quit handler failed: ${error?.stack || error}\n`);
      })
    }
  ]);
  tray.on('click', () => showMainWindow(getMainWindow?.()));
  tray.on('double-click', () => showMainWindow(getMainWindow?.()));
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
  return tray;
}

/**
 * Asks the renderer to flush and finalize any in-flight recording, then waits for the
 * sessions to drain. Closing the window used to abandon the take in the temporary folder, where it was
 * invisible to the user.
 */
async function drainRecordings(win, recordingManager, {
  timeoutMs = 20000,
  maxTotalMs = MAX_TOTAL_SHUTDOWN_MS,
  clipShutdownMode = 'discard',
  timeoutFailureReason = null
} = {}) {
  const hardDeadline = Date.now() + Math.max(1, maxTotalMs);
  const requestId = crypto.randomUUID();
  let rendererReady = !win || win.isDestroyed();
  let rendererAccepted = rendererReady;

  if (win && !win.isDestroyed()) {
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let hardTimer = null;
      let accepted = false;
      let lastProgress = null;
      let lastProgressPhase = null;
      const armInactivityTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), timeoutMs);
      };
      const finish = (completed, { failed = false, error = null } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        ipcMain.removeListener('app:shutdown-accepted', onAccepted);
        ipcMain.removeListener('app:shutdown-progress', onProgress);
        ipcMain.removeListener('app:shutdown-failed', onFailed);
        ipcMain.removeListener('app:shutdown-ready', onReady);
        win.webContents.removeListener('destroyed', onDestroyed);
        resolve({ completed, accepted, failed, error });
      };
      const matches = (event, payload) => (
        event.sender === win.webContents && payload?.requestId === requestId
      );
      const onAccepted = (event, payload = {}) => {
        if (!matches(event, payload)) return;
        accepted = true;
        armInactivityTimer();
      };
      const onProgress = (event, payload = {}) => {
        if (!matches(event, payload)) return;
        const progress = payload.progress && typeof payload.progress === 'object'
          ? payload.progress : {};
        const phase = typeof progress.phase === 'string' ? progress.phase : '';
        const completedBytes = Number(progress.completedBytes);
        const totalBytes = Number(progress.totalBytes);
        const ratio = Number(progress.ratio);
        const hasMeasuredProgress = Number.isFinite(completedBytes)
          || Number.isFinite(totalBytes) || Number.isFinite(ratio);
        // A changing heartbeat sequence only proves that JavaScript is alive; it must not
        // postpone the shutdown watchdog when the encoder/write queue is stuck.  A phase
        // transition is useful once, while byte/ratio changes are actual forward work.
        if (!hasMeasuredProgress && phase === lastProgressPhase) return;
        const signature = JSON.stringify({
          phase,
          completedBytes: Number.isFinite(completedBytes) ? completedBytes : null,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
          ratio: Number.isFinite(ratio) ? ratio : null
        });
        if (signature === lastProgress) return;
        lastProgress = signature;
        lastProgressPhase = phase;
        armInactivityTimer();
      };
      const onFailed = (event, payload = {}) => {
        if (!matches(event, payload)) return;
        finish(false, { failed: true, error: payload.error || '클립을 저장하지 못했습니다.' });
      };
      const onReady = (event, payload = {}) => {
        if (!matches(event, payload)) return;
        finish(true);
      };
      const onDestroyed = () => finish(false);

      ipcMain.on('app:shutdown-accepted', onAccepted);
      ipcMain.on('app:shutdown-progress', onProgress);
      ipcMain.on('app:shutdown-failed', onFailed);
      ipcMain.on('app:shutdown-ready', onReady);
      win.webContents.once('destroyed', onDestroyed);
      armInactivityTimer();
      hardTimer = setTimeout(() => finish(false), Math.max(1, hardDeadline - Date.now()));
      try {
        win.webContents.send('app:finalize-recordings', { requestId, clipShutdownMode });
      } catch {
        finish(false);
      }
    });
    rendererReady = result.completed;
    rendererAccepted = result.accepted;
    if (result.failed) {
      return {
        drained: false,
        rendererReady: false,
        rendererAccepted,
        timedOut: false,
        shutdownFailed: true,
        error: result.error,
        saved: []
      };
    }
  }

  const deadline = Math.min(Date.now() + timeoutMs, hardDeadline);
  while (recordingManager.hasActiveSessions() && Date.now() < deadline) {
    await sleep(150);
  }

  // The hard deadline covers renderer stop, write chains and finalization. On timeout we
  // leave app-owned temp files/journals intact for startup recovery instead of hanging.
  const timedOut = !rendererReady || recordingManager.hasActiveSessions();
  let saved = [];
  let finalizationTimedOut = timedOut;
  if (!timedOut) {
    let timer;
    const remainingMs = Math.max(0, hardDeadline - Date.now());
    const result = await Promise.race([
      recordingManager.finalizeAllSessions({ failureReason: null })
        .then((value) => ({ completed: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false, value: [] }), remainingMs);
      })
    ]);
    clearTimeout(timer);
    saved = result.value;
    finalizationTimedOut = !result.completed;
  }
  if (finalizationTimedOut) {
    const cancelBudgetMs = Math.max(0, Math.min(5000, hardDeadline - Date.now()));
    if (cancelBudgetMs > 0) {
      await ffmpeg.cancelAll({ timeoutMs: cancelBudgetMs }).catch(() => false);
    }
    recordingManager.abandonForRecovery?.(
      timeoutFailureReason || '앱 종료 제한 시간이 지나 다음 실행에서 복구합니다.'
    );
  }
  return {
    drained: !recordingManager.hasPendingRecordings(),
    rendererReady,
    rendererAccepted,
    timedOut: finalizationTimedOut,
    shutdownFailed: false,
    saved
  };
}

async function confirmCloseWhileRecording(win, language = 'ko') {
  const english = language === 'en';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: english ? ['Save and Exit', 'Keep Recording'] : ['저장하고 종료', '계속 녹화'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'RP4 Recorder',
    message: english ? 'Recording is in progress.' : '녹화가 진행 중입니다.',
    detail: english
      ? 'The recording will be finalized and saved before the app exits.'
      : '지금 종료하면 녹화를 마무리한 뒤 파일을 저장합니다.'
  });
  return response === 0;
}

/**
 * A renderer can temporarily stop responding while encoding a high-resolution image
 * or collecting native frames.  Do not turn that observation into an automatic quit;
 * after the grace period, let the user decide whether to wait or safely finalize.
 */
async function confirmRendererUnresponsive(win, {
  language = 'ko',
  recordingActive = false
} = {}) {
  const english = language === 'en';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: english ? ['Keep Waiting', 'Save and Exit'] : ['계속 대기', '안전 저장 후 종료'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'RP4 Recorder',
    message: english ? 'RP4 Recorder is not responding.' : 'RP4 Recorder가 응답하지 않습니다.',
    detail: english
      ? recordingActive
        ? 'Recording or image processing may be busy. Keep waiting, or finalize the current work and exit.'
        : 'The app may recover. Keep waiting, or exit safely.'
      : recordingActive
        ? '녹화 또는 이미지 처리가 일시적으로 바쁠 수 있습니다. 계속 기다리거나 현재 작업을 안전하게 저장한 뒤 종료할 수 있습니다.'
        : '앱이 다시 응답할 수 있습니다. 계속 기다리거나 안전하게 종료할 수 있습니다.'
  }).catch(() => ({ response: 0 }));
  return response === 1 ? 'exit' : 'wait';
}

async function confirmCloseWhileClip(win, { saving = false, language = 'ko' } = {}) {
  const english = language === 'en';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: saving
      ? english ? ['Exit After Saving', 'Cancel'] : ['저장 완료 후 종료', '취소']
      : english
        ? ['Save Recent Clip and Exit', 'Exit Without Saving', 'Cancel']
        : ['최근 클립 저장 후 종료', '저장하지 않고 종료', '취소'],
    defaultId: 0,
    cancelId: saving ? 1 : 2,
    noLink: true,
    title: 'RP4 Recorder',
    message: saving
      ? english ? 'A clip is being saved.' : '클립 저장이 진행 중입니다.'
      : english ? 'Clip Mode is active.' : '클립 녹화 모드가 실행 중입니다.',
    detail: saving
      ? english ? 'The app will exit after the current save finishes safely.' : '진행 중인 저장을 안전하게 마친 뒤 종료합니다.'
      : english ? 'You can save the recent buffered footage before exiting.' : '종료하기 전에 현재 버퍼의 최근 장면을 저장할 수 있습니다.'
  });
  if (saving) return response === 0 ? 'wait-current-save' : 'cancel';
  return response === 0 ? 'save-current-buffer' : response === 1 ? 'discard' : 'cancel';
}

async function confirmClipSaveFailure(win, error, language = 'ko') {
  const english = language === 'en';
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    buttons: english ? ['Return to App', 'Exit Without Saving'] : ['앱으로 돌아가기', '저장하지 않고 종료'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'RP4 Recorder',
    message: english ? 'The recent clip could not be saved.' : '최근 클립을 저장하지 못했습니다.',
    detail: String(error || (english
      ? 'Check the storage device and available space.'
      : '저장 장치와 여유 공간을 확인해 주세요.')).slice(0, 500)
  });
  return response === 1 ? 'discard' : 'return';
}

/**
 * Full-desktop region selector. The previous version only ever covered the primary
 * display, so a region on a second monitor could not be selected at all.
 */
function selectDesktopArea({ isSmoke } = {}) {
  if (isSmoke) return Promise.resolve(null);
  if (selectDesktopArea.current) {
    selectDesktopArea.current.focus();
    return Promise.resolve(null);
  }

  const payload = displays.getDisplayPayload();
  const bounds = payload.virtualBounds;

  return new Promise((resolve) => {
    let settled = false;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      enableLargerThanScreen: true,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        // This window used to run with nodeIntegration and no context isolation, giving
        // a screen-covering always-on-top surface full Node access. It now goes through a
        // minimal preload like every other renderer.
        preload: path.join(SRC_DIR, 'preload-area.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    hardenWebContents(win.webContents);
    selectDesktopArea.current = win;
    win.setAlwaysOnTop(true, 'screen-saver');

    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('area-selector:complete', onComplete);
      ipcMain.removeListener('area-selector:cancel', onCancel);
      selectDesktopArea.current = null;
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };

    const onComplete = (event, rect) => {
      if (event.sender !== win.webContents) return;
      finish(displays.normalizeDesktopArea(rect));
    };
    const onCancel = (event) => {
      if (event.sender !== win.webContents) return;
      finish(null);
    };

    ipcMain.on('area-selector:complete', onComplete);
    ipcMain.on('area-selector:cancel', onCancel);
    win.on('closed', () => finish(null));

    void win.loadFile(path.join(SRC_DIR, 'area-selector.html')).catch(() => finish(null));
    win.once('ready-to-show', () => {
      win.setBounds(bounds, false);
      win.show();
      win.focus();
    });
  });
}
selectDesktopArea.current = null;

function closeAreaSelector() {
  const win = selectDesktopArea.current;
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  selectDesktopArea.current = null;
}

module.exports = {
  APP_ROOT,
  SRC_DIR,
  ICON_PATH,
  createMainWindow,
  createTray,
  showMainWindow,
  hardenWebContents,
  drainRecordings,
  confirmCloseWhileRecording,
  confirmRendererUnresponsive,
  confirmCloseWhileClip,
  confirmClipSaveFailure,
  selectDesktopArea,
  closeAreaSelector,
  sleep,
  UNRESPONSIVE_GRACE_MS,
  UNRESPONSIVE_RECORDING_GRACE_MS,
  MAX_TOTAL_SHUTDOWN_MS
};
