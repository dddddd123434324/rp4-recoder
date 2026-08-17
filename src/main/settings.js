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

// Clip mode keeps recent footage buffered. Without a byte ceiling a 7200s buffer at
// 35 Mbps would try to hold ~31 GB, so the buffer is bounded in megabytes as well as
// seconds and the tighter of the two wins.
const DEFAULT_CLIP_BUFFER_LIMIT_MB = 256;
const MIN_CLIP_BUFFER_LIMIT_MB = 64;
const MAX_CLIP_BUFFER_LIMIT_MB = 512;

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

function normalizeProfile(value = {}) {
  const profile = value && typeof value === 'object' ? value : {};
  const micVolume = Number(profile.micVolume);
  const systemVolume = Number(profile.systemVolume);

  return {
    format: normalizeFormat(profile.format),
    resolution: /^\d{3,5}x\d{3,5}$/.test(String(profile.resolution || ''))
      ? String(profile.resolution)
      : DEFAULT_PROFILE.resolution,
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
    clipBufferLimitMb: clampNumber(
      Number.isFinite(clipLimit) ? clipLimit : DEFAULT_CLIP_BUFFER_LIMIT_MB,
      MIN_CLIP_BUFFER_LIMIT_MB,
      MAX_CLIP_BUFFER_LIMIT_MB
    )
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
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
    const raw = await readJson(paths.settingsFile());
    const staged = normalize(raw || {});

    // Validate the configured folder before trusting it, so a missing drive downgrades
    // to a writable default instead of breaking startup.
    const resolved = await paths.resolveRecordingsDir(staged.recordingsDir);
    this.current = normalize(
      { ...staged, recordingsDir: resolved.recordingsDir },
      { recordingsDirFallback: resolved.recordingsDir }
    );

    return { settings: this.current, recordingsDirFellBack: resolved.fellBack };
  }

  /** Merges a patch, normalizes the result, and persists it. */
  update(patch = {}) {
    const run = async () => {
      const next = normalize({ ...this.current, ...patch });
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
    const snapshot = this.current;
    const run = () => this.writeSnapshot(snapshot);

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
  MIN_CLIP_BUFFER_LIMIT_MB,
  MAX_CLIP_BUFFER_LIMIT_MB,
  clampNumber,
  normalize,
  normalizeProfile,
  normalizeFormat,
  normalizeEncoderPreset,
  normalizeCustomPresets,
  normalizeSelectedPreset,
  sanitizePresetName
};
