const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } = require('electron/main');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ffmpegPath = require('ffmpeg-static');

const APP_ROOT = path.resolve(__dirname, '..');
const ICON_PATH = path.join(APP_ROOT, 'icon.ico');
const RP4_ROOT = path.resolve('D:\\RP4');
const CONFIG_DIR = path.join(RP4_ROOT, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'rp4-recorder-settings.json');
const DEFAULT_RECORDINGS_DIR = path.join(RP4_ROOT, 'recordings');
const DEFAULT_SELECTED_PRESET = 'normal';
const BUILTIN_PRESET_KEYS = new Set(['low', 'normal', 'high', 'game']);
const MAX_CUSTOM_PRESETS = 48;
const IS_SMOKE = process.env.RP4_SMOKE === '1';

const recordingSessions = new Map();
const recordingMetadata = new Map();
const DEFAULT_HOTKEYS = {
  recordToggle: 'CommandOrControl+Shift+R',
  pauseToggle: 'CommandOrControl+Shift+P',
  screenshot: 'CommandOrControl+Shift+S',
  clipToggle: 'CommandOrControl+Shift+C',
  clipSave: 'CommandOrControl+Shift+V'
};
const HOTKEY_ACTIONS = Object.keys(DEFAULT_HOTKEYS);

let mainWindow = null;
let areaSelectionWindow = null;
let appSettings = {
  hotkeys: { ...DEFAULT_HOTKEYS },
  selectedPreset: DEFAULT_SELECTED_PRESET,
  customPresets: [],
  recordingsDir: DEFAULT_RECORDINGS_DIR
};
let hotkeyRegistrations = {};

function createWindow() {
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = win;
  win.once('ready-to-show', () => {
    if (IS_SMOKE) {
      setTimeout(() => app.quit(), 250);
      return;
    }
    win.show();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

async function ensureFolders() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(getRecordingsDir(), { recursive: true });
  await fs.mkdir(getTempRecordingsDir(), { recursive: true });
  await fs.mkdir(getScreenshotsDir(), { recursive: true });
}

function mergeSettings(value = {}) {
  const hotkeys = {};
  const inputHotkeys = value && typeof value.hotkeys === 'object' ? value.hotkeys : {};

  for (const action of HOTKEY_ACTIONS) {
    hotkeys[action] = typeof inputHotkeys[action] === 'string'
      ? inputHotkeys[action]
      : DEFAULT_HOTKEYS[action];
  }

  const customPresets = normalizeCustomPresets(value.customPresets);
  return {
    hotkeys,
    selectedPreset: normalizeSelectedPreset(value.selectedPreset, customPresets),
    customPresets,
    recordingsDir: normalizeRecordingsDir(value.recordingsDir)
  };
}

function getRecordingsDir() {
  return appSettings.recordingsDir || DEFAULT_RECORDINGS_DIR;
}

function getTempRecordingsDir() {
  return path.join(getRecordingsDir(), '.temp');
}

function getScreenshotsDir() {
  return path.join(getRecordingsDir(), 'screenshots');
}

function normalizeRecordingsDir(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return DEFAULT_RECORDINGS_DIR;
  }
  return path.resolve(value.trim());
}

function normalizeSelectedPreset(value, customPresets = []) {
  const key = typeof value === 'string' ? value : DEFAULT_SELECTED_PRESET;
  if (BUILTIN_PRESET_KEYS.has(key)) return key;

  const customId = key.startsWith('custom:') ? key.slice(7) : null;
  if (customId && customPresets.some((preset) => preset.id === customId)) {
    return key;
  }

  return DEFAULT_SELECTED_PRESET;
}

function normalizeCustomPresets(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  return value
    .slice(0, MAX_CUSTOM_PRESETS)
    .map((item, index) => {
      const source = item && typeof item === 'object' ? item : {};
      const rawId = typeof source.id === 'string' && source.id.trim()
        ? source.id.trim()
        : crypto.randomUUID();
      const id = seen.has(rawId) ? crypto.randomUUID() : rawId;
      seen.add(id);

      return {
        id,
        name: sanitizePresetName(source.name || `사용자 프리셋 ${index + 1}`),
        profile: normalizePresetProfile(source.profile || source)
      };
    });
}

function sanitizePresetName(value) {
  return String(value || '사용자 프리셋')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '사용자 프리셋';
}

function normalizePresetProfile(value = {}) {
  const profile = value && typeof value === 'object' ? value : {};
  const format = ['mp4', 'webm'].includes(profile.format) ? profile.format : 'mp4';
  const resolution = /^\d{3,5}x\d{3,5}$/.test(String(profile.resolution || ''))
    ? String(profile.resolution)
    : '1920x1080';
  const encoderPreset = normalizeEncoderPreset(profile.encoderPreset);
  const micVolume = Number(profile.micVolume);
  const systemVolume = Number(profile.systemVolume);

  return {
    format,
    resolution,
    fps: String(clampNumber(Number(profile.fps) || 60, 1, 240)),
    bitrate: String(clampNumber(Number(profile.bitrate) || 10, 1, 300)),
    encoderPreset,
    audioBitrate: String(clampNumber(Number(profile.audioBitrate) || 192, 64, 320)),
    micEnabled: profile.micEnabled !== false,
    systemAudioEnabled: profile.systemAudioEnabled !== false,
    micVolume: clampNumber(Number.isFinite(micVolume) ? micVolume : 70, 0, 100),
    systemVolume: clampNumber(Number.isFinite(systemVolume) ? systemVolume : 80, 0, 100),
    clipDurationSeconds: clampNumber(Number(profile.clipDurationSeconds) || 300, 1, 7200)
  };
}

async function loadSettings() {
  const raw = await readJson(SETTINGS_FILE);
  appSettings = mergeSettings(raw || {});
  return appSettings;
}

async function saveSettings() {
  await ensureFolders();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8');
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyRegistrations = {};

  const used = new Set();
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = appSettings.hotkeys[action];
    if (!accelerator) {
      hotkeyRegistrations[action] = { registered: false, reason: 'disabled' };
      continue;
    }

    const key = accelerator.toLowerCase();
    if (used.has(key)) {
      hotkeyRegistrations[action] = { registered: false, reason: 'duplicate' };
      continue;
    }

    used.add(key);
    let lastError = null;
    try {
      let registered = false;
      let registeredAccelerator = null;
      const candidates = getAcceleratorCandidates(accelerator);
      for (const candidate of candidates) {
        try {
          registered = globalShortcut.register(candidate, () => {
            mainWindow?.webContents.send('hotkey:trigger', action);
          });
        } catch (error) {
          lastError = error;
          registered = false;
        }
        if (registered) {
          registeredAccelerator = candidate;
          break;
        }
      }
      hotkeyRegistrations[action] = {
        registered,
        accelerator: registeredAccelerator,
        candidates,
        reason: registered ? null : 'unavailable'
      };
    } catch (error) {
      hotkeyRegistrations[action] = {
        registered: false,
        reason: error.message || lastError?.message || 'error'
      };
    }
  }

  return hotkeyRegistrations;
}

function getAcceleratorCandidates(accelerator) {
  const candidates = [accelerator];

  if (process.platform === 'win32' || process.platform === 'linux') {
    candidates.push(accelerator.replace(/\bCommandOrControl\b/g, 'Control'));
  }

  if (accelerator.includes('Esc')) {
    candidates.push(accelerator.replace(/\bEsc\b/g, 'Escape'));
  }

  if (accelerator.includes('Return')) {
    candidates.push(accelerator.replace(/\bReturn\b/g, 'Enter'));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('-') + '_' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('-');
}

function sanitizeName(value) {
  return String(value || 'capture')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'capture';
}

function formatRecordingBaseName(meta) {
  const mode = sanitizeName(meta?.modeLabel || meta?.mode || 'recording');
  const source = sanitizeName(meta?.sourceName || 'source');
  return `${timestamp()}_${mode}_${source}`;
}

function normalizeRecordingFormat(format) {
  return ['mp4', 'webm'].includes(format) ? format : 'mp4';
}

function getDisplayPayload() {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const minX = Math.min(...displays.map((display) => display.bounds.x));
  const minY = Math.min(...displays.map((display) => display.bounds.y));
  const maxX = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const maxY = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    virtualBounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    },
    displays: displays.map((display, index) => ({
      id: String(display.id),
      index: index + 1,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryId
    }))
  };
}

function rectIntersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  };
}

function normalizeDesktopArea(rect) {
  if (!rect || rect.width < 8 || rect.height < 8) return null;

  const displays = getDisplayPayload().displays;
  let best = null;
  let bestArea = 0;

  for (const display of displays) {
    const clipped = rectIntersection(rect, display.bounds);
    const area = clipped.width * clipped.height;
    if (area > bestArea) {
      best = { display, clipped };
      bestArea = area;
    }
  }

  if (!best || best.clipped.width < 8 || best.clipped.height < 8) {
    return null;
  }

  const { display, clipped } = best;
  return {
    displayId: display.id,
    display,
    absolute: clipped,
    selection: {
      x: clampNumber((clipped.x - display.bounds.x) / display.bounds.width, 0, 1),
      y: clampNumber((clipped.y - display.bounds.y) / display.bounds.height, 0, 1),
      width: clampNumber(clipped.width / display.bounds.width, 0, 1),
      height: clampNumber(clipped.height / display.bounds.height, 0, 1)
    }
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function selectDesktopArea() {
  if (areaSelectionWindow) {
    areaSelectionWindow.focus();
    return Promise.resolve(null);
  }

  const displayPayload = getDisplayPayload();
  const targetDisplay = displayPayload.displays.find((display) => display.primary) || displayPayload.displays[0];
  const bounds = targetDisplay?.bounds || displayPayload.virtualBounds;
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
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });

    areaSelectionWindow = win;
    win.setAlwaysOnTop(true, 'screen-saver');

    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('area-selector:complete', complete);
      ipcMain.removeListener('area-selector:cancel', cancel);
      areaSelectionWindow = null;
      if (!win.isDestroyed()) {
        win.destroy();
      }
      resolve(value);
    };

    const complete = (event, rect) => {
      if (event.sender !== win.webContents) return;
      cleanup(normalizeDesktopArea(rect));
    };
    const cancel = (event) => {
      if (event.sender !== win.webContents) return;
      cleanup(null);
    };

    ipcMain.on('area-selector:complete', complete);
    ipcMain.on('area-selector:cancel', cancel);
    win.on('closed', () => cleanup(null));
    win.loadFile(path.join(__dirname, 'area-selector.html'), {
      query: {
        displayId: targetDisplay?.id || ''
      }
    });
    win.once('ready-to-show', () => {
      win.setBounds(bounds, false);
      if (displayPayload.displays.length === 1) {
        win.setFullScreen(true);
      }
      win.show();
      win.focus();
    });
  });
}

function parseWindowHandle(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId || ''));
  return match ? match[1] : null;
}

function execFileText(filePath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(filePath, args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '').trim() || '명령 실행에 실패했습니다.'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function getWindowClientCrop(sourceId) {
  const hwnd = parseWindowHandle(sourceId);
  if (!hwnd) return null;

  const script = `
param([Int64]$Hwnd)
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;

public static class Rp4WindowCrop
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    public static string Get(long hwndValue)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}

        IntPtr hWnd = new IntPtr(hwndValue);
        if (!IsWindow(hWnd)) throw new InvalidOperationException("창을 찾을 수 없습니다.");

        RECT frame;
        int result = DwmGetWindowAttribute(hWnd, 9, out frame, Marshal.SizeOf(typeof(RECT)));
        if (result != 0 && !GetWindowRect(hWnd, out frame)) {
            throw new InvalidOperationException("창 영역을 읽을 수 없습니다.");
        }

        RECT client;
        if (!GetClientRect(hWnd, out client)) throw new InvalidOperationException("클라이언트 영역을 읽을 수 없습니다.");

        POINT topLeft = new POINT { X = client.Left, Y = client.Top };
        POINT bottomRight = new POINT { X = client.Right, Y = client.Bottom };
        if (!ClientToScreen(hWnd, ref topLeft) || !ClientToScreen(hWnd, ref bottomRight)) {
            throw new InvalidOperationException("클라이언트 좌표를 변환할 수 없습니다.");
        }

        int frameWidth = Math.Max(1, frame.Right - frame.Left);
        int frameHeight = Math.Max(1, frame.Bottom - frame.Top);
        int x = Math.Max(0, topLeft.X - frame.Left);
        int y = Math.Max(0, topLeft.Y - frame.Top);
        int width = Math.Max(1, bottomRight.X - topLeft.X);
        int height = Math.Max(1, bottomRight.Y - topLeft.Y);

        if (x + width > frameWidth) width = Math.Max(1, frameWidth - x);
        if (y + height > frameHeight) height = Math.Max(1, frameHeight - y);

        return "{\\"x\\":" + x +
            ",\\"y\\":" + y +
            ",\\"width\\":" + width +
            ",\\"height\\":" + height +
            ",\\"frameWidth\\":" + frameWidth +
            ",\\"frameHeight\\":" + frameHeight +
            ",\\"screenX\\":" + topLeft.X +
            ",\\"screenY\\":" + topLeft.Y +
            ",\\"screenWidth\\":" + width +
            ",\\"screenHeight\\":" + height + "}";
    }
}
'@
Add-Type -TypeDefinition $code
[Rp4WindowCrop]::Get($Hwnd)
`;

  try {
    const stdout = await execFileText('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& {${script}
}`,
      hwnd
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const executablePath = resolveAsarUnpackedPath(ffmpegPath);
    if (!executablePath) {
      reject(new Error('FFmpeg 실행 파일을 찾을 수 없습니다.'));
      return;
    }

    const child = spawn(executablePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > 6000) {
        stderr = stderr.slice(-6000);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`MP4 변환에 실패했습니다. ${stderr.trim()}`));
    });
  });
}

function resolveAsarUnpackedPath(filePath) {
  if (!filePath) return null;
  return String(filePath).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function normalizeEncoderPreset(preset) {
  return ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(preset)
    ? preset
    : 'veryfast';
}

async function transcodeToMp4(inputPath, outputPath, options = {}) {
  const safeFps = Math.max(1, Math.min(240, Number(options.fps) || 60));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 10);
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));
  const encoderPreset = normalizeEncoderPreset(options.encoderPreset);
  await fs.rm(outputPath, { force: true });
  await runFfmpeg([
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    `fps=${safeFps},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    '-c:v',
    'libx264',
    '-preset',
    encoderPreset,
    '-b:v',
    `${bitrateMbps}M`,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-movflags',
    '+faststart',
    outputPath
  ]);
}

async function transcodeSegmentsToMp4(listPath, outputPath, options = {}) {
  const safeFps = Math.max(1, Math.min(240, Number(options.fps) || 60));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 10);
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));
  const encoderPreset = normalizeEncoderPreset(options.encoderPreset);
  const trimStartSec = Math.max(0, Number(options.trimStartMs) || 0) / 1000;
  const durationSec = Math.max(0, Number(options.durationMs) || 0) / 1000;
  const args = [
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath
  ];

  if (trimStartSec > 0) {
    args.push('-ss', trimStartSec.toFixed(3));
  }
  if (durationSec > 0) {
    args.push('-t', durationSec.toFixed(3));
  }

  args.push(
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    `setpts=PTS-STARTPTS,fps=${safeFps},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    '-c:v',
    'libx264',
    '-preset',
    encoderPreset,
    '-b:v',
    `${bitrateMbps}M`,
    '-pix_fmt',
    'yuv420p',
    '-af',
    'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-movflags',
    '+faststart',
    outputPath
  );

  await fs.rm(outputPath, { force: true });
  await runFfmpeg(args);
}

async function concatSegmentsToWebm(listPath, outputPath) {
  await fs.rm(outputPath, { force: true });
  await runFfmpeg([
    '-y',
    '-fflags',
    '+genpts',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    outputPath
  ]);
}

async function finalizeRecordingFile(session) {
  const format = normalizeRecordingFormat(session.meta.format);
  const targetPath = format === 'webm'
    ? session.filePath.replace(/\.[^.]+$/, '.webm')
    : session.filePath;

  await fs.rm(targetPath, { force: true });

  if (format === 'webm') {
    await fs.rename(session.tempPath, targetPath);
    return {
      filePath: targetPath,
      format: 'webm',
      fallback: false
    };
  }

  try {
    await transcodeToMp4(session.tempPath, targetPath, {
      bitrateMbps: session.meta.bitrateMbps,
      fps: session.meta.fps,
      encoderPreset: session.meta.encoderPreset,
      audioBitrateKbps: session.meta.audioBitrateKbps
    });
    await fs.rm(session.tempPath, { force: true });
    return {
      filePath: targetPath,
      format: 'mp4',
      fallback: false
    };
  } catch (error) {
    const fallbackPath = targetPath.replace(/\.mp4$/i, '_fallback.webm');
    await fs.rm(targetPath, { force: true });
    await fs.rm(fallbackPath, { force: true });
    await fs.rename(session.tempPath, fallbackPath);
    return {
      filePath: fallbackPath,
      format: 'webm',
      fallback: true,
      error: error.message
    };
  }
}

async function statFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function recordingDto(filePath, stats, meta = {}) {
  return {
    filePath,
    name: path.basename(filePath),
    size: stats?.size || 0,
    createdAt: (stats?.birthtime || stats?.mtime || new Date()).toISOString(),
    durationMs: meta.durationMs || 0,
    width: meta.width || null,
    height: meta.height || null,
    fps: meta.fps || null,
    bitrateMbps: meta.bitrateMbps || null,
    sourceName: meta.sourceName || null,
    modeLabel: meta.modeLabel || null
  };
}

function ffmpegConcatPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function concatListLines(segmentPaths, segmentDurations) {
  return segmentPaths.flatMap((segmentPath, index) => {
    const durationMs = Math.max(50, Number(segmentDurations[index]) || 0);
    return [
      `file '${ffmpegConcatPath(segmentPath)}'`,
      `duration ${(durationMs / 1000).toFixed(6)}`
    ];
  }).join('\n');
}

ipcMain.handle('sources:list', async () => {
  const displays = screen.getAllDisplays();
  const displayMap = new Map(displays.map((display, index) => [
    String(display.id),
    {
      index: index + 1,
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      primary: display.id === screen.getPrimaryDisplay().id
    }
  ]));

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 360, height: 210 },
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
      thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
    };
  });
});

ipcMain.handle('area-selector:data', async (_event, displayId) => {
  const payload = getDisplayPayload();
  const display = payload.displays.find((item) => item.id === String(displayId))
    || payload.displays.find((item) => item.primary)
    || payload.displays[0];
  return {
    ...payload,
    activeDisplay: display
  };
});

ipcMain.handle('area:select', async () => {
  if (IS_SMOKE) return null;
  return selectDesktopArea();
});

ipcMain.handle('window:client-crop', async (_event, sourceId) => getWindowClientCrop(sourceId));

ipcMain.handle('recordings:list', async () => {
  await ensureFolders();
  const recordingsDir = getRecordingsDir();
  const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.(webm|mp4|mkv)$/i.test(entry.name))
    .map((entry) => path.join(recordingsDir, entry.name));

  const recordings = await Promise.all(files.map(async (filePath) => {
    const stats = await statFile(filePath);
    return recordingDto(filePath, stats, recordingMetadata.get(filePath) || {});
  }));

  return recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle('recording:start', async (_event, meta = {}) => {
  await ensureFolders();
  const recordingsDir = getRecordingsDir();
  const tempRecordingsDir = getTempRecordingsDir();
  const baseName = formatRecordingBaseName(meta);
  const format = normalizeRecordingFormat(meta.format);
  const fileName = `${baseName}.${format}`;
  const filePath = path.join(recordingsDir, fileName);
  const tempPath = path.join(tempRecordingsDir, `${baseName}.webm`);
  const handle = await fs.open(tempPath, 'w');
  const sessionId = crypto.randomUUID();

  recordingSessions.set(sessionId, {
    handle,
    filePath,
    tempPath,
    meta: {
      ...meta,
      format,
      container: format,
      startedAt: new Date().toISOString()
    },
    bytes: 0,
    startedAtMs: Date.now()
  });

  return { sessionId, filePath, fileName };
});

ipcMain.handle('recording:write', async (_event, payload = {}) => {
  const session = recordingSessions.get(payload.sessionId);
  if (!session) {
    throw new Error('녹화 세션을 찾을 수 없습니다.');
  }

  const chunk = Buffer.from(payload.buffer);
  await session.handle.write(chunk);
  session.bytes += chunk.length;
  return { bytes: session.bytes };
});

ipcMain.handle('recording:stop', async (_event, payload = {}) => {
  const session = recordingSessions.get(payload.sessionId);
  if (!session) {
    return null;
  }

  await session.handle.close();
  recordingSessions.delete(payload.sessionId);

  if (session.bytes === 0) {
    await fs.rm(session.tempPath, { force: true });
    return null;
  }

  const durationMs = Math.max(0, Date.now() - session.startedAtMs);
  const finalized = await finalizeRecordingFile(session);

  const stats = await statFile(finalized.filePath);
  const meta = {
    ...session.meta,
    format: finalized.format,
    fallback: finalized.fallback,
    durationMs,
    stoppedAt: new Date().toISOString(),
    tempBytes: session.bytes,
    bytes: stats?.size || 0
  };
  recordingMetadata.set(finalized.filePath, meta);

  return recordingDto(finalized.filePath, stats, meta);
});

ipcMain.handle('clip:save', async (_event, payload = {}) => {
  await ensureFolders();
  const recordingsDir = getRecordingsDir();
  const tempRecordingsDir = getTempRecordingsDir();

  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  if (Array.isArray(payload.segments)) {
    const estimatedSegmentDurationMs = Math.max(50, Number(meta.durationMs) || 0) / Math.max(1, payload.segments.length);
    const segmentEntries = payload.segments
      .map((segment) => {
        const buffer = Buffer.from(segment?.buffer || []);
        const startedAt = Number(segment?.startedAt) || 0;
        const endedAt = Number(segment?.endedAt) || 0;
        const durationMs = endedAt > startedAt
          ? endedAt - startedAt
          : estimatedSegmentDurationMs;
        return { buffer, durationMs };
      })
      .filter((entry) => entry.buffer.length > 0);

    if (segmentEntries.length === 0) {
      throw new Error('저장할 클립 데이터가 없습니다.');
    }

    const format = normalizeRecordingFormat(meta.format);
    const baseName = `${formatRecordingBaseName({
      ...meta,
      modeLabel: meta.modeLabel || '클립'
    })}_${crypto.randomUUID().slice(0, 8)}`;
    const targetPath = path.join(recordingsDir, `${baseName}.${format}`);
    const segmentDir = path.join(tempRecordingsDir, `${baseName}_segments`);
    const listPath = path.join(segmentDir, 'segments.txt');
    const fallbackPath = path.join(recordingsDir, `${baseName}_fallback.webm`);
    await fs.rm(segmentDir, { recursive: true, force: true });
    await fs.mkdir(segmentDir, { recursive: true });

    try {
      const segmentPaths = [];
      const segmentDurations = [];
      for (const [index, entry] of segmentEntries.entries()) {
        const segmentPath = path.join(segmentDir, `${String(index).padStart(4, '0')}.webm`);
        await fs.writeFile(segmentPath, entry.buffer);
        segmentPaths.push(segmentPath);
        segmentDurations.push(entry.durationMs);
      }

      await fs.writeFile(listPath, concatListLines(segmentPaths, segmentDurations), 'utf8');

      const durationMs = Math.max(0, Number(meta.durationMs) || 0);
      let finalized = {
        filePath: targetPath,
        format,
        fallback: false
      };

      if (format === 'mp4') {
        try {
          await transcodeSegmentsToMp4(listPath, targetPath, {
            bitrateMbps: meta.bitrateMbps,
            fps: meta.fps,
            encoderPreset: meta.encoderPreset,
            audioBitrateKbps: meta.audioBitrateKbps,
            trimStartMs: payload.trimStartMs,
            durationMs
          });
        } catch (error) {
          await concatSegmentsToWebm(listPath, fallbackPath);
          finalized = {
            filePath: fallbackPath,
            format: 'webm',
            fallback: true,
            error: error.message
          };
        }
      } else {
        await concatSegmentsToWebm(listPath, targetPath);
      }

      const stats = await statFile(finalized.filePath);
      const dtoMeta = {
        ...meta,
        format: finalized.format,
        fallback: finalized.fallback,
        durationMs,
        stoppedAt: new Date().toISOString(),
        tempBytes: segmentEntries.reduce((sum, entry) => sum + entry.buffer.length, 0),
        bytes: stats?.size || 0
      };
      recordingMetadata.set(finalized.filePath, dtoMeta);
      return recordingDto(finalized.filePath, stats, dtoMeta);
    } finally {
      await fs.rm(segmentDir, { recursive: true, force: true });
    }
  }

  const buffer = Buffer.from(payload.buffer || []);
  if (buffer.length === 0) {
    throw new Error('저장할 클립 데이터가 없습니다.');
  }

  const format = normalizeRecordingFormat(meta.format);
  const baseName = `${formatRecordingBaseName({
    ...meta,
    modeLabel: meta.modeLabel || '클립'
  })}_${crypto.randomUUID().slice(0, 8)}`;
  const fileName = `${baseName}.${format}`;
  const filePath = path.join(recordingsDir, fileName);
  const tempPath = path.join(tempRecordingsDir, `${baseName}.webm`);
  await fs.writeFile(tempPath, buffer);

  const tempStats = await statFile(tempPath);
  const durationMs = Math.max(0, Number(meta.durationMs) || 0);
  const session = {
    filePath,
    tempPath,
    meta: {
      ...meta,
      format,
      container: format,
      clip: true,
      startedAt: new Date(Date.now() - durationMs).toISOString()
    },
    bytes: tempStats?.size || buffer.length,
    startedAtMs: Date.now() - durationMs
  };

  const finalized = await finalizeRecordingFile(session);
  const stats = await statFile(finalized.filePath);
  const dtoMeta = {
    ...session.meta,
    format: finalized.format,
    fallback: finalized.fallback,
    durationMs,
    stoppedAt: new Date().toISOString(),
    tempBytes: session.bytes,
    bytes: stats?.size || 0
  };
  recordingMetadata.set(finalized.filePath, dtoMeta);

  return recordingDto(finalized.filePath, stats, dtoMeta);
});

ipcMain.handle('screenshot:save', async (_event, payload = {}) => {
  await ensureFolders();
  const fileName = `${timestamp()}_screenshot.png`;
  const filePath = path.join(getScreenshotsDir(), fileName);
  await fs.writeFile(filePath, Buffer.from(payload.buffer));
  return { filePath, fileName };
});

ipcMain.handle('folder:open-recordings', async () => {
  await ensureFolders();
  const recordingsDir = getRecordingsDir();
  await shell.openPath(recordingsDir);
  return recordingsDir;
});

ipcMain.handle('folder:choose-recordings', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: '녹화 파일 저장 경로 선택',
    defaultPath: getRecordingsDir(),
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      canceled: true,
      recordingsDir: getRecordingsDir()
    };
  }

  appSettings = mergeSettings({
    ...appSettings,
    recordingsDir: result.filePaths[0]
  });
  await saveSettings();

  return {
    canceled: false,
    recordingsDir: getRecordingsDir()
  };
});

ipcMain.handle('file:show', async (_event, filePath) => {
  if (filePath) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('app:info', async () => ({
  appRoot: APP_ROOT,
  rp4Root: RP4_ROOT,
  settingsFile: SETTINGS_FILE,
  recordingsDir: getRecordingsDir(),
  version: app.getVersion(),
  isSmoke: IS_SMOKE
}));

function settingsDto() {
  return {
    selectedPreset: appSettings.selectedPreset,
    customPresets: appSettings.customPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      profile: { ...preset.profile }
    })),
    recordingsDir: getRecordingsDir(),
    defaultRecordingsDir: DEFAULT_RECORDINGS_DIR,
    settingsFile: SETTINGS_FILE
  };
}

ipcMain.handle('settings:get', async () => settingsDto());

ipcMain.handle('settings:selected-preset', async (_event, key) => {
  appSettings = mergeSettings({
    ...appSettings,
    selectedPreset: key
  });
  await saveSettings();
  return settingsDto();
});

ipcMain.handle('settings:custom-preset:save', async (_event, payload = {}) => {
  const id = typeof payload.id === 'string' && payload.id.trim()
    ? payload.id.trim()
    : crypto.randomUUID();
  const nextPreset = {
    id,
    name: sanitizePresetName(payload.name),
    profile: normalizePresetProfile(payload.profile)
  };
  const customPresets = [...appSettings.customPresets];
  const index = customPresets.findIndex((preset) => preset.id === id);

  if (index >= 0) {
    customPresets[index] = nextPreset;
  } else {
    customPresets.unshift(nextPreset);
  }

  appSettings = mergeSettings({
    ...appSettings,
    selectedPreset: `custom:${id}`,
    customPresets: customPresets.slice(0, MAX_CUSTOM_PRESETS)
  });
  await saveSettings();
  return settingsDto();
});

ipcMain.handle('settings:custom-preset:delete', async (_event, id) => {
  const targetId = String(id || '');
  const selectedPreset = appSettings.selectedPreset === `custom:${targetId}`
    ? DEFAULT_SELECTED_PRESET
    : appSettings.selectedPreset;

  appSettings = mergeSettings({
    ...appSettings,
    selectedPreset,
    customPresets: appSettings.customPresets.filter((preset) => preset.id !== targetId)
  });
  await saveSettings();
  return settingsDto();
});

ipcMain.handle('hotkeys:get', async () => ({
  hotkeys: { ...appSettings.hotkeys },
  defaults: { ...DEFAULT_HOTKEYS },
  registrations: { ...hotkeyRegistrations }
}));

ipcMain.handle('hotkeys:set', async (_event, hotkeys = {}) => {
  appSettings = mergeSettings({ ...appSettings, hotkeys });
  await saveSettings();
  registerHotkeys();
  return {
    hotkeys: { ...appSettings.hotkeys },
    defaults: { ...DEFAULT_HOTKEYS },
    registrations: { ...hotkeyRegistrations }
  };
});

ipcMain.handle('hotkeys:reset', async () => {
  appSettings = mergeSettings({ ...appSettings, hotkeys: DEFAULT_HOTKEYS });
  await saveSettings();
  registerHotkeys();
  return {
    hotkeys: { ...appSettings.hotkeys },
    defaults: { ...DEFAULT_HOTKEYS },
    registrations: { ...hotkeyRegistrations }
  };
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

app.whenReady().then(async () => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await loadSettings();
  await ensureFolders();
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture'].includes(permission));
  });
  createWindow();
  registerHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async () => {
  globalShortcut.unregisterAll();
  if (areaSelectionWindow && !areaSelectionWindow.isDestroyed()) {
    areaSelectionWindow.destroy();
  }
  await Promise.allSettled([...recordingSessions.values()].map(async (session) => {
    await session.handle.close();
  }));
  recordingSessions.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
