'use strict';

const { app } = require('electron/main');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Historically every path was hardcoded under D:\RP4, which meant the app could not
// start at all on a machine without a writable D: drive. We now resolve real OS paths
// and migrate any pre-existing D:\RP4 install so upgrades keep their recordings.
const LEGACY_ROOT = 'D:\\RP4';
const LEGACY_CONFIG_FILE = path.join(LEGACY_ROOT, 'config', 'rp4-recorder-settings.json');
const LEGACY_RECORDINGS_DIR = path.join(LEGACY_ROOT, 'recordings');

const SETTINGS_FILE_NAME = 'rp4-recorder-settings.json';
const TEMP_DIR_NAME = '.rp4-recorder-temp';
const TEMP_OWNER_FILE = '.rp4-owner';
const TEMP_OWNER_VALUE = 'RP4 Recorder temporary files v1\n';
const SCREENSHOTS_DIR_NAME = 'screenshots';

function configDir() {
  return app.getPath('userData');
}

function settingsFile() {
  return path.join(configDir(), SETTINGS_FILE_NAME);
}

function fallbackRecordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
}

function defaultRecordingsDir() {
  try {
    return path.join(app.getPath('videos'), 'RP4 Recorder');
  } catch {
    return fallbackRecordingsDir();
  }
}

function tempDirFor(recordingsDir) {
  return path.join(recordingsDir, TEMP_DIR_NAME);
}

function screenshotsDirFor(recordingsDir) {
  return path.join(recordingsDir, SCREENSHOTS_DIR_NAME);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory is only usable if we can actually create and write inside it. Checking
 * up front lets us fall back to a guaranteed-writable location instead of dying during
 * the first recording.
 */
async function probeDirectoryWritable(target) {
  let probe = null;
  let handle = null;
  let ownsProbe = false;
  try {
    probe = path.join(target, `.rp4-write-probe-${crypto.randomUUID()}`);
    handle = await fs.open(probe, 'wx');
    ownsProbe = true;
    await handle.writeFile('ok', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // Once closed, prefer a harmless stale probe over a second delete attempt against a
    // path another process might have reused after a failed unlink.
    ownsProbe = false;
    await fs.rm(probe, { force: true });
    return true;
  } finally {
    await handle?.close().catch(() => {});
    // An exclusive open can fail because another process already owns this random name.
    // Only unlink a probe this invocation actually created.
    if (ownsProbe && probe) await fs.rm(probe, { force: true }).catch(() => {});
  }
}

async function isDirectoryWritable(target) {
  try {
    await fs.mkdir(target, { recursive: true });
    await probeDirectoryWritable(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureOwnedTempDir(recordingsDir) {
  const root = path.resolve(recordingsDir);
  const tempDir = tempDirFor(root);
  await fs.mkdir(root, { recursive: true });

  let created = false;
  try {
    await fs.mkdir(tempDir);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stats = await fs.lstat(tempDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('임시 녹화 경로가 안전한 폴더가 아닙니다.');
  }
  const [realRoot, realTemp] = await Promise.all([fs.realpath(root), fs.realpath(tempDir)]);
  if (path.dirname(realTemp).toLowerCase() !== realRoot.toLowerCase()
    || path.basename(realTemp).toLowerCase() !== TEMP_DIR_NAME.toLowerCase()) {
    throw new Error('임시 녹화 경로가 저장 폴더를 벗어났습니다.');
  }

  const ownerPath = path.join(realTemp, TEMP_OWNER_FILE);
  if (created) {
    try {
      await fs.writeFile(ownerPath, TEMP_OWNER_VALUE, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      // Remove only the directory this call just created, and only when it is still empty.
      // Never recurse here: another process may have placed a file in it meanwhile.
      await fs.rmdir(realTemp).catch(() => {});
      throw error;
    }
  } else {
    const ownerStats = await fs.lstat(ownerPath).catch(() => null);
    if (!ownerStats?.isFile() || ownerStats.isSymbolicLink()) {
      throw new Error('앱 소유 표시가 없는 임시 폴더는 사용하지 않습니다.');
    }
    const owner = await fs.readFile(ownerPath, 'utf8');
    if (owner !== TEMP_OWNER_VALUE) {
      throw new Error('임시 폴더의 앱 소유 표시가 올바르지 않습니다.');
    }
  }
  return realTemp;
}

async function ensureSafeChildDirectory(recordingsDir, childName) {
  const root = path.resolve(recordingsDir);
  const child = path.join(root, childName);
  await fs.mkdir(child, { recursive: true });
  const stats = await fs.lstat(child);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${childName} 경로가 안전한 폴더가 아닙니다.`);
  }
  const [realRoot, realChild] = await Promise.all([fs.realpath(root), fs.realpath(child)]);
  if (path.dirname(realChild).toLowerCase() !== realRoot.toLowerCase()) {
    throw new Error(`${childName} 경로가 저장 폴더를 벗어났습니다.`);
  }
  return realChild;
}

/**
 * Rejects values that are not usable recording targets. Guards against a corrupted or
 * hand-edited settings file pointing the app at a drive root or a relative path.
 */
function isPlausibleRecordingsDir(value) {
  if (typeof value !== 'string' || !value.trim()) return false;

  const trimmed = value.trim();
  // Must already be absolute. Checking after path.resolve() would be pointless, since
  // resolve() turns anything into an absolute path against the current working directory.
  if (!path.isAbsolute(trimmed)) return false;

  // Refuse a bare drive root ("D:\") or filesystem root: we create subdirectories and
  // enumerate files there, so the blast radius must stay bounded.
  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) return false;

  return true;
}

function normalizeRecordingsDir(value, fallback) {
  const safeFallback = fallback || defaultRecordingsDir();
  if (!isPlausibleRecordingsDir(value)) return safeFallback;
  return path.resolve(String(value).trim());
}

/**
 * True when `target` is the same as, or nested inside, `root`. Used to keep
 * renderer-supplied paths inside directories this app actually owns.
 */
function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Copies a legacy D:\RP4 settings file into the real userData location the first time
 * the new build runs, so an existing install keeps its hotkeys, presets and folder.
 */
async function migrateLegacySettings() {
  const target = settingsFile();
  if (await pathExists(target)) return { migrated: false, reason: 'exists' };
  if (!(await pathExists(LEGACY_CONFIG_FILE))) return { migrated: false, reason: 'no-legacy' };

  try {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.copyFile(LEGACY_CONFIG_FILE, target);
    return { migrated: true, from: LEGACY_CONFIG_FILE };
  } catch (error) {
    return { migrated: false, reason: error.message };
  }
}

async function hasLegacyInstall(exists = pathExists) {
  return await exists(LEGACY_CONFIG_FILE) && await exists(LEGACY_RECORDINGS_DIR);
}

/**
 * Picks the recordings directory to actually use: the configured one when writable,
 * otherwise the legacy folder if it still exists, otherwise an OS-appropriate default,
 * and finally userData which is always writable.
 */
async function resolveRecordingsDir(configuredDir) {
  const candidates = [];
  const requestedDir = typeof configuredDir === 'string' && configuredDir.trim()
    ? configuredDir.trim()
    : null;
  const requestedValid = requestedDir != null && isPlausibleRecordingsDir(requestedDir);
  const requestedResolved = requestedValid ? path.resolve(requestedDir) : null;

  if (requestedResolved) {
    candidates.push(requestedResolved);
  }
  // A recordings folder alone is not proof of an RP4 installation. Requiring the
  // legacy settings file prevents a fresh install from adopting an unrelated D:\RP4.
  if (await hasLegacyInstall()) {
    candidates.push(LEGACY_RECORDINGS_DIR);
  }
  candidates.push(defaultRecordingsDir());
  candidates.push(fallbackRecordingsDir());

  for (const candidate of [...new Set(candidates)]) {
    if (await isDirectoryWritable(candidate)) {
      try {
        await ensureRecordingDirs(candidate);
      } catch {
        continue;
      }
      const fallbackReason = requestedDir == null
        ? null
        : !requestedValid
          ? 'invalid'
          : candidate !== requestedResolved ? 'unwritable' : null;
      return {
        recordingsDir: candidate,
        fellBack: fallbackReason != null,
        fallbackReason,
        requestedDir
      };
    }
  }

  // Every candidate failed; hand back userData so callers still get a real path and the
  // caller-level error handling can surface the problem.
  return {
    recordingsDir: fallbackRecordingsDir(),
    fellBack: requestedDir != null,
    fallbackReason: requestedDir == null ? null : requestedValid ? 'unwritable' : 'invalid',
    requestedDir
  };
}

async function ensureRecordingDirs(recordingsDir) {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.mkdir(recordingsDir, { recursive: true });
  await probeDirectoryWritable(recordingsDir);
  const [tempDir, screenshotsDir] = await Promise.all([
    ensureOwnedTempDir(recordingsDir),
    ensureSafeChildDirectory(recordingsDir, SCREENSHOTS_DIR_NAME)
  ]);
  // The root being writable is not enough: recordings, screenshots and staging all write
  // inside direct children. Probe the actual resolved children before accepting a folder.
  await Promise.all([
    probeDirectoryWritable(tempDir),
    probeDirectoryWritable(screenshotsDir)
  ]);
  return { recordingsDir: path.resolve(recordingsDir), tempDir, screenshotsDir };
}

module.exports = {
  LEGACY_ROOT,
  LEGACY_RECORDINGS_DIR,
  TEMP_DIR_NAME,
  TEMP_OWNER_FILE,
  SCREENSHOTS_DIR_NAME,
  configDir,
  settingsFile,
  defaultRecordingsDir,
  fallbackRecordingsDir,
  tempDirFor,
  screenshotsDirFor,
  pathExists,
  probeDirectoryWritable,
  isDirectoryWritable,
  ensureOwnedTempDir,
  ensureSafeChildDirectory,
  hasLegacyInstall,
  isPlausibleRecordingsDir,
  normalizeRecordingsDir,
  isInside,
  migrateLegacySettings,
  resolveRecordingsDir,
  ensureRecordingDirs
};
