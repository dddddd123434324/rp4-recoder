'use strict';

const { app } = require('electron/main');
const fs = require('node:fs/promises');
const path = require('node:path');

// Historically every path was hardcoded under D:\RP4, which meant the app could not
// start at all on a machine without a writable D: drive. We now resolve real OS paths
// and migrate any pre-existing D:\RP4 install so upgrades keep their recordings.
const LEGACY_ROOT = 'D:\\RP4';
const LEGACY_CONFIG_FILE = path.join(LEGACY_ROOT, 'config', 'rp4-recorder-settings.json');
const LEGACY_RECORDINGS_DIR = path.join(LEGACY_ROOT, 'recordings');

const SETTINGS_FILE_NAME = 'rp4-recorder-settings.json';
const TEMP_DIR_NAME = '.temp';
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
async function isDirectoryWritable(target) {
  try {
    await fs.mkdir(target, { recursive: true });
    const probe = path.join(target, `.rp4-write-probe-${process.pid}`);
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
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
  if (await pathExists(LEGACY_RECORDINGS_DIR)) {
    candidates.push(LEGACY_RECORDINGS_DIR);
  }
  candidates.push(defaultRecordingsDir());
  candidates.push(fallbackRecordingsDir());

  for (const candidate of [...new Set(candidates)]) {
    if (await isDirectoryWritable(candidate)) {
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
  await fs.mkdir(tempDirFor(recordingsDir), { recursive: true });
  await fs.mkdir(screenshotsDirFor(recordingsDir), { recursive: true });
}

module.exports = {
  LEGACY_ROOT,
  LEGACY_RECORDINGS_DIR,
  TEMP_DIR_NAME,
  SCREENSHOTS_DIR_NAME,
  configDir,
  settingsFile,
  defaultRecordingsDir,
  fallbackRecordingsDir,
  tempDirFor,
  screenshotsDirFor,
  pathExists,
  isDirectoryWritable,
  isPlausibleRecordingsDir,
  normalizeRecordingsDir,
  isInside,
  migrateLegacySettings,
  resolveRecordingsDir,
  ensureRecordingDirs
};
