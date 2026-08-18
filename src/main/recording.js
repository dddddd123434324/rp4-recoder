'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ffmpeg = require('./ffmpeg');
const paths = require('./paths');

const RECORDING_EXTENSIONS = /\.(webm|mp4|mkv)$/i;
const INDEX_FILE_NAME = 'recordings-index.json';
const MAX_INDEX_ENTRIES = 2000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;

// Refuse to start a recording without some headroom, and stop cleanly rather than
// letting writes fail halfway through once the disk is nearly full.
const MIN_FREE_BYTES_TO_START = 512 * 1024 * 1024;
const MIN_FREE_BYTES_TO_CONTINUE = 128 * 1024 * 1024;
const MIN_RECOVERABLE_RECORDING_BYTES = 512;
const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
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
    durationMs: [0, 24 * 60 * 60 * 1000, true],
    trimRecentMs: [0, 24 * 60 * 60 * 1000, true],
    trimEndOffsetMs: [0, 24 * 60 * 60 * 1000, true]
  };
  for (const [key, [min, max, integer]] of Object.entries(numbers)) {
    const normalized = boundedNumber(source[key], min, max, { integer });
    if (normalized !== undefined) output[key] = normalized;
  }
  for (const key of ['clip', 'requestedSystemAudio', 'hasSystemAudio', 'requestedMic', 'hasMic']) {
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
  constructor({ settings, emit, move = moveFile }) {
    this.settings = settings;
    this.emit = emit || (() => {});
    this.sessions = new Map();
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
    this.startingWebContentsIds = new Set();
    this.moveFile = move;
  }

  get activeCount() {
    return this.sessions.size;
  }

  hasActiveSessions() {
    return this.sessions.size > 0;
  }

  hasPendingRecordings() {
    return this.startingWebContentsIds.size > 0 || this.sessions.size > 0
      || this.finalizing.size > 0 || this.screenshotJobs.size > 0;
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

    return { removed, recovered, failed };
  }

  async start(meta = {}, { webContentsId } = {}) {
    const senderBusy = this.startingWebContentsIds.has(webContentsId)
      || [...this.sessions.values()].some((session) => session.webContentsId === webContentsId)
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
      handleClosed: false,
      bytes: 0,
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
      // The recording streams straight into its final container when the codec already
      // matches the target, which is what makes stopping instant.
      directToTarget: recordedContainer === targetFormat,
      recordedContainer,
      recordedCodec,
      recordedAudioCodec
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
    const writeTask = async () => {
      if (session.failed && !terminal) throw new Error(session.failed);

      try {
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

    const result = session.writeChain.then(writeTask);
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
    const meta = {
      ...session.meta,
      ...normalizeRecordingMeta(payload.meta),
      format: finalized.format,
      converted: finalized.converted,
      conversionError: finalized.conversionError || null,
      status: finalized.partial ? 'partial' : 'complete',
      partial: Boolean(finalized.partial),
      failureReason: finalized.failureReason || null,
      outcome,
      durationMs,
      stoppedAt: new Date().toISOString(),
      bytes: stats?.size || 0
    };

    await this.setMetadata(finalized.filePath, meta);

    if (finalized.optimizable && this.settings.value.optimizeMp4) {
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

        if (targetFormat === 'mp4' && recordedCodec !== 'h264') {
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
        optimizable: targetFormat === 'mp4'
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
          }
          await this.moveFile(fullPath, original);
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
    if (!this.optimizeDrainPromise) {
      this.optimizeDrainPromise = this.drainOptimizeQueue()
        .finally(() => { this.optimizeDrainPromise = null; });
    }
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

  async cancelAndDrainOptimizations() {
    this.optimizationCancelled = true;
    this.optimizeQueue.length = 0;
    await ffmpeg.cancelAll();
    await this.optimizeDrainPromise?.catch(() => {});
  }

  toDto(filePath, stats, meta = {}) {
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
      modeLabel: meta.modeLabel || null,
      format: meta.format || path.extname(filePath).slice(1).toLowerCase(),
      status: meta.status || 'complete',
      partial: Boolean(meta.partial),
      failureReason: meta.failureReason || null,
      outcome: meta.outcome || 'exact',
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

    return sessions.length;
  }

  /**
   * Finalizes every in-flight recording. Used when the window is closing so a take is
   * saved properly instead of being stranded in the app-owned temporary directory.
   */
  async finalizeAllSessions({ failureReason = null } = {}) {
    const ids = [...this.sessions.keys()];
    const saved = [];
    for (const sessionId of ids) {
      try {
        const result = await this.stop({ sessionId, failureReason });
        if (result) saved.push(result);
      } catch {
        // Best effort: the sweep on next launch recovers anything left behind.
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
  writeUniqueFile,
  writeAtomicScreenshot,
  toBoundedBuffer,
  pruneThumbnailCache,
  MAX_IPC_CHUNK_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_INDEX_BYTES
};
