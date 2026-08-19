'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ffmpeg = require('./ffmpeg');
const paths = require('./paths');

const RECORDING_EXTENSIONS = /\.(webm|mp4|mkv|avi)$/i;
const INDEX_FILE_NAME = 'recordings-index.json';
const MAX_INDEX_ENTRIES = 2000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

// Refuse to start a recording without some headroom, and stop cleanly rather than
// letting writes fail halfway through once the disk is nearly full.
const MIN_FREE_BYTES_TO_START = 512 * 1024 * 1024;
const MIN_FREE_BYTES_TO_CONTINUE = 128 * 1024 * 1024;
const MIN_RECOVERABLE_RECORDING_BYTES = 512;
const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_QUEUED_BYTES = 128 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
const MIN_LOSSLESS_FREE_BYTES_TO_START = 2 * 1024 * 1024 * 1024;
const MAX_LOSSLESS_FRAME_BYTES = 64 * 1024 * 1024;
const VERIFICATION_CONCURRENCY = 1;
const VERIFICATION_SHUTDOWN_TIMEOUT_MS = 5000;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OPTIMIZING_FILE_PATTERN = new RegExp(
  `^(.*\\.mp4)\\.optimizing-(${UUID_PATTERN})\\.mp4$`,
  'i'
);
const BACKUP_FILE_PATTERN = new RegExp(
  `^(.*\\.(?:mp4|webm|mkv))\\.backup-${UUID_PATTERN}$`,
  'i'
);
const TEMP_RECORDING_PATTERN = new RegExp(
  `^rp4-(${UUID_PATTERN})\\.part\\.(mp4|webm|mkv)$`,
  'i'
);
const LOSSLESS_FINALIZING_PATTERN = new RegExp(
  `^rp4-(${UUID_PATTERN})\\.lossless-finalizing\\.avi$`,
  'i'
);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function recoveryOriginalName(fileName) {
  const optimizing = OPTIMIZING_FILE_PATTERN.exec(String(fileName || ''));
  if (optimizing) return optimizing[1];
  const backup = BACKUP_FILE_PATTERN.exec(String(fileName || ''));
  return backup?.[1] || null;
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

/**
 * Strips characters Windows rejects in file names, plus trailing dots and spaces which
 * Windows silently discards. Window titles reach this function, so it must be defensive.
 */
function sanitizeName(value, fallback = 'capture') {
  const cleaned = String(value || '')
    // Control characters are stripped deliberately: window titles reach this function and
    // Windows rejects them in file names.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');

  if (!cleaned) return fallback;

  // Reserved DOS device names cannot be used even with an extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

function containerFromMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('video/mp4')) return 'mp4';
  if (value.includes('x-matroska')) return 'mkv';
  return 'webm';
}

function videoCodecFromMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('avc1') || value.includes('h264')) return 'h264';
  if (value.includes('vp9')) return 'vp9';
  if (value.includes('vp8')) return 'vp8';
  if (value.includes('av01')) return 'av1';
  return 'unknown';
}

function audioCodecFromMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('mp4a') || value.includes('aac')) return 'aac';
  if (value.includes('opus')) return 'opus';
  if (value.includes('vorbis')) return 'vorbis';
  return 'unknown';
}

function boundedString(value, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : undefined;
}

function boundedNumber(value, min, max, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const bounded = Math.max(min, Math.min(max, number));
  return integer ? Math.round(bounded) : bounded;
}

/** Strict renderer-to-main metadata boundary: unknown and oversized fields are dropped. */
function normalizeRecordingMeta(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  const strings = {
    mode: 32,
    modeLabel: 96,
    sourceName: 160,
    format: 12,
    mimeType: 160,
    encoderPreset: 24
  };
  for (const [key, maxLength] of Object.entries(strings)) {
    const normalized = boundedString(source[key], maxLength);
    if (normalized !== undefined) output[key] = normalized;
  }
  const numbers = {
    width: [1, 16384, true],
    height: [1, 16384, true],
    fps: [1, 480, false],
    bitrateMbps: [0.1, 1000, false],
    audioBitrateKbps: [8, 1024, false],
    audioSampleRate: [8000, 192000, true],
    audioChannels: [1, 8, true],
    requestedFps: [1, 480, false],
    effectiveFps: [0, 480, false],
    capturedFrames: [0, 24 * 60 * 60 * 480, true],
    inputFrames: [0, 24 * 60 * 60 * 480, true],
    droppedFrames: [0, 24 * 60 * 60 * 480, true],
    firstFrameTimestampUs: [0, Number.MAX_SAFE_INTEGER, true],
    lastFrameTimestampUs: [0, Number.MAX_SAFE_INTEGER, true],
    durationMs: [0, 24 * 60 * 60 * 1000, true],
    trimRecentMs: [0, 24 * 60 * 60 * 1000, true],
    trimEndOffsetMs: [0, 24 * 60 * 60 * 1000, true]
  };
  for (const [key, [min, max, integer]] of Object.entries(numbers)) {
    const normalized = boundedNumber(source[key], min, max, { integer });
    if (normalized !== undefined) output[key] = normalized;
  }
  for (const key of [
    'clip',
    'segmentedClip',
    'lossless',
    'hardwareEncoding',
    'performanceDegraded',
    'audioPadded',
    'requestedSystemAudio',
    'hasSystemAudio',
    'requestedMic',
    'hasMic'
  ]) {
    if (typeof source[key] === 'boolean') output[key] = source[key];
  }
  return output;
}

async function statFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function freeBytes(target) {
  try {
    const stats = await fs.statfs(target);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

/**
 * Appends " (2)", " (3)" … until the name is free. The previous build derived names from
 * a one-second timestamp only, so two recordings started in the same second truncated
 * each other's files.
 */
async function uniquePath(dir, baseName, extension) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const candidate = path.join(dir, `${baseName}${suffix}.${extension}`);
    if (!(await paths.pathExists(candidate))) return candidate;
  }
  return path.join(dir, `${baseName}_${crypto.randomUUID().slice(0, 8)}.${extension}`);
}

/** Same-volume rename, with a copy fallback if the target is on another device. */
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

/** Opens only a direct regular-file child of an app-owned directory. */
async function openOwnedRegularFile(ownedDir, filePath, flags, { optional = false } = {}) {
  const item = await fs.lstat(filePath).catch((error) => {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!item) return null;
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error('임시 녹화 파일이 안전한 일반 파일이 아닙니다.');
  }

  const [realDir, realFile] = await Promise.all([
    fs.realpath(ownedDir),
    fs.realpath(filePath)
  ]);
  if (path.dirname(realFile).toLowerCase() !== realDir.toLowerCase()
    || path.basename(realFile).toLowerCase() !== path.basename(filePath).toLowerCase()) {
    throw new Error('임시 녹화 파일이 앱 소유 폴더를 벗어났습니다.');
  }

  const handle = await fs.open(realFile, flags);
  try {
    const stats = await handle.stat();
    const current = await fs.lstat(filePath);
    if (!stats.isFile() || !current.isFile() || current.isSymbolicLink()
      || (item.dev && current.dev && item.dev !== current.dev)
      || (item.ino && current.ino && item.ino !== current.ino)
      || (stats.dev && current.dev && stats.dev !== current.dev)
      || (stats.ino && current.ino && stats.ino !== current.ino)) {
      throw new Error('임시 녹화 파일이 검사 중 변경되었습니다.');
    }
    return { handle, stats, filePath: realFile };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Replaces a saved recording without ever deleting the only good copy first.
 * The backup path is included on failures so recovery remains possible even when a
 * second filesystem error prevents the rollback.
 */
async function replaceFileSafely(original, replacement, {
  move = moveFile,
  remove = (filePath) => fs.rm(filePath, { force: true }),
  validate = null
} = {}) {
  const backup = `${original}.backup-${crypto.randomUUID()}`;
  await move(original, backup);

  try {
    await move(replacement, original);
    if (validate) await validate(original);
  } catch (error) {
    try {
      await remove(original).catch(() => {});
      await move(backup, original);
    } catch (restoreError) {
      error.restoreError = restoreError;
      error.backupPath = backup;
    }
    throw error;
  }

  try {
    await remove(backup);
  } catch {
    // A stale backup costs disk space but is safer than failing a successful save.
  }
}

async function writeUniqueFile(dir, baseName, extension, buffer) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const candidate = path.join(dir, `${baseName}${suffix}.${extension}`);
    let handle;
    try {
      handle = await fs.open(candidate, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }

    try {
      await handle.writeFile(buffer);
      return candidate;
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(candidate, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return writeUniqueFile(dir, `${baseName}_${crypto.randomUUID().slice(0, 8)}`, extension, buffer);
}

function toBoundedBuffer(value, maxBytes) {
  const view = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? value : null;
  const bytes = Number(view?.byteLength || 0);
  if (!view || bytes === 0 || bytes > maxBytes) {
    throw new Error('허용되지 않은 바이너리 데이터입니다.');
  }
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

async function writeAtomicScreenshot(dir, format, buffer) {
  const id = crypto.randomUUID();
  const filePath = path.join(dir, `${timestamp()}_screenshot_${id.slice(0, 8)}.${format}`);
  const temporary = path.join(dir, `.rp4-screenshot-${id}.part`);
  let handle = null;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    return filePath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function pruneThumbnailCache(cacheDir, maxEntries = 256) {
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^rp4-thumb-[0-9a-f]{64}\.jpg$/i.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(cacheDir, entry.name);
      const stats = await statFile(filePath);
      return stats ? { filePath, usedAt: Math.max(stats.atimeMs, stats.mtimeMs) } : null;
    }));
  const stale = candidates.filter(Boolean)
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(maxEntries);
  await Promise.allSettled(stale.map((entry) => fs.rm(entry.filePath, { force: true })));
}

class RecordingManager {
  /**
   * @param {object} options
   * @param {import('./settings').SettingsStore} options.settings
   * @param {(channel: string, payload: unknown) => void} options.emit
   */
  constructor({ settings, emit, move = moveFile, maxSessionQueuedBytes = MAX_SESSION_QUEUED_BYTES }) {
    this.settings = settings;
    this.emit = emit || (() => {});
    this.sessions = new Map();
    this.losslessSessions = new Map();
    this.finalizing = new Map();
    this.metadata = new Map();
    this.optimizeQueue = [];
    this.optimizing = false;
    this.optimizingFilePath = null;
    this.optimizeDrainPromise = null;
    this.optimizationCancelled = false;
    this.indexChain = Promise.resolve();
    this.indexDirty = false;
    this.thumbnailQueue = Promise.resolve();
    this.thumbnailInflight = new Map();
    this.screenshotJobs = new Set();
    this.verificationQueue = [];
    this.verificationJobs = new Map();
    this.verificationRunning = new Map();
    this.verificationCancelled = false;
    this.startingWebContentsIds = new Set();
    this.moveFile = move;
    this.maxSessionQueuedBytes = Math.max(1, Number(maxSessionQueuedBytes) || MAX_SESSION_QUEUED_BYTES);
  }

  get activeCount() {
    return this.sessions.size + this.losslessSessions.size;
  }

  hasActiveSessions() {
    return this.sessions.size > 0 || this.losslessSessions.size > 0;
  }

  hasPendingRecordings() {
    return this.startingWebContentsIds.size > 0 || this.sessions.size > 0
      || this.losslessSessions.size > 0
      || this.finalizing.size > 0 || this.screenshotJobs.size > 0;
  }

  hasPendingFileMutations() {
    return this.hasPendingRecordings()
      || this.optimizing
      || this.optimizeQueue.length > 0
      || this.verificationJobs.size > 0;
  }

  indexFile() {
    return path.join(paths.configDir(), INDEX_FILE_NAME);
  }

  /**
   * Recording metadata used to live only in memory, so durations and resolutions
   * vanished on restart and every past file showed 00:00:00. It is now persisted to a
   * single index file rather than a sidecar per recording.
   */
  async loadIndex() {
    let text;
    let tooLarge;
    let handle = null;
    try {
      handle = await fs.open(this.indexFile(), 'r');
      const stats = await handle.stat();
      tooLarge = stats.size > MAX_INDEX_BYTES;
      if (!tooLarge) text = await handle.readFile('utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { recovered: false, backupPath: null };
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }

    try {
      if (tooLarge) throw new SyntaxError('녹화 인덱스 크기가 허용 범위를 초과했습니다.');
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
        throw new SyntaxError('녹화 인덱스 형식이 올바르지 않습니다.');
      }
      for (const entry of raw.entries.slice(-MAX_INDEX_ENTRIES)) {
        if (entry && typeof entry.filePath === 'string' && entry.filePath.length <= 32768
          && entry.meta && typeof entry.meta === 'object' && !Array.isArray(entry.meta)) {
          this.metadata.set(entry.filePath, entry.meta);
        }
      }
      return { recovered: false, backupPath: null };
    } catch {
      const source = this.indexFile();
      const backup = path.join(
        path.dirname(source),
        `recordings-index.corrupt-${timestamp().replace('_', '-')}.json`
      );
      try {
        await this.moveFile(source, backup);
        return { recovered: true, backupPath: backup };
      } catch {
        return { recovered: true, backupPath: null };
      }
    }
  }

  saveIndex() {
    const run = async () => {
      const entries = [...this.metadata.entries()]
        .slice(-MAX_INDEX_ENTRIES)
        .map(([filePath, meta]) => ({ filePath, meta }));
      const target = this.indexFile();
      const temporary = `${target}.tmp-${process.pid}`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries }), 'utf8');
      await fs.rename(temporary, target);
      this.indexDirty = false;
    };

    this.indexDirty = true;
    this.indexChain = this.indexChain.then(run, run);
    return this.indexChain;
  }

  async setMetadata(filePath, meta) {
    this.metadata.set(filePath, meta);
    try {
      await this.saveIndex();
    } catch (error) {
      this.indexDirty = true;
      this.emit('app:notice', {
        level: 'warn',
        message: `녹화 메타데이터를 저장하지 못했습니다. 종료 전에 다시 시도합니다. (${error?.message || error})`
      });
    }
  }

  async flushIndex() {
    await this.indexChain.catch(() => {});
    if (this.indexDirty) await this.saveIndex();
  }

  /**
   * Recovers app-owned leftovers from the marked temporary directory. A crash or a force-quit used to
   * strand partial files there forever, invisible to the user.
   */
  async sweepTempDir({ maxAgeMs = 0 } = {}) {
    let tempDir;
    try {
      tempDir = await paths.ensureOwnedTempDir(this.settings.recordingsDir);
    } catch (error) {
      return { removed: 0, recovered: [], failed: [{ filePath: this.settings.tempDir, error: error.message }] };
    }
    let entries;
    try {
      entries = await fs.readdir(tempDir, { withFileTypes: true });
    } catch {
      return { removed: 0, recovered: [], failed: [] };
    }

    const activeTempPaths = new Set([...this.sessions.values()].map((session) => session.tempPath));
    const recovered = [];
    const failed = [];
    let removed = 0;

    // A crash can leave FFmpeg's same-volume staging AVI behind. If its raw manifest
    // still exists, the lossless recovery pass below rebuilds it deterministically.
    // Without a manifest, expose the artifact only with an explicit verification state.
    for (const entry of entries) {
      const match = LOSSLESS_FINALIZING_PATTERN.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const fullPath = path.join(tempDir, entry.name);
      const manifestPath = path.join(tempDir, `rp4-${match[1]}.lossless.json`);
      if (await paths.pathExists(manifestPath)) continue;

      const stats = await statFile(fullPath);
      if (!stats || (maxAgeMs > 0 && Date.now() - stats.mtimeMs < maxAgeMs)) continue;
      let validationFailure = null;
      try {
        await ffmpeg.validateMedia(fullPath);
      } catch (error) {
        validationFailure = error?.message || String(error);
      }
      const partial = Boolean(validationFailure);
      const target = await uniquePath(
        this.settings.recordingsDir,
        `${timestamp()}_recovered_lossless${partial ? '_partial' : '_unverified'}_${match[1].slice(0, 8)}`,
        'avi'
      );
      try {
        await this.moveFile(fullPath, target);
        const recoveredStats = await statFile(target);
        await this.setMetadata(target, {
          status: partial ? 'partial' : 'unverified',
          partial,
          outcome: partial ? 'recovered-partial' : 'recovered-unverified',
          recovered: true,
          failureReason: partial
            ? `중단된 AVI를 완전히 검증하지 못했습니다. ${validationFailure}`.slice(0, 500)
            : '최종화 중단 파일을 복구했지만 원본 프레임 수와 길이는 확인할 수 없습니다.',
          recoveredAt: new Date().toISOString(),
          bytes: recoveredStats?.size || stats.size
        });
        recovered.push(target);
      } catch (error) {
        failed.push({ filePath: fullPath, error: error?.message || String(error) });
      }
    }

    for (const entry of entries) {
      const match = TEMP_RECORDING_PATTERN.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const fullPath = path.join(tempDir, entry.name);
      if (activeTempPaths.has(fullPath)) continue;

      const itemStats = await fs.lstat(fullPath).catch(() => null);
      if (!itemStats?.isFile() || itemStats.isSymbolicLink()) continue;

      const stats = await statFile(fullPath);
      if (!stats) continue;
      if (maxAgeMs > 0 && Date.now() - stats.mtimeMs < maxAgeMs) continue;

      // Anything with real content is salvaged into the recordings folder instead of
      // being deleted, so an interrupted take is never silently thrown away.
      if (stats.size > MIN_RECOVERABLE_RECORDING_BYTES) {
        const extension = match[2].toLowerCase();
        const repairPath = `${fullPath}.repair-${crypto.randomUUID()}.${extension}`;
        let recoveredSource = fullPath;
        let repaired = false;
        let validationFailure = null;
        try {
          await ffmpeg.validateMedia(fullPath);
        } catch (error) {
          validationFailure = error?.message || String(error);
          try {
            await ffmpeg.remux(fullPath, repairPath, {
              jobId: `recover:${match[1]}`
            });
            await ffmpeg.validateMedia(repairPath);
            recoveredSource = repairPath;
            repaired = true;
            validationFailure = null;
          } catch (repairError) {
            validationFailure = repairError?.message || validationFailure || String(repairError);
            await fs.rm(repairPath, { force: true }).catch(() => {});
          }
        }

        const partial = Boolean(validationFailure);
        const baseName = `${timestamp()}_recovered${partial ? '_partial' : ''}_${match[1].slice(0, 8)}`;
        const target = await uniquePath(this.settings.recordingsDir, baseName, extension);
        try {
          await this.moveFile(recoveredSource, target);
          if (recoveredSource !== fullPath) {
            await fs.rm(fullPath, { force: true }).catch(() => {});
          }
          const recoveredStats = await statFile(target);
          await this.setMetadata(target, {
            status: partial ? 'partial' : 'complete',
            partial,
            outcome: partial ? 'recovered-partial' : 'recovered',
            recovered: true,
            repaired,
            failureReason: partial
              ? `비정상 종료 파일을 완전히 검증하거나 복구하지 못했습니다. ${validationFailure}`.slice(0, 500)
              : null,
            recoveredAt: new Date().toISOString(),
            bytes: recoveredStats?.size || stats.size
          });
          recovered.push(target);
          continue;
        } catch (error) {
          await fs.rm(repairPath, { force: true }).catch(() => {});
          failed.push({ filePath: fullPath, error: error?.message || String(error) });
          continue;
        }
      }

      await fs.rm(fullPath, { force: true });
      removed += 1;
    }

    const activeLosslessManifests = new Set(
      [...this.losslessSessions.values()].map((session) => session.manifestPath)
    );
    for (const entry of entries) {
      const match = /^rp4-([0-9a-f-]{36})\.lossless\.json$/i.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const manifestPath = path.join(tempDir, entry.name);
      if (activeLosslessManifests.has(manifestPath)) continue;
      const rawPath = path.join(tempDir, `rp4-${match[1]}.lossless.raw`);
      const audioPath = path.join(tempDir, `rp4-${match[1]}.lossless.pcm`);
      try {
        const manifestFile = await openOwnedRegularFile(tempDir, manifestPath, 'r');
        let manifestText;
        try {
          if (manifestFile.stats.size > 64 * 1024) {
            throw new Error('무압축 복구 정보 크기가 올바르지 않습니다.');
          }
          manifestText = await manifestFile.handle.readFile('utf8');
        } finally {
          await manifestFile.handle.close().catch(() => {});
        }
        const manifest = JSON.parse(manifestText);
        const width = boundedNumber(manifest.width, 2, 7680, { integer: true });
        const height = boundedNumber(manifest.height, 2, 4320, { integer: true });
        const fps = boundedNumber(manifest.fps, 1, 240) || 60;
        const audioSampleRate = boundedNumber(manifest.audioSampleRate, 8000, 192000, {
          integer: true
        }) || 48000;
        const audioChannels = boundedNumber(manifest.audioChannels, 1, 8, { integer: true }) || 2;
        const frameBytes = Number(width) * Number(height) * 4;
        const { frameCount, audioBytes } = await (async () => {
          let rawFile = null;
          let audioFile = null;
          try {
            rawFile = await openOwnedRegularFile(tempDir, rawPath, 'r+');
            audioFile = await openOwnedRegularFile(tempDir, audioPath, 'r', { optional: true });
            const completeFrames = Math.floor(Number(rawFile.stats.size || 0) / frameBytes);
            if (!width || !height || width % 2 || height % 2
              || frameBytes <= 0 || frameBytes > MAX_LOSSLESS_FRAME_BYTES
              || completeFrames < 1) {
              throw new Error('복구할 수 있는 완전한 무압축 프레임이 없습니다.');
            }
            // Truncate the already-validated descriptor, not a path that could be swapped.
            await rawFile.handle.truncate(completeFrames * frameBytes);
            return { frameCount: completeFrames, audioBytes: audioFile?.stats.size || 0 };
          } finally {
            await rawFile?.handle.close().catch(() => {});
            await audioFile?.handle.close().catch(() => {});
          }
        })();
        const recoverySession = {
          sessionId: match[1],
          recordingsDir: this.settings.recordingsDir,
          baseName: `${timestamp()}_recovered_lossless_${match[1].slice(0, 8)}`,
          rawPath,
          audioPath,
          manifestPath,
          finalizingPath: path.join(tempDir, `rp4-${match[1]}.lossless-finalizing.avi`),
          width,
          height,
          fps,
          audioSampleRate,
          audioChannels,
          frameBytes,
          frameCount,
          firstFrameTimestampUs: null,
          lastFrameTimestampUs: null,
          rawBytes: frameCount * frameBytes,
          audioBytes,
          rawWriteChain: Promise.resolve(),
          audioWriteChain: Promise.resolve(),
          handlesClosed: true,
          startedAtMs: Date.now() - frameCount / fps * 1000,
          failed: null,
          meta: {
            ...normalizeRecordingMeta(manifest.meta),
            modeLabel: '복구된 무압축 녹화',
            format: 'avi',
            recordedCodec: 'rawvideo',
            lossless: true,
            recovered: true
          }
        };
        const saved = await this.finishLosslessSession(recoverySession, {
          durationMs: Math.round(frameCount / fps * 1000),
          failureReason: '비정상 종료 후 완전한 원본 프레임을 무압축 AVI로 복구했습니다.'
        });
        if (saved?.filePath) recovered.push(saved.filePath);
      } catch (error) {
        failed.push({ filePath: rawPath, error: error?.message || String(error) });
      }
    }

    return { removed, recovered, failed };
  }

  async start(meta = {}, { webContentsId } = {}) {
    const senderBusy = this.startingWebContentsIds.has(webContentsId)
      || [...this.sessions.values()].some((session) => session.webContentsId === webContentsId)
      || [...this.losslessSessions.values()].some((session) => session.webContentsId === webContentsId)
      || [...this.finalizing.values()].some((entry) => entry.webContentsId === webContentsId);
    if (webContentsId != null && senderBusy) {
      throw new Error('이 창에는 이미 활성 녹화 세션이 있습니다.');
    }
    if (webContentsId != null) this.startingWebContentsIds.add(webContentsId);
    try {
      return await this.startReserved(meta, { webContentsId });
    } finally {
      if (webContentsId != null) this.startingWebContentsIds.delete(webContentsId);
    }
  }

  async startReserved(meta = {}, { webContentsId } = {}) {
    await paths.ensureRecordingDirs(this.settings.recordingsDir);

    const recordingsDir = this.settings.recordingsDir;
    const available = await freeBytes(recordingsDir);
    if (available == null) {
      this.emit('app:notice', {
        level: 'warn',
        message: '저장 장치의 여유 공간을 확인할 수 없습니다. 녹화를 계속하지만 디스크 공간을 확인해 주세요.'
      });
    } else if (available < MIN_FREE_BYTES_TO_START) {
      throw new Error('저장 공간이 부족합니다. 최소 512MB 이상의 여유 공간이 필요합니다.');
    }

    const safeMeta = normalizeRecordingMeta(meta);
    const targetFormat = safeMeta.format === 'webm' ? 'webm' : 'mp4';
    const recordedContainer = containerFromMimeType(safeMeta.mimeType);
    const recordedCodec = videoCodecFromMimeType(safeMeta.mimeType);
    const recordedAudioCodec = audioCodecFromMimeType(safeMeta.mimeType);
    const sessionId = crypto.randomUUID();
    const baseName = [
      timestamp(),
      sanitizeName(safeMeta.modeLabel || safeMeta.mode, 'recording'),
      sanitizeName(safeMeta.sourceName, 'source'),
      sessionId.slice(0, 8)
    ].join('_');

    const tempDir = await paths.ensureOwnedTempDir(recordingsDir);
    const tempPath = path.join(tempDir, `rp4-${sessionId}.part.${recordedContainer}`);
    const handle = await fs.open(tempPath, 'wx');

    this.sessions.set(sessionId, {
      handle,
      webContentsId,
      recordingsDir,
      baseName,
      tempPath,
      targetFormat,
      recordedContainer,
      recordedCodec,
      recordedAudioCodec,
      forceRemux: safeMeta.clip === true,
      segmentedClip: safeMeta.clip === true && safeMeta.segmentedClip === true,
      segmentPaths: [tempPath],
      currentSegmentIndex: 0,
      highestQueuedSegmentIndex: 0,
      handleClosed: false,
      bytes: 0,
      queuedBytes: 0,
      writeChain: Promise.resolve(),
      acceptingWrites: true,
      startedAtMs: Date.now(),
      failed: null,
      diskCheckUnavailableWarned: available == null,
      meta: {
        ...safeMeta,
        targetFormat,
        recordedContainer,
        recordedCodec,
        recordedAudioCodec,
        startedAt: new Date().toISOString()
      }
    });

    return {
      sessionId,
      maxQueuedBytes: this.maxSessionQueuedBytes,
      // The recording streams straight into its final container when the codec already
      // matches the target, which is what makes stopping instant.
      directToTarget: recordedContainer === targetFormat,
      recordedContainer,
      recordedCodec,
      recordedAudioCodec
    };
  }

  async startLossless(meta = {}, { webContentsId } = {}) {
    const senderBusy = this.startingWebContentsIds.has(webContentsId)
      || [...this.sessions.values()].some((session) => session.webContentsId === webContentsId)
      || [...this.losslessSessions.values()].some((session) => session.webContentsId === webContentsId)
      || [...this.finalizing.values()].some((entry) => entry.webContentsId === webContentsId);
    if (webContentsId != null && senderBusy) {
      throw new Error('이 창에는 이미 활성 녹화 세션이 있습니다.');
    }
    if (webContentsId != null) this.startingWebContentsIds.add(webContentsId);
    try {
      return await this.startLosslessReserved(meta, { webContentsId });
    } finally {
      if (webContentsId != null) this.startingWebContentsIds.delete(webContentsId);
    }
  }

  async startLosslessReserved(meta = {}, { webContentsId } = {}) {
    await paths.ensureRecordingDirs(this.settings.recordingsDir);
    const recordingsDir = this.settings.recordingsDir;
    const available = await freeBytes(recordingsDir);
    if (available != null && available < MIN_LOSSLESS_FREE_BYTES_TO_START) {
      throw codedError(
        'INSUFFICIENT_SPACE',
        '무압축 녹화에는 최소 2GB 이상의 여유 공간이 필요합니다.'
      );
    }

    const safeMeta = normalizeRecordingMeta({ ...meta, format: 'avi', lossless: true });
    const width = boundedNumber(safeMeta.width, 2, 7680, { integer: true });
    const height = boundedNumber(safeMeta.height, 2, 4320, { integer: true });
    const fps = boundedNumber(safeMeta.fps, 1, 240) || 60;
    const audioSampleRate = boundedNumber(safeMeta.audioSampleRate, 8000, 192000, {
      integer: true
    }) || 48000;
    const audioChannels = boundedNumber(safeMeta.audioChannels, 1, 8, { integer: true }) || 2;
    const frameBytes = Number(width) * Number(height) * 4;
    if (!width || !height || width % 2 || height % 2
      || frameBytes <= 0 || frameBytes > MAX_LOSSLESS_FRAME_BYTES) {
      throw codedError(
        'FRAME_TOO_LARGE',
        '원본 프레임이 64MiB 안전 한도를 초과해 무압축 녹화를 시작할 수 없습니다.'
      );
    }

    const sessionId = crypto.randomUUID();
    const baseName = [
      timestamp(),
      sanitizeName(safeMeta.modeLabel || safeMeta.mode, 'lossless'),
      sanitizeName(safeMeta.sourceName, 'source'),
      sessionId.slice(0, 8)
    ].join('_');
    const tempDir = await paths.ensureOwnedTempDir(recordingsDir);
    const rawPath = path.join(tempDir, `rp4-${sessionId}.lossless.raw`);
    const audioPath = path.join(tempDir, `rp4-${sessionId}.lossless.pcm`);
    const manifestPath = path.join(tempDir, `rp4-${sessionId}.lossless.json`);
    const finalizingPath = path.join(tempDir, `rp4-${sessionId}.lossless-finalizing.avi`);
    let rawHandle = null;
    let audioHandle = null;
    try {
      rawHandle = await fs.open(rawPath, 'wx');
      audioHandle = await fs.open(audioPath, 'wx');
      await fs.writeFile(manifestPath, JSON.stringify({
        version: 1,
        sessionId,
        baseName,
        width,
        height,
        fps,
        audioSampleRate,
        audioChannels,
        startedAt: new Date().toISOString(),
        meta: safeMeta
      }), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      await rawHandle?.close().catch(() => {});
      await audioHandle?.close().catch(() => {});
      await Promise.allSettled([
        fs.rm(rawPath, { force: true }),
        fs.rm(audioPath, { force: true }),
        fs.rm(manifestPath, { force: true })
      ]);
      throw error;
    }

    this.losslessSessions.set(sessionId, {
      sessionId,
      webContentsId,
      recordingsDir,
      baseName,
      rawPath,
      audioPath,
      manifestPath,
      finalizingPath,
      rawHandle,
      audioHandle,
      width,
      height,
      fps,
      audioSampleRate,
      audioChannels,
      frameBytes,
      frameCount: 0,
      firstFrameTimestampUs: null,
      lastFrameTimestampUs: null,
      rawBytes: 0,
      audioBytes: 0,
      queuedBytes: 0,
      rawWriteChain: Promise.resolve(),
      audioWriteChain: Promise.resolve(),
      acceptingWrites: true,
      handlesClosed: false,
      startedAtMs: Date.now(),
      failed: null,
      lastSpaceCheckBytes: 0,
      diskCheckUnavailableWarned: available == null,
      meta: {
        ...safeMeta,
        format: 'avi',
        recordedContainer: 'avi',
        recordedCodec: 'rawvideo',
        lossless: true,
        startedAt: new Date().toISOString()
      }
    });

    return {
      sessionId,
      format: 'avi',
      recordedCodec: 'rawvideo',
      frameBytes,
      maxFrameBytes: MAX_LOSSLESS_FRAME_BYTES,
      maxInFlightFrames: 3
    };
  }

  getOwnedLosslessSession(sessionId, webContentsId) {
    const session = this.losslessSessions.get(sessionId);
    if (!session) throw new Error('무압축 녹화 세션을 찾을 수 없습니다.');
    if (session.webContentsId != null && webContentsId != null
      && session.webContentsId !== webContentsId) {
      throw new Error('무압축 녹화 세션에 접근할 수 없습니다.');
    }
    if (!session.acceptingWrites) throw new Error('무압축 녹화 세션이 이미 종료 중입니다.');
    return session;
  }

  writeLosslessFrame(payload = {}, { webContentsId } = {}) {
    let session;
    let frame;
    try {
      session = this.getOwnedLosslessSession(payload.sessionId, webContentsId);
      frame = toBoundedBuffer(payload.buffer, MAX_LOSSLESS_FRAME_BYTES);
      if (frame.length !== session.frameBytes) {
        throw new Error('무압축 프레임 크기가 녹화 해상도와 일치하지 않습니다.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const timestampUs = Number(payload.timestampUs);
    return this.enqueueLosslessWrite(session, frame, {
      audio: false,
      timestampUs: Number.isFinite(timestampUs) && timestampUs >= 0 ? Math.round(timestampUs) : null
    });
  }

  writeLosslessAudio(payload = {}, { webContentsId } = {}) {
    let session;
    let chunk;
    try {
      session = this.getOwnedLosslessSession(payload.sessionId, webContentsId);
      chunk = toBoundedBuffer(payload.buffer, MAX_IPC_CHUNK_BYTES);
      if (chunk.length % (session.audioChannels * 2) !== 0) {
        throw new Error('무압축 PCM 오디오 블록 크기가 채널 구성과 일치하지 않습니다.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueLosslessWrite(session, chunk, { audio: true });
  }

  enqueueLosslessWrite(session, chunk, { audio, timestampUs = null }) {
    if (session.queuedBytes + chunk.length > this.maxSessionQueuedBytes) {
      session.failed = '무압축 녹화 쓰기 대기열이 허용 한도를 초과했습니다.';
      return Promise.reject(new Error(session.failed));
    }
    session.queuedBytes += chunk.length;
    const chainName = audio ? 'audioWriteChain' : 'rawWriteChain';
    const handle = audio ? session.audioHandle : session.rawHandle;
    const task = async () => {
      if (session.failed) throw new Error(session.failed);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
          throw new Error('무압축 녹화 파일 쓰기가 진행되지 않았습니다.');
        }
        offset += bytesWritten;
      }
      if (audio) session.audioBytes += chunk.length;
      else {
        session.rawBytes += chunk.length;
        session.frameCount += 1;
        if (timestampUs != null) {
          if (session.firstFrameTimestampUs == null) session.firstFrameTimestampUs = timestampUs;
          session.lastFrameTimestampUs = timestampUs;
        }
      }

      const totalBytes = session.rawBytes + session.audioBytes;
      if (totalBytes - session.lastSpaceCheckBytes >= 256 * 1024 * 1024) {
        session.lastSpaceCheckBytes = totalBytes;
        const available = await freeBytes(session.recordingsDir);
        if (available == null && !session.diskCheckUnavailableWarned) {
          session.diskCheckUnavailableWarned = true;
          this.emit('app:notice', {
            level: 'warn',
            message: '무압축 녹화 중 저장 장치 여유 공간을 확인할 수 없습니다.'
          });
        } else if (available != null && available < Math.max(
          MIN_FREE_BYTES_TO_CONTINUE,
          session.rawBytes * 0.8 + MIN_FREE_BYTES_TO_START
        )) {
          session.failed = '저장 공간이 거의 없어 무압축 녹화를 중지해야 합니다.';
          this.emit('recording:disk-full', { sessionId: session.sessionId });
        }
      }
      return {
        frames: session.frameCount,
        bytes: session.rawBytes + session.audioBytes,
        warning: session.failed
      };
    };
    const result = session[chainName].then(task).catch((error) => {
      session.failed = error?.message || String(error);
      throw error;
    }).finally(() => {
      session.queuedBytes = Math.max(0, session.queuedBytes - chunk.length);
    });
    session[chainName] = result.catch(() => {});
    return result;
  }

  stopLossless(payload = {}, { webContentsId } = {}) {
    const existing = this.finalizing.get(payload.sessionId);
    if (existing) {
      if (existing.webContentsId != null && webContentsId != null
        && existing.webContentsId !== webContentsId) {
        return Promise.reject(new Error('무압축 녹화 세션에 접근할 수 없습니다.'));
      }
      return existing.promise;
    }
    const session = this.losslessSessions.get(payload.sessionId);
    if (!session) return Promise.resolve(null);
    if (session.webContentsId != null && webContentsId != null
      && session.webContentsId !== webContentsId) {
      return Promise.reject(new Error('무압축 녹화 세션에 접근할 수 없습니다.'));
    }
    session.acceptingWrites = false;
    this.losslessSessions.delete(payload.sessionId);
    const promise = this.finishLosslessSession(session, payload)
      .finally(() => this.finalizing.delete(payload.sessionId));
    this.finalizing.set(payload.sessionId, { promise, webContentsId: session.webContentsId });
    return promise;
  }

  async closeLosslessHandles(session) {
    if (!session || session.handlesClosed) return;
    session.handlesClosed = true;
    const results = await Promise.allSettled([
      session.rawHandle?.close(),
      session.audioHandle?.close()
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) session.failed = rejected.reason?.message || String(rejected.reason);
  }

  async finishLosslessSession(session, payload = {}) {
    await Promise.allSettled([session.rawWriteChain, session.audioWriteChain]);
    await this.closeLosslessHandles(session);
    if (!session.frameCount || !session.rawBytes) {
      await Promise.allSettled([
        fs.rm(session.rawPath, { force: true }),
        fs.rm(session.audioPath, { force: true }),
        fs.rm(session.manifestPath, { force: true })
      ]);
      return null;
    }

    const durationMs = Number(payload.durationMs) > 0
      ? Math.round(Number(payload.durationMs))
      : Math.max(1, Date.now() - session.startedAtMs);
    const payloadMeta = normalizeRecordingMeta(payload.meta);
    const effectiveFps = Math.max(0.1, Math.min(240, session.frameCount * 1000 / durationMs));
    const droppedFrames = Math.max(0, Number(payloadMeta.droppedFrames) || 0);
    const inputFrames = Math.max(
      session.frameCount + droppedFrames,
      Number(payloadMeta.inputFrames) || 0
    );
    const performanceDegraded = droppedFrames > 0
      || (durationMs >= 3000 && effectiveFps < session.fps * 0.85);
    const performanceWarning = !performanceDegraded
      ? null
      : droppedFrames > 0
        ? `저장 장치 처리 속도로 인해 ${droppedFrames}개 프레임이 누락되었고 실제 FPS는 ${effectiveFps.toFixed(1)}입니다.`
        : `저장 장치 처리 속도로 인해 실제 FPS가 ${effectiveFps.toFixed(1)}로 낮아졌습니다.`;
    const explicitFailure = session.failed || (
      typeof payload.failureReason === 'string' && payload.failureReason.trim()
        ? payload.failureReason.trim().slice(0, 500)
        : null
    );
    const failureReason = explicitFailure || performanceWarning;
    const outputBase = failureReason ? `${session.baseName}_partial` : session.baseName;
    const target = await uniquePath(session.recordingsDir, outputBase, 'avi');
    const finalizingPath = session.finalizingPath || path.join(
      await paths.ensureOwnedTempDir(session.recordingsDir),
      `rp4-${session.sessionId}.lossless-finalizing.avi`
    );
    const audioStats = await statFile(session.audioPath);
    const hasAudio = Boolean(audioStats?.size);
    const expectedAudioBytes = durationMs / 1000
      * session.audioSampleRate * session.audioChannels * 2;
    const audioPadded = hasAudio && audioStats.size < expectedAudioBytes * 0.98;
    const args = [
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'bgra',
      '-video_size', `${session.width}x${session.height}`,
      '-framerate', effectiveFps.toFixed(6),
      '-i', session.rawPath
    ];
    if (hasAudio) {
      args.push(
        '-f', 's16le',
        '-ar', String(session.audioSampleRate),
        '-ac', String(session.audioChannels),
        '-i', session.audioPath
      );
    }
    args.push(
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '1:a:0?'] : []),
      '-c:v', 'rawvideo',
      '-pix_fmt', 'bgr24',
      ...(hasAudio ? ['-af', 'apad', '-c:a', 'pcm_s16le', '-shortest'] : []),
      finalizingPath
    );

    await fs.rm(finalizingPath, { force: true }).catch(() => {});
    let validated = false;
    try {
      await ffmpeg.run(args, {
        jobId: `lossless:${session.sessionId}`,
        totalDurationMs: durationMs,
        onProgress: (ratio) => this.emit('recording:convert-progress', {
          phase: 'lossless-finalize',
          ratio
        })
      });
      await ffmpeg.validateMedia(finalizingPath, {
        expectedDurationMs: durationMs,
        expectedFrames: session.frameCount,
        requireAudio: hasAudio
      });
      validated = true;
      // The staging directory is a child of recordingsDir, so this rename is a
      // same-volume atomic commit. The final name never contains a partial AVI.
      await fs.rename(finalizingPath, target);
    } catch (error) {
      if (!validated) await fs.rm(finalizingPath, { force: true }).catch(() => {});
      throw new Error(
        `무압축 AVI를 마무리하지 못했습니다. 원본 프레임은 ${session.rawPath}에 보존했습니다. ${error?.message || error}`,
        { cause: error }
      );
    }

    // Remove the recovery trigger first. If the app dies after the atomic rename,
    // a valid but metadata-less AVI is shown as unverified instead of being duplicated.
    await fs.rm(session.manifestPath, { force: true }).catch(() => {});
    await Promise.allSettled([
      fs.rm(session.rawPath, { force: true }),
      fs.rm(session.audioPath, { force: true })
    ]);
    const stats = await statFile(target);
    const meta = {
      ...session.meta,
      ...payloadMeta,
      format: 'avi',
      recordedContainer: 'avi',
      recordedCodec: 'rawvideo',
      recordedAudioCodec: hasAudio ? 'pcm_s16le' : 'none',
      lossless: true,
      hardwareEncoding: false,
      requestedFps: session.fps,
      fps: effectiveFps,
      status: failureReason ? 'partial' : 'complete',
      partial: Boolean(failureReason),
      failureReason,
      outcome: failureReason ? 'partial' : 'exact',
      durationMs,
      capturedFrames: session.frameCount,
      inputFrames,
      droppedFrames,
      effectiveFps,
      firstFrameTimestampUs: session.firstFrameTimestampUs,
      lastFrameTimestampUs: session.lastFrameTimestampUs,
      performanceDegraded,
      performanceWarning,
      audioPadded,
      stoppedAt: new Date().toISOString(),
      bytes: stats?.size || 0
    };
    await this.setMetadata(target, meta);
    if (performanceWarning) {
      this.emit('app:notice', { level: 'warn', message: performanceWarning });
    }
    return {
      ...this.toDto(target, stats, meta),
      status: meta.status,
      failureReason,
      outcome: meta.outcome,
      converted: false,
      conversionError: null
    };
  }

  write(payload = {}, { webContentsId } = {}) {
    const session = this.sessions.get(payload.sessionId);
    if (!session) {
      return Promise.reject(new Error('녹화 세션을 찾을 수 없습니다.'));
    }
    // Only the renderer that opened the session may write to it.
    if (session.webContentsId != null && webContentsId != null && session.webContentsId !== webContentsId) {
      return Promise.reject(new Error('녹화 세션에 접근할 수 없습니다.'));
    }
    if (!session.acceptingWrites) {
      return Promise.reject(new Error('녹화 세션이 이미 종료 중입니다.'));
    }

    let chunk;
    try {
      chunk = toBoundedBuffer(payload.buffer, MAX_IPC_CHUNK_BYTES);
    } catch (error) {
      return Promise.reject(error);
    }

    const terminal = payload.terminal === true;
    let segmentIndex = 0;
    if (session.segmentedClip) {
      segmentIndex = Number(payload.segmentIndex);
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 1024) {
        return Promise.reject(new Error('클립 세그먼트 번호가 올바르지 않습니다.'));
      }
      if (segmentIndex < session.highestQueuedSegmentIndex
        || segmentIndex > session.highestQueuedSegmentIndex + 1) {
        return Promise.reject(new Error('클립 세그먼트 순서가 올바르지 않습니다.'));
      }
      session.highestQueuedSegmentIndex = Math.max(session.highestQueuedSegmentIndex, segmentIndex);
    }
    if (session.queuedBytes + chunk.length > this.maxSessionQueuedBytes) {
      session.failed = '녹화 쓰기 대기열이 허용 한도를 초과했습니다.';
      return Promise.reject(new Error(session.failed));
    }
    session.queuedBytes += chunk.length;
    const writeTask = async () => {
      if (session.failed && !terminal) throw new Error(session.failed);

      try {
        if (session.segmentedClip && segmentIndex !== session.currentSegmentIndex) {
          await this.closeSessionHandle(session);
          const segmentPath = path.join(
            path.dirname(session.tempPath),
            `rp4-${crypto.randomUUID()}.part.${session.recordedContainer}`
          );
          session.handle = await fs.open(segmentPath, 'wx');
          session.handleClosed = false;
          session.currentSegmentIndex = segmentIndex;
          session.segmentPaths.push(segmentPath);
        }
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await session.handle.write(
            chunk,
            offset,
            chunk.length - offset
          );
          if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
            throw new Error('파일 쓰기가 진행되지 않았습니다.');
          }
          offset += bytesWritten;
          session.bytes += bytesWritten;
        }
      } catch (error) {
        // Surface the failure instead of continuing to produce a corrupt file.
        session.failed = `녹화 데이터를 디스크에 쓸 수 없습니다. ${error.message}`;
        throw new Error(session.failed, { cause: error });
      }

      // Periodically re-check headroom so we can stop deliberately near a full disk.
      if (session.bytes - (session.lastSpaceCheckBytes || 0) > 64 * 1024 * 1024) {
        session.lastSpaceCheckBytes = session.bytes;
        const available = await freeBytes(session.recordingsDir);
        if (available == null && !session.diskCheckUnavailableWarned) {
          session.diskCheckUnavailableWarned = true;
          this.emit('app:notice', {
            level: 'warn',
            message: '녹화 중 저장 장치의 여유 공간을 확인할 수 없습니다. 디스크 공간을 확인해 주세요.'
          });
        } else if (available != null && available < MIN_FREE_BYTES_TO_CONTINUE) {
          session.failed = '저장 공간이 거의 없어 녹화를 중지해야 합니다.';
          this.emit('recording:disk-full', { sessionId: payload.sessionId });
        }
      }

      return { bytes: session.bytes, warning: session.failed || null };
    };

    const result = session.writeChain.then(writeTask)
      .finally(() => {
        session.queuedBytes = Math.max(0, session.queuedBytes - chunk.length);
      });
    session.writeChain = result.catch(() => {});
    return result;
  }

  /**
   * Closes the file and moves it into place. When the recorded container already matches
   * the requested format this is a rename and returns immediately; conversion only
   * happens for genuinely mismatched codecs.
   */
  stop(payload = {}, { webContentsId } = {}) {
    const existing = this.finalizing.get(payload.sessionId);
    if (existing) {
      if (existing.webContentsId != null && webContentsId != null
        && existing.webContentsId !== webContentsId) {
        return Promise.reject(new Error('녹화 세션에 접근할 수 없습니다.'));
      }
      return existing.promise;
    }

    const session = this.sessions.get(payload.sessionId);
    if (!session) return Promise.resolve(null);
    if (session.webContentsId != null && webContentsId != null
      && session.webContentsId !== webContentsId) {
      return Promise.reject(new Error('녹화 세션에 접근할 수 없습니다.'));
    }

    session.acceptingWrites = false;
    this.sessions.delete(payload.sessionId);
    const promise = this.finishSession(session, payload)
      .finally(() => this.finalizing.delete(payload.sessionId));
    this.finalizing.set(payload.sessionId, { promise, webContentsId: session.webContentsId });
    return promise;
  }

  async finishSession(session, payload = {}) {
    await session.writeChain.catch(() => {});
    await this.closeSessionHandle(session);

    if (session.segmentedClip && session.segmentPaths.length > 1 && !session.failed) {
      const combinedPath = path.join(
        path.dirname(session.tempPath),
        `rp4-${crypto.randomUUID()}.part.${session.recordedContainer}`
      );
      try {
        const sourceSegments = [...session.segmentPaths];
        await ffmpeg.concatSegments(session.segmentPaths, combinedPath, {
          jobId: `clip-concat:${session.baseName}`,
          totalDurationMs: Number(payload.durationMs) || Number(session.meta.durationMs) || 0,
          onProgress: (ratio) => this.emit('recording:convert-progress', {
            phase: 'clip-concat',
            ratio
          })
        });
        await ffmpeg.validateMedia(combinedPath);
        session.tempPath = combinedPath;
        session.segmentPaths = [combinedPath];
        await Promise.allSettled(sourceSegments.map((filePath) => fs.rm(filePath, { force: true })));
      } catch (error) {
        await fs.rm(combinedPath, { force: true }).catch(() => {});
        session.failed = `클립 세그먼트를 결합하지 못했습니다. ${error?.message || error}`.slice(0, 500);
        // Preserve the largest complete segment as a visible partial recording. The
        // remaining app-owned temp files stay recoverable on the next launch.
        const candidates = await Promise.all(session.segmentPaths.map(async (filePath) => ({
          filePath,
          stats: await statFile(filePath)
        })));
        const largest = candidates.filter((entry) => entry.stats?.size > 0)
          .sort((a, b) => b.stats.size - a.stats.size)[0];
        if (largest) session.tempPath = largest.filePath;
      }
    }

    const tempStats = await statFile(session.tempPath);
    session.bytes = Math.max(session.bytes, tempStats?.size || 0);
    if (session.bytes === 0) {
      await fs.rm(session.tempPath, { force: true });
      return null;
    }

    const durationMs = Number.isFinite(Number(payload.durationMs)) && Number(payload.durationMs) > 0
      ? Math.round(Number(payload.durationMs))
      : Math.max(0, Date.now() - session.startedAtMs);

    const failureReason = session.failed || (
      typeof payload.failureReason === 'string' && payload.failureReason.trim()
        ? payload.failureReason.trim().slice(0, 500)
        : null
    );
    const finalized = failureReason
      ? await this.keepPartial(session, failureReason)
      : await this.finalize(session, { durationMs });
    const stats = await statFile(finalized.filePath);
    const outcome = finalized.partial
      ? 'partial'
      : finalized.conversionError ? 'original-preserved' : 'exact';
    const verificationPending = Boolean(finalized.verificationPending);
    const meta = {
      ...session.meta,
      ...normalizeRecordingMeta(payload.meta),
      format: finalized.format,
      converted: finalized.converted,
      conversionError: finalized.conversionError || null,
      status: finalized.partial ? 'partial' : verificationPending ? 'verifying' : 'complete',
      partial: Boolean(finalized.partial),
      failureReason: finalized.failureReason || null,
      outcome,
      durationMs,
      stoppedAt: new Date().toISOString(),
      bytes: stats?.size || 0
    };

    await this.setMetadata(finalized.filePath, meta);

    if (verificationPending) {
      this.enqueueVerification(finalized.filePath, durationMs, finalized.optimizable);
    } else if (finalized.optimizable && this.settings.value.optimizeMp4) {
      this.enqueueOptimize(finalized.filePath, durationMs);
    }

    return {
      ...this.toDto(finalized.filePath, stats, meta),
      converted: finalized.converted,
      conversionError: finalized.conversionError || null,
      status: meta.status,
      failureReason: meta.failureReason,
      outcome
    };
  }

  async closeSessionHandle(session) {
    if (!session || session.handleClosed) return;
    session.handleClosed = true;
    try {
      await session.handle.close();
    } catch (error) {
      const message = `녹화 파일을 닫는 중 오류가 발생했습니다. ${error?.message || error}`;
      session.failed = session.failed ? `${session.failed} ${message}`.slice(0, 500) : message.slice(0, 500);
    }
  }

  /**
   * Decides between three outcomes, cheapest first:
   *  1. rename       – recorded container already matches the target (the normal path)
   *  2. stream copy   – right codec, wrong container
   *  3. re-encode     – codec cannot go into the target container at all
   */
  async finalize(session, { durationMs }) {
    const { targetFormat, recordedContainer, recordedCodec, recordedAudioCodec } = session;
    const canStreamCopyToMp4 = targetFormat === 'mp4' && recordedCodec === 'h264';

    // Clip epochs contain every Blob from one MediaRecorder in order. FFmpeg can therefore
    // seek from the end of a complete stream without assuming any Blob is independently
    // decodable.
    if (session.forceRemux) {
      const target = await uniquePath(session.recordingsDir, session.baseName, targetFormat);
      const recentDurationMs = Number(session.meta.trimRecentMs) || durationMs;
      const endOffsetMs = Math.max(0, Number(session.meta.trimEndOffsetMs) || 0);
      try {
        this.emit('recording:convert-progress', { phase: 'clip', ratio: 0 });
        const progress = (ratio) => this.emit('recording:convert-progress', { phase: 'clip', ratio });

        if (targetFormat === 'mp4' && recordedCodec === 'unknown'
          && recordedContainer === 'mp4') {
          // Some Chromium builds report only "video/mp4" even when the payload is
          // H.264. Try the lossless path first and transcode only when the actual file
          // proves incompatible.
          try {
            await ffmpeg.trimRecent(session.tempPath, target, {
              durationMs: recentDurationMs,
              endOffsetMs,
              jobId: `clip:${session.baseName}`,
              onProgress: progress
            });
            await ffmpeg.validateMedia(target);
          } catch {
            await fs.rm(target, { force: true }).catch(() => {});
            await ffmpeg.transcodeToMp4(session.tempPath, target, {
              fps: session.meta.fps,
              bitrateMbps: session.meta.bitrateMbps,
              audioBitrateKbps: session.meta.audioBitrateKbps,
              encoderPreset: session.meta.encoderPreset,
              recentDurationMs,
              recentEndOffsetMs: endOffsetMs,
              jobId: `clip:${session.baseName}`,
              onProgress: progress
            });
          }
        } else if (targetFormat === 'mp4' && recordedCodec !== 'h264') {
          await ffmpeg.transcodeToMp4(session.tempPath, target, {
            fps: session.meta.fps,
            bitrateMbps: session.meta.bitrateMbps,
            audioBitrateKbps: session.meta.audioBitrateKbps,
            encoderPreset: session.meta.encoderPreset,
            recentDurationMs,
            recentEndOffsetMs: endOffsetMs,
            jobId: `clip:${session.baseName}`,
            onProgress: progress
          });
        } else if (targetFormat === 'mp4' && recordedContainer !== 'mp4') {
          await ffmpeg.trimRecentToMp4(session.tempPath, target, {
            durationMs: recentDurationMs,
            endOffsetMs,
            audioBitrateKbps: session.meta.audioBitrateKbps,
            jobId: `clip:${session.baseName}`,
            onProgress: progress
          });
        } else {
          await ffmpeg.trimRecent(session.tempPath, target, {
            durationMs: recentDurationMs,
            endOffsetMs,
            jobId: `clip:${session.baseName}`,
            onProgress: progress
          });
        }
        await ffmpeg.validateMedia(target);
        await fs.rm(session.tempPath, { force: true });
        return { filePath: target, format: targetFormat, converted: true, optimizable: false };
      } catch (error) {
        return this.keepOriginal(session, target, error);
      }
    }

    if (recordedContainer === targetFormat) {
      const target = await uniquePath(session.recordingsDir, session.baseName, targetFormat);
      await this.moveFile(session.tempPath, target);
      return {
        filePath: target,
        format: targetFormat,
        converted: false,
        // A stream-copy pass moves the moov atom to the front. It is optional, runs in
        // the background, and never delays the save.
        optimizable: targetFormat === 'mp4',
        verificationPending: true
      };
    }

    if (canStreamCopyToMp4) {
      const target = await uniquePath(session.recordingsDir, session.baseName, 'mp4');
      try {
        this.emit('recording:convert-progress', { phase: 'remux', ratio: 0 });
        const remuxOptions = {
          totalDurationMs: durationMs,
          audioBitrateKbps: session.meta.audioBitrateKbps,
          onProgress: (ratio) => this.emit('recording:convert-progress', { phase: 'remux', ratio })
        };
        if (recordedAudioCodec === 'opus') {
          await ffmpeg.remuxH264ToMp4(session.tempPath, target, remuxOptions);
        } else {
          await ffmpeg.remux(session.tempPath, target, remuxOptions);
        }
        await ffmpeg.validateMedia(target);
        await fs.rm(session.tempPath, { force: true });
        return { filePath: target, format: 'mp4', converted: true, optimizable: false };
      } catch (error) {
        return this.keepOriginal(session, target, error);
      }
    }

    if (targetFormat === 'mp4') {
      const target = await uniquePath(session.recordingsDir, session.baseName, 'mp4');
      try {
        this.emit('recording:convert-progress', { phase: 'transcode', ratio: 0 });
        await ffmpeg.transcodeToMp4(session.tempPath, target, {
          fps: session.meta.fps,
          bitrateMbps: session.meta.bitrateMbps,
          audioBitrateKbps: session.meta.audioBitrateKbps,
          encoderPreset: session.meta.encoderPreset,
          totalDurationMs: durationMs,
          jobId: `convert:${session.baseName}`,
          onProgress: (ratio) => this.emit('recording:convert-progress', { phase: 'transcode', ratio })
        });
        await ffmpeg.validateMedia(target);
        await fs.rm(session.tempPath, { force: true });
        return { filePath: target, format: 'mp4', converted: true, optimizable: false };
      } catch (error) {
        return this.keepOriginal(session, target, error);
      }
    }

    // Requested WebM but recorded something else: keep the real container rather than
    // lying about the extension.
    const target = await uniquePath(session.recordingsDir, session.baseName, recordedContainer);
    await this.moveFile(session.tempPath, target);
    return { filePath: target, format: recordedContainer, converted: false, optimizable: false };
  }

  /** Conversion failed: keep the untouched recording so nothing is ever lost. */
  async keepOriginal(session, failedTarget, error) {
    await fs.rm(failedTarget, { force: true });
    const target = await uniquePath(
      session.recordingsDir,
      `${session.baseName}_original`,
      session.recordedContainer
    );
    await this.moveFile(session.tempPath, target);
    return {
      filePath: target,
      format: session.recordedContainer,
      converted: false,
      optimizable: false,
      conversionError: error?.message || String(error)
    };
  }

  /** A write failed: preserve every byte under an explicit partial name. */
  async keepPartial(session, failureReason) {
    const target = await uniquePath(
      session.recordingsDir,
      `${session.baseName}_partial`,
      session.recordedContainer
    );
    await this.moveFile(session.tempPath, target);
    return {
      filePath: target,
      format: session.recordedContainer,
      converted: false,
      optimizable: false,
      partial: true,
      failureReason
    };
  }

  /**
   * Background faststart pass. The recording is already saved and listed before this
   * runs, so the user never waits for it.
   */
  async reconcileRecordingsDir() {
    const recordingsDir = this.settings.recordingsDir;
    await paths.ensureRecordingDirs(recordingsDir);
    const entries = await fs.readdir(recordingsDir, { withFileTypes: true }).catch(() => []);
    const result = { restored: 0, removed: 0, failed: [] };

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(recordingsDir, entry.name);
      const originalName = recoveryOriginalName(entry.name);
      if (!originalName) continue;
      const original = path.join(recordingsDir, originalName);

      try {
        const artifactStats = await statFile(fullPath);
        let artifactValid = false;
        if (artifactStats && artifactStats.size > MIN_RECOVERABLE_RECORDING_BYTES) {
          artifactValid = await ffmpeg.validateMedia(fullPath).then(() => true, () => false);
        }
        const originalExists = await paths.pathExists(original);
        const originalValid = originalExists
          ? await ffmpeg.validateMedia(original).then(() => true, () => false)
          : false;

        if (originalValid) {
          await fs.rm(fullPath, { force: true });
          result.removed += 1;
        } else if (artifactValid) {
          if (originalExists) {
            const corrupt = `${original}.corrupt-${crypto.randomUUID()}`;
            await this.moveFile(original, corrupt);
            try {
              await this.moveFile(fullPath, original);
            } catch (error) {
              try {
                await this.moveFile(corrupt, original);
              } catch (restoreError) {
                error.restoreError = restoreError;
                error.backupPath = corrupt;
              }
              throw error;
            }
          } else {
            await this.moveFile(fullPath, original);
          }
          result.restored += 1;
        } else {
          result.failed.push({ filePath: fullPath, error: '원본과 복구 파일을 모두 검증하지 못해 보존했습니다.' });
        }
      } catch (error) {
        result.failed.push({ filePath: fullPath, error: error?.message || String(error) });
      }
    }

    return result;
  }

  enqueueOptimize(filePath, durationMs) {
    if (this.optimizationCancelled) return;
    this.optimizeQueue.push({ filePath, durationMs });
    this.ensureOptimizeDrain();
  }

  ensureOptimizeDrain() {
    if (this.optimizationCancelled || this.optimizeDrainPromise) return;
    this.optimizeDrainPromise = this.drainOptimizeQueue()
      .finally(() => {
        this.optimizeDrainPromise = null;
        if (!this.optimizationCancelled && this.optimizeQueue.length > 0) {
          this.ensureOptimizeDrain();
        }
      });
  }

  enqueueVerification(filePath, durationMs, optimizable = false) {
    if (this.verificationCancelled) return Promise.resolve(false);
    if (this.verificationJobs.has(filePath)) return this.verificationJobs.get(filePath);

    let resolveJob;
    const promise = new Promise((resolve) => { resolveJob = resolve; });
    const job = {
      filePath,
      durationMs,
      optimizable,
      jobId: `verify:${crypto.randomUUID()}`,
      promise,
      resolve: resolveJob
    };
    this.verificationJobs.set(filePath, promise);
    this.verificationQueue.push(job);
    this.ensureVerificationDrain();
    return promise;
  }

  ensureVerificationDrain() {
    if (this.verificationCancelled) return;
    while (this.verificationRunning.size < VERIFICATION_CONCURRENCY
      && this.verificationQueue.length > 0) {
      const job = this.verificationQueue.shift();
      this.verificationRunning.set(job.filePath, job);
      void this.runVerification(job).then(job.resolve, () => job.resolve(false)).finally(() => {
        this.verificationRunning.delete(job.filePath);
        if (this.verificationJobs.get(job.filePath) === job.promise) {
          this.verificationJobs.delete(job.filePath);
        }
        this.ensureVerificationDrain();
      });
    }
  }

  async runVerification(job) {
    const { filePath, durationMs, optimizable } = job;
    this.emit('recording:verify', { filePath, state: 'start' });
    try {
      await ffmpeg.validateMedia(filePath, {
        expectedDurationMs: durationMs,
        jobId: job.jobId
      });
      const meta = this.metadata.get(filePath);
      if (meta) {
        await this.setMetadata(filePath, {
          ...meta,
          status: 'complete',
          partial: false,
          outcome: meta.outcome === 'exact' ? 'exact' : meta.outcome,
          failureReason: null
        });
      }
      this.emit('recording:verify', { filePath, state: 'done' });
      if (optimizable && this.settings.value.optimizeMp4) {
        this.enqueueOptimize(filePath, durationMs);
      }
      return true;
    } catch (error) {
      if (error?.code === 'CANCELLED') {
        // Preserve `verifying`; startup will resume an interrupted background decode.
        this.emit('recording:verify', { filePath, state: 'cancelled' });
        return false;
      }
      const meta = this.metadata.get(filePath);
      if (meta) {
        await this.setMetadata(filePath, {
          ...meta,
          status: 'invalid',
          partial: true,
          outcome: 'invalid',
          failureReason: `저장된 미디어를 검증하지 못했습니다. ${error?.message || error}`.slice(0, 500)
        });
      }
      this.emit('recording:verify', {
        filePath,
        state: 'failed',
        error: error?.message || String(error)
      });
      return false;
    }
  }

  async cancelAndDrainVerifications({ timeoutMs = VERIFICATION_SHUTDOWN_TIMEOUT_MS } = {}) {
    this.verificationCancelled = true;
    for (const job of this.verificationQueue.splice(0)) {
      if (this.verificationJobs.get(job.filePath) === job.promise) {
        this.verificationJobs.delete(job.filePath);
      }
      job.resolve(false);
    }

    const running = [...this.verificationRunning.values()];
    if (running.length === 0) return;
    let timer;
    await Promise.race([
      Promise.allSettled([
        ...running.map((job) => ffmpeg.cancel(job.jobId, { timeoutMs })),
        ...running.map((job) => job.promise)
      ]),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); })
    ]);
    clearTimeout(timer);
  }

  /** Restarts direct-save validation that was interrupted by a previous app exit. */
  async resumePendingMediaJobs() {
    const recordingsDir = path.resolve(this.settings.recordingsDir).toLowerCase();
    let resumed = 0;
    for (const [filePath, meta] of this.metadata) {
      if (meta?.status !== 'verifying') continue;
      if (path.dirname(path.resolve(filePath)).toLowerCase() !== recordingsDir) continue;
      if (!(await paths.pathExists(filePath))) continue;
      resumed += 1;
      const durationMs = Number(meta.durationMs) || 0;
      const optimizable = String(meta.format || '').toLowerCase() === 'mp4';
      this.enqueueVerification(filePath, durationMs, optimizable);
    }
    return resumed;
  }

  async drainOptimizeQueue() {
    if (this.optimizing) return;
    this.optimizing = true;

    try {
      while (this.optimizeQueue.length > 0) {
        const job = this.optimizeQueue.shift();
        if (!(await paths.pathExists(job.filePath))) continue;

        const optimized = `${job.filePath}.optimizing-${crypto.randomUUID()}.mp4`;
        this.optimizingFilePath = job.filePath;
        try {
          const before = await statFile(job.filePath);
          const available = await freeBytes(path.dirname(job.filePath));
          const required = (before?.size || 0) * 1.1 + MIN_FREE_BYTES_TO_CONTINUE;
          if (available != null && available < required) {
            this.emit('recording:optimize', {
              filePath: job.filePath,
              state: 'skipped-low-space'
            });
            continue;
          }
          this.emit('recording:optimize', { filePath: job.filePath, state: 'start' });
          await ffmpeg.remux(job.filePath, optimized, {
            jobId: `optimize:${job.filePath}`,
            totalDurationMs: job.durationMs
          });

          const after = await statFile(optimized);
          // Only swap when the result looks sane, so a truncated remux cannot replace a
          // good recording.
          if (after && before && after.size > before.size * 0.5) {
            await ffmpeg.validateMedia(optimized);
            await replaceFileSafely(job.filePath, optimized, {
              move: this.moveFile,
              validate: (filePath) => ffmpeg.validateMedia(filePath)
            });
            const meta = this.metadata.get(job.filePath);
            if (meta) await this.setMetadata(job.filePath, { ...meta, optimized: true, bytes: after.size });
            this.emit('recording:optimize', { filePath: job.filePath, state: 'done' });
          } else {
            await fs.rm(optimized, { force: true });
            this.emit('recording:optimize', { filePath: job.filePath, state: 'skipped' });
          }
        } catch (error) {
          // If rollback itself failed, both the backup path and the replacement are left
          // intact for recovery. Otherwise the original is safely back in place.
          if (!error.backupPath) await fs.rm(optimized, { force: true });
          this.emit('recording:optimize', {
            filePath: job.filePath,
            state: 'failed',
            error: error?.message || String(error)
          });
        } finally {
          this.optimizingFilePath = null;
        }
      }
    } finally {
      this.optimizing = false;
    }
  }

  async cancelAndDrainOptimizations({ timeoutMs = VERIFICATION_SHUTDOWN_TIMEOUT_MS } = {}) {
    this.optimizationCancelled = true;
    this.optimizeQueue.length = 0;
    await ffmpeg.cancelAll({ timeoutMs });
    if (!this.optimizeDrainPromise) return;
    let timer;
    await Promise.race([
      this.optimizeDrainPromise.catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); })
    ]);
    clearTimeout(timer);
  }

  toDto(filePath, stats, meta = {}) {
    const hasMetadata = meta && typeof meta === 'object' && Object.keys(meta).length > 0;
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const defaultStatus = !hasMetadata && extension === 'avi' ? 'unverified' : 'complete';
    return {
      filePath,
      name: path.basename(filePath),
      size: stats?.size || 0,
      createdAt: (stats?.birthtime || stats?.mtime || new Date()).toISOString(),
      durationMs: meta.durationMs || 0,
      width: meta.width || null,
      height: meta.height || null,
      fps: meta.fps || null,
      requestedFps: meta.requestedFps || null,
      effectiveFps: meta.effectiveFps || null,
      capturedFrames: meta.capturedFrames || null,
      droppedFrames: meta.droppedFrames || 0,
      bitrateMbps: meta.bitrateMbps || null,
      sourceName: meta.sourceName || null,
      modeLabel: meta.modeLabel || null,
      format: meta.format || extension,
      status: meta.status || defaultStatus,
      partial: Boolean(meta.partial),
      failureReason: meta.failureReason || null,
      outcome: meta.outcome || (defaultStatus === 'unverified' ? 'unverified' : 'exact'),
      performanceWarning: meta.performanceWarning || null,
      conversionError: meta.conversionError || null,
      recovered: Boolean(meta.recovered)
    };
  }

  async list() {
    await paths.ensureRecordingDirs(this.settings.recordingsDir);
    const recordingsDir = this.settings.recordingsDir;

    let entries;
    try {
      entries = await fs.readdir(recordingsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = entries
      .filter((entry) => entry.isFile() && RECORDING_EXTENSIONS.test(entry.name))
      .filter((entry) => !OPTIMIZING_FILE_PATTERN.test(entry.name))
      .map((entry) => path.join(recordingsDir, entry.name));

    const recordings = await Promise.all(files.map(async (filePath) => {
      const stats = await statFile(filePath);
      return this.toDto(filePath, stats, this.metadata.get(filePath) || {});
    }));

    // Drop index entries whose files are gone so the index cannot grow without bound.
    const known = new Set(files);
    let pruned = false;
    for (const filePath of [...this.metadata.keys()]) {
      const sameDirectory = path.dirname(path.resolve(filePath)).toLowerCase()
        === path.resolve(recordingsDir).toLowerCase();
      if (!known.has(filePath) && sameDirectory) {
        this.metadata.delete(filePath);
        pruned = true;
      }
    }
    if (pruned) {
      void this.saveIndex().catch(() => { this.indexDirty = true; });
    }

    return recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async thumbnail(filePath) {
    const stats = await statFile(filePath);
    if (!stats?.isFile()) return null;
    const cacheDir = path.join(paths.configDir(), 'recording-thumbnails');
    const key = crypto.createHash('sha256')
      .update(`${filePath}\0${stats.size}\0${stats.mtimeMs}`)
      .digest('hex');
    const output = path.join(cacheDir, `rp4-thumb-${key}.jpg`);
    await fs.mkdir(cacheDir, { recursive: true });
    if (this.thumbnailInflight.has(key)) return this.thumbnailInflight.get(key);

    const task = this.thumbnailQueue.then(async () => {
      let buffer = await fs.readFile(output).catch(() => null);
      const valid = buffer && buffer.length >= 4 && buffer.length <= 2 * 1024 * 1024
        && buffer[0] === 0xff && buffer[1] === 0xd8
        && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
      if (!valid) {
        await fs.rm(output, { force: true });
        const temporary = `${output}.tmp-${crypto.randomUUID()}.jpg`;
        try {
          await ffmpeg.createThumbnail(filePath, temporary);
          buffer = await fs.readFile(temporary);
          const generatedValid = buffer.length >= 4 && buffer.length <= 2 * 1024 * 1024
            && buffer[0] === 0xff && buffer[1] === 0xd8
            && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
          if (!generatedValid) throw new Error('생성된 영상 썸네일이 올바르지 않습니다.');
          await fs.rename(temporary, output);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      }
      await fs.utimes(output, new Date(), new Date()).catch(() => {});
      await pruneThumbnailCache(cacheDir);
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    });
    this.thumbnailInflight.set(key, task);
    this.thumbnailQueue = task.catch(() => {});
    try {
      return await task;
    } finally {
      this.thumbnailInflight.delete(key);
    }
  }

  /** Moves a completed top-level recording to the OS recycle bin and prunes its metadata. */
  async trashRecording(filePath, { trash } = {}) {
    if (typeof filePath !== 'string' || typeof trash !== 'function') return false;
    const recordingsDir = await fs.realpath(path.resolve(this.settings.recordingsDir)).catch(() => null);
    const target = await fs.realpath(path.resolve(filePath)).catch(() => null);
    if (!recordingsDir || !target) return false;
    if (path.dirname(target).toLowerCase() !== recordingsDir.toLowerCase()
      || !RECORDING_EXTENSIONS.test(target)) return false;
    if (!(await paths.pathExists(target))) return false;

    this.optimizeQueue = this.optimizeQueue.filter((job) => job.filePath !== target);
    if (this.optimizingFilePath === target) {
      await ffmpeg.cancel(`optimize:${target}`);
      const deadline = Date.now() + 10000;
      while (this.optimizingFilePath === target && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.optimizingFilePath === target) return false;
    }

    if (!(await paths.pathExists(target))) return false;
    await trash(target);
    this.metadata.delete(target);
    try {
      await this.saveIndex();
    } catch (error) {
      this.indexDirty = true;
      this.emit('app:notice', {
        level: 'warn',
        message: `삭제된 녹화의 메타데이터를 정리하지 못했습니다. (${error?.message || error})`
      });
    }
    return true;
  }

  saveScreenshot(payload = {}) {
    const job = this.performSaveScreenshot(payload);
    this.screenshotJobs.add(job);
    const release = () => this.screenshotJobs.delete(job);
    void job.then(release, release);
    return job;
  }

  async performSaveScreenshot(payload = {}) {
    const recordingsDir = this.settings.recordingsDir;
    const screenshotsDir = paths.screenshotsDirFor(recordingsDir);
    await paths.ensureRecordingDirs(recordingsDir);
    const buffer = toBoundedBuffer(payload.buffer, MAX_SCREENSHOT_BYTES);

    let format = null;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]))) {
      format = 'png';
    } else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      format = 'jpg';
    } else if (buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      format = 'webp';
    }
    if (!format) throw new Error('지원하지 않는 스크린샷 형식입니다.');

    const filePath = await writeAtomicScreenshot(screenshotsDir, format, buffer);
    return { filePath, fileName: path.basename(filePath) };
  }

  /** Closes every open handle. Awaited during shutdown so nothing is left dangling. */
  async closeAllSessions() {
    const losslessIds = [...this.losslessSessions.keys()];
    await Promise.allSettled(losslessIds.map((sessionId) => this.stopLossless({
      sessionId,
      failureReason: '앱 종료 중 무압축 녹화를 마무리했습니다.'
    })));
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();

    await Promise.allSettled(sessions.map(async ([, session]) => {
      session.acceptingWrites = false;
      await session.writeChain.catch(() => {});
      await this.closeSessionHandle(session);
    }));

    await Promise.allSettled([...this.finalizing.values()].map((entry) => entry.promise));
    await Promise.allSettled([...this.screenshotJobs]);
    await this.flushIndex().catch((error) => {
      this.emit('app:notice', {
        level: 'warn',
        message: `녹화 메타데이터 저장을 완료하지 못했습니다. (${error?.message || error})`
      });
    });

    return sessions.length + losslessIds.length;
  }

  /**
   * Finalizes every in-flight recording. Used when the window is closing so a take is
   * saved properly instead of being stranded in the app-owned temporary directory.
   */
  async finalizeAllSessions({ failureReason = null } = {}) {
    const ids = [...this.sessions.keys()];
    const losslessIds = [...this.losslessSessions.keys()];
    const saved = [];
    for (const sessionId of ids) {
      try {
        const result = await this.stop({ sessionId, failureReason });
        if (result) saved.push(result);
      } catch {
        // Best effort: the sweep on next launch recovers anything left behind.
      }
    }
    for (const sessionId of losslessIds) {
      try {
        const result = await this.stopLossless({ sessionId, failureReason });
        if (result) saved.push(result);
      } catch {
        // Raw frames and the recovery manifest remain in the owned temp folder.
      }
    }
    const finishing = [...this.finalizing.values()].map((entry) => entry.promise);
    const settled = await Promise.allSettled(finishing);
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) saved.push(result.value);
    }
    return saved;
  }
}

module.exports = {
  RecordingManager,
  RECORDING_EXTENSIONS,
  timestamp,
  sanitizeName,
  containerFromMimeType,
  videoCodecFromMimeType,
  audioCodecFromMimeType,
  normalizeRecordingMeta,
  recoveryOriginalName,
  uniquePath,
  moveFile,
  replaceFileSafely,
  openOwnedRegularFile,
  writeUniqueFile,
  writeAtomicScreenshot,
  toBoundedBuffer,
  pruneThumbnailCache,
  MAX_IPC_CHUNK_BYTES,
  MAX_SESSION_QUEUED_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_LOSSLESS_FRAME_BYTES,
  MIN_LOSSLESS_FREE_BYTES_TO_START,
  MAX_INDEX_BYTES
};
