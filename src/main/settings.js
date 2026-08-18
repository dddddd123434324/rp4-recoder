'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');

const DEFAULT_HOTKEYS = {
  recordToggle: 'CommandOrControl+Shift+R',
  pauseToggle: 'CommandOrControl+Shift+P',
  screenshot: 'CommandOrControl+Shift+S',
  clipToggle: 'CommandOrControl+Shift+C',
  clipSave: 'CommandOrControl+Shift+V'
};
const HOTKEY_ACTIONS = Object.keys(DEFAULT_HOTKEYS);

const BUILTIN_PRESET_KEYS = new Set(['low', 'normal', 'high', 'game']);
const DEFAULT_SELECTED_PRESET = 'normal';
const MAX_CUSTOM_PRESETS = 48;

const ENCODER_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];
const CONTAINERS = ['mp4', 'webm'];
const SCREENSHOT_FORMATS = ['png', 'jpeg', 'webp'];
const DEFAULT_SCREENSHOT_FORMAT = 'png';
const DEFAULT_SCREENSHOT_QUALITY = 100;
const SCREENSHOT_QUALITIES = [70, 80, 90, 95, 100];

// Clip mode keeps recent footage buffered. Without a byte ceiling a 7200s buffer at
// 35 Mbps would try to hold ~31 GB, so the buffer is bounded in megabytes as well as
// seconds and the tighter of the two wins.
const DEFAULT_CLIP_BUFFER_LIMIT_MB = 256;
const MIN_CLIP_BUFFER_LIMIT_MB = 64;
const MAX_CLIP_BUFFER_LIMIT_MB = 512;
const MAX_SETTINGS_BYTES = 1024 * 1024;

const DEFAULT_PROFILE = {
  format: 'mp4',
  resolution: '1920x1080',
  fps: '60',
  bitrate: '10',
  encoderPreset: 'veryfast',
  audioBitrate: '192',
  micEnabled: true,
  systemAudioEnabled: true,
  micVolume: 70,
  systemVolume: 80,
  clipDurationSeconds: 300
};

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizePresetName(value) {
  return String(value || '사용자 프리셋')
    // Preset names come from user input; control characters are removed on purpose.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '사용자 프리셋';
}

function normalizeEncoderPreset(preset) {
  return ENCODER_PRESETS.includes(preset) ? preset : 'veryfast';
}

function normalizeFormat(format) {
  return CONTAINERS.includes(format) ? format : 'mp4';
}

function normalizeScreenshotFormat(format) {
  return SCREENSHOT_FORMATS.includes(format) ? format : DEFAULT_SCREENSHOT_FORMAT;
}

function normalizeScreenshotQuality(quality) {
  const value = clampNumber(Number(quality) || DEFAULT_SCREENSHOT_QUALITY, 10, 100);
  return SCREENSHOT_QUALITIES.reduce((closest, candidate) => (
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
  ), DEFAULT_SCREENSHOT_QUALITY);
}

function normalizeResolution(resolution) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(resolution || ''));
  if (!match) return DEFAULT_PROFILE.resolution;
  const width = Math.floor(clampNumber(Number(match[1]), 320, 7680) / 2) * 2;
  const height = Math.floor(clampNumber(Number(match[2]), 240, 4320) / 2) * 2;
  return `${width}x${height}`;
}

function normalizeProfile(value = {}) {
  const profile = value && typeof value === 'object' ? value : {};
  const micVolume = Number(profile.micVolume);
  const systemVolume = Number(profile.systemVolume);

  return {
    format: normalizeFormat(profile.format),
    resolution: normalizeResolution(profile.resolution),
    fps: String(clampNumber(Number(profile.fps) || 60, 1, 240)),
    bitrate: String(clampNumber(Number(profile.bitrate) || 10, 1, 300)),
    encoderPreset: normalizeEncoderPreset(profile.encoderPreset),
    audioBitrate: String(clampNumber(Number(profile.audioBitrate) || 192, 64, 320)),
    micEnabled: profile.micEnabled !== false,
    systemAudioEnabled: profile.systemAudioEnabled !== false,
    micVolume: clampNumber(Number.isFinite(micVolume) ? micVolume : 70, 0, 100),
    systemVolume: clampNumber(Number.isFinite(systemVolume) ? systemVolume : 80, 0, 100),
    clipDurationSeconds: clampNumber(Number(profile.clipDurationSeconds) || 300, 1, 7200)
  };
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
        profile: normalizeProfile(source.profile || source)
      };
    });
}

function normalizeSelectedPreset(value, customPresets = []) {
  // null explicitly means the live profile was adjusted and no preset is active.
  if (value === null) return null;
  const key = typeof value === 'string' ? value : DEFAULT_SELECTED_PRESET;
  if (BUILTIN_PRESET_KEYS.has(key)) return key;

  const customId = key.startsWith('custom:') ? key.slice(7) : null;
  if (customId && customPresets.some((preset) => preset.id === customId)) {
    return key;
  }
  return DEFAULT_SELECTED_PRESET;
}

function normalizeHotkeys(value) {
  const input = value && typeof value === 'object' ? value : {};
  const hotkeys = {};
  for (const action of HOTKEY_ACTIONS) {
    hotkeys[action] = typeof input[action] === 'string' ? input[action] : DEFAULT_HOTKEYS[action];
  }
  return hotkeys;
}

function normalize(value = {}, { recordingsDirFallback } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const customPresets = normalizeCustomPresets(source.customPresets);
  const clipLimit = Number(source.clipBufferLimitMb);

  return {
    hotkeys: normalizeHotkeys(source.hotkeys),
    selectedPreset: normalizeSelectedPreset(source.selectedPreset, customPresets),
    customPresets,
    // Ad-hoc tweaks used to be discarded on restart because only the preset key was
    // persisted. The live profile is now saved alongside it.
    //
    // Deliberately left null when absent: a settings file written by an older version has
    // no profile, and substituting defaults there would silently override the user's
    // chosen preset on first launch.
    profile: source.profile && typeof source.profile === 'object'
      ? normalizeProfile(source.profile)
      : null,
    recordingsDir: paths.normalizeRecordingsDir(source.recordingsDir, recordingsDirFallback),
    // Recording writes a ready-to-play MP4 directly. This optional pass re-muxes it in
    // the background (never blocking the user) so the moov atom sits at the front.
    optimizeMp4: source.optimizeMp4 !== false,
    screenshotFormat: normalizeScreenshotFormat(source.screenshotFormat),
    screenshotQuality: normalizeScreenshotQuality(source.screenshotQuality),
    clipBufferLimitMb: clampNumber(
      Number.isFinite(clipLimit) ? clipLimit : DEFAULT_CLIP_BUFFER_LIMIT_MB,
      MIN_CLIP_BUFFER_LIMIT_MB,
      MAX_CLIP_BUFFER_LIMIT_MB
    )
  };
}

async function readJson(filePath) {
  let text;
  let tooLarge;
  let handle = null;
  try {
    handle = await fs.open(filePath, 'r');
    const stats = await handle.stat();
    tooLarge = stats.size > MAX_SETTINGS_BYTES;
    if (!tooLarge) text = await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null, recovery: null };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  try {
    if (tooLarge) throw new SyntaxError('설정 파일 크기가 허용 범위를 초과했습니다.');
    return { value: JSON.parse(text), recovery: null };
  } catch (error) {

    const extension = path.extname(filePath);
    const stem = path.basename(filePath, extension);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(
      path.dirname(filePath),
      `${stem}.corrupt-${stamp}-${crypto.randomUUID().slice(0, 8)}${extension || '.json'}`
    );
    try {
      await fs.rename(filePath, backupPath);
      return {
        value: null,
        recovery: { backupPath, error: error?.message || String(error) }
      };
    } catch (backupError) {
      return {
        value: null,
        recovery: {
          backupPath: null,
          error: error?.message || String(error),
          backupError: backupError?.message || String(backupError)
        }
      };
    }
  }
}

class SettingsStore {
  constructor() {
    this.current = normalize({});
    this.writeChain = Promise.resolve();
  }

  get value() {
    return this.current;
  }

  async load() {
    await paths.migrateLegacySettings();
    const loaded = await readJson(paths.settingsFile());
    const raw = loaded.value;
    const staged = normalize(raw || {});

    // Validate the configured folder before trusting it, so a missing drive downgrades
    // to a writable default instead of breaking startup.
    const resolved = await paths.resolveRecordingsDir(raw?.recordingsDir);
    this.current = normalize(
      { ...staged, recordingsDir: resolved.recordingsDir },
      { recordingsDirFallback: resolved.recordingsDir }
    );

    return {
      settings: this.current,
      recordingsDirFellBack: resolved.fellBack,
      recordingsDirFallbackReason: resolved.fallbackReason,
      requestedRecordingsDir: resolved.requestedDir,
      settingsRecovered: Boolean(loaded.recovery),
      settingsBackupPath: loaded.recovery?.backupPath || null,
      settingsRecoveryError: loaded.recovery?.error || null
    };
  }

  /** Merges a patch, normalizes the result, and persists it atomically. */
  update(patch = {}) {
    const run = async () => {
      const resolvedPatch = typeof patch === 'function' ? patch(this.current) : patch;
      const safePatch = resolvedPatch && typeof resolvedPatch === 'object' ? resolvedPatch : {};
      const next = normalize({ ...this.current, ...safePatch });
      await this.writeSnapshot(next);
      this.current = next;
      return this.current;
    };

    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  /**
   * Writes via a temp file + rename so an interrupted write cannot leave a truncated
   * settings file behind, and serializes writes so concurrent updates cannot interleave.
   */
  async writeSnapshot(snapshot) {
    const target = paths.settingsFile();
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.rename(temporary, target);
  }

  save() {
    const run = () => this.writeSnapshot(this.current);

    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  get recordingsDir() {
    return this.current.recordingsDir;
  }

  get tempDir() {
    return paths.tempDirFor(this.current.recordingsDir);
  }

  get screenshotsDir() {
    return paths.screenshotsDirFor(this.current.recordingsDir);
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  DEFAULT_PROFILE,
  DEFAULT_SELECTED_PRESET,
  BUILTIN_PRESET_KEYS,
  MAX_CUSTOM_PRESETS,
  DEFAULT_CLIP_BUFFER_LIMIT_MB,
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  SCREENSHOT_FORMATS,
  SCREENSHOT_QUALITIES,
  MIN_CLIP_BUFFER_LIMIT_MB,
  MAX_CLIP_BUFFER_LIMIT_MB,
  MAX_SETTINGS_BYTES,
  clampNumber,
  normalize,
  normalizeProfile,
  normalizeFormat,
  normalizeScreenshotFormat,
  normalizeScreenshotQuality,
  normalizeResolution,
  normalizeEncoderPreset,
  normalizeCustomPresets,
  normalizeSelectedPreset,
  sanitizePresetName,
  readJson
};
