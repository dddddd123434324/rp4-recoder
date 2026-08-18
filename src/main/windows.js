'use strict';

const { BrowserWindow, ipcMain, shell, dialog } = require('electron/main');
const crypto = require('node:crypto');
const path = require('node:path');

const displays = require('./displays');

const SRC_DIR = path.resolve(__dirname, '..');
const APP_ROOT = path.resolve(SRC_DIR, '..');
const ICON_PATH = path.join(APP_ROOT, 'icon.ico');
const UNRESPONSIVE_GRACE_MS = 10000;

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
      void shell.openExternal(url);
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

function createMainWindow({ isSmoke, onQuitRequested, onRendererGone, onRendererUnresponsive }) {
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
      // user alt-tabs away - exactly when a game recorder is expected to be working.
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
    void onRendererGone?.(win, details);
  });
  win.webContents.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      void onRendererUnresponsive?.(win);
    }, UNRESPONSIVE_GRACE_MS);
  });
  win.webContents.on('responsive', clearUnresponsiveTimer);
  win.webContents.on('destroyed', clearUnresponsiveTimer);

  win.once('ready-to-show', () => {
    if (isSmoke) return;
    win.show();
  });

  win.on('close', (event) => {
    if (win.rp4AllowClose) return;
    event.preventDefault();
    void onQuitRequested(win);
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

/**
 * Asks the renderer to flush and finalize any in-flight recording, then waits for the
 * sessions to drain. Closing the window used to abandon the take in the temporary folder, where it was
 * invisible to the user.
 */
async function drainRecordings(win, recordingManager, {
  timeoutMs = 20000,
  saveActiveClip = false,
  timeoutFailureReason = null
} = {}) {
  const requestId = crypto.randomUUID();
  let rendererReady = !win || win.isDestroyed();
  let rendererAccepted = rendererReady;

  if (win && !win.isDestroyed()) {
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let accepted = false;
      const armInactivityTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), timeoutMs);
      };
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ipcMain.removeListener('app:shutdown-accepted', onAccepted);
        ipcMain.removeListener('app:shutdown-progress', onProgress);
        ipcMain.removeListener('app:shutdown-ready', onReady);
        win.webContents.removeListener('destroyed', onDestroyed);
        resolve({ completed, accepted });
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
        armInactivityTimer();
      };
      const onReady = (event, payload = {}) => {
        if (!matches(event, payload)) return;
        finish(true);
      };
      const onDestroyed = () => finish(false);

      ipcMain.on('app:shutdown-accepted', onAccepted);
      ipcMain.on('app:shutdown-progress', onProgress);
      ipcMain.on('app:shutdown-ready', onReady);
      win.webContents.once('destroyed', onDestroyed);
      armInactivityTimer();
      try {
        win.webContents.send('app:finalize-recordings', { requestId, saveActiveClip });
      } catch {
        finish(false);
      }
    });
    rendererReady = result.completed;
    rendererAccepted = result.accepted;
  }

  const deadline = Date.now() + timeoutMs;
  while (recordingManager.hasActiveSessions() && Date.now() < deadline) {
    await sleep(150);
  }

  // Safety net for anything the renderer could not finish on its own. Once finalization
  // starts it is intentionally not timed out: cancelling ffmpeg here could corrupt the
  // only copy of the recording.
  const timedOut = !rendererReady || recordingManager.hasActiveSessions();
  const saved = await recordingManager.finalizeAllSessions({
    failureReason: timedOut
      ? timeoutFailureReason || '앱 종료 대기 시간이 지나 부분 저장했습니다.'
      : null
  });
  return {
    drained: !recordingManager.hasPendingRecordings(),
    rendererReady,
    rendererAccepted,
    timedOut,
    saved
  };
}

async function confirmCloseWhileRecording(win) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['저장하고 종료', '계속 녹화'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'RP4 Recorder',
    message: '녹화가 진행 중입니다.',
    detail: '지금 종료하면 녹화를 마무리한 뒤 파일을 저장합니다.'
  });
  return response === 0;
}

async function confirmCloseWhileClip(win) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['최근 클립 저장 후 종료', '저장하지 않고 종료', '취소'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'RP4 Recorder',
    message: '클립 녹화 모드가 실행 중입니다.',
    detail: '종료하기 전에 현재 버퍼의 최근 장면을 저장할 수 있습니다.'
  });
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
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
  hardenWebContents,
  drainRecordings,
  confirmCloseWhileRecording,
  confirmCloseWhileClip,
  selectDesktopArea,
  closeAreaSelector,
  sleep,
  UNRESPONSIVE_GRACE_MS
};
