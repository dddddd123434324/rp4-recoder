#!/usr/bin/env electron
'use strict';

/*
 * End-to-end test for the recording pipeline.
 *
 * Runs the real main-process modules against a temporary userData/recordings sandbox and
 * drives them with genuine MediaRecorder output from a hidden renderer. The headline
 * assertion is that stopping a recording completes almost instantly, because the file is
 * written in its final container rather than converted afterwards.
 *
 * Usage: npm run test:integration
 */

const { app, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ffmpegStatic = require('ffmpeg-static');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'rp4-itest-'));
const USER_DATA = path.join(SANDBOX, 'userData');
const RECORDINGS = path.join(SANDBOX, 'recordings');
fs.mkdirSync(USER_DATA, { recursive: true });

// Redirect every app path before the modules read it, so the test never touches the real
// configuration or recordings folder.
app.setPath('userData', USER_DATA);

const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function ffprobe(file) {
  return new Promise((resolve) => {
    execFile(
      ffmpegStatic,
      ['-hide_banner', '-i', file],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
      (_error, _stdout, stderr) => {
        const text = String(stderr || '');
        const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text);
        const start = /start:\s*(-?\d+\.\d+)/.exec(text);
        const video = /Stream #\d+:\d+.*Video:\s*([a-z0-9]+).*?(\d{2,5})x(\d{2,5})/i.exec(text);
        const audio = /Stream #\d+:\d+.*Audio:\s*([a-z0-9_]+)/i.exec(text);
        resolve({
          raw: text,
          // ffmpeg names the MP4 demuxer "mov,mp4,m4a,3gp,3g2,mj2", so keep the whole list.
          container: /Input #0,\s*([^\n]+?),\s*from/.exec(text)?.[1] || null,
          durationSec: duration
            ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
            : null,
          startSec: start ? Number(start[1]) : null,
          codec: video?.[1] || null,
          audioCodec: audio?.[1] || null,
          width: video ? Number(video[2]) : null,
          height: video ? Number(video[3]) : null
        });
      }
    );
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, ['-hide_banner', '-y', ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message)));
        return;
      }
      resolve();
    });
  });
}

/** Records a short clip in the renderer and returns the chunks as base64 strings. */
async function recordChunks(win, { seconds = 5, timeslice = 1000 }) {
  const summary = await win.webContents.executeJavaScript(`
    (async () => {
      const MIME = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4']
        .find((m) => MediaRecorder.isTypeSupported(m));
      if (!MIME) return JSON.stringify({ error: 'no mp4 support' });

      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d', { alpha: false });
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        ctx.fillStyle = 'hsl(' + (n * 11 % 360) + ',80%,45%)';
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 64px sans-serif';
        ctx.fillText('frame ' + n, 40, 120);
      }, 33);

      const stream = canvas.captureStream(30);
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 4000000 });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(${timeslice});
      await new Promise((r) => setTimeout(r, ${seconds * 1000}));
      rec.stop();
      await stopped;
      clearInterval(iv);
      stream.getTracks().forEach((t) => t.stop());

      window.__rp4chunks = chunks;
      window.__rp4take = async (i) => {
        const u8 = new Uint8Array(await chunks[i].arrayBuffer());
        let s = ''; const CH = 0x8000;
        for (let o = 0; o < u8.length; o += CH) s += String.fromCharCode.apply(null, u8.subarray(o, o + CH));
        return btoa(s);
      };
      return JSON.stringify({ mime: rec.mimeType || MIME, count: chunks.length, sizes: chunks.map((c) => c.size) });
    })()
  `);

  const info = JSON.parse(summary);
  if (info.error) throw new Error(info.error);

  const buffers = [];
  for (let i = 0; i < info.count; i += 1) {
    const b64 = await win.webContents.executeJavaScript(`window.__rp4take(${i})`);
    buffers.push(Buffer.from(b64, 'base64'));
  }
  return { mime: info.mime, sizes: info.sizes, buffers };
}

async function run() {
  const paths = require('../src/main/paths');
  const { SettingsStore, readJson, MAX_SETTINGS_BYTES } = require('../src/main/settings');
  const {
    RecordingManager,
    toBoundedBuffer,
    normalizeRecordingMeta,
    replaceFileSafely,
    MAX_INDEX_BYTES
  } = require('../src/main/recording');

  // ---- settings + path handling -------------------------------------------------
  const settings = new SettingsStore();
  await settings.load();
  // Automatic faststart jobs would race tests that deliberately construct recovery
  // artifacts. Optimization itself is exercised explicitly at the end of this suite.
  await settings.update({ recordingsDir: RECORDINGS, optimizeMp4: false });
  await paths.ensureRecordingDirs(settings.recordingsDir);

  check('settings persist to sandbox userData', fs.existsSync(paths.settingsFile()), paths.settingsFile());
  check('recordings dir is the configured one', settings.recordingsDir === RECORDINGS);
  check('temp + screenshot dirs created',
    fs.existsSync(settings.tempDir) && fs.existsSync(settings.screenshotsDir));

  // A settings file from an older version has no saved profile. Defaults must not be
  // substituted there, or the user's chosen preset would be overridden on first launch.
  const legacyShaped = require('../src/main/settings').normalize({
    selectedPreset: 'game',
    hotkeys: { recordToggle: 'Alt+F9' }
  });
  check('legacy settings keep their selected preset', legacyShaped.selectedPreset === 'game');
  check('legacy settings have no substituted profile', legacyShaped.profile === null);
  check('legacy hotkeys survive normalization', legacyShaped.hotkeys.recordToggle === 'Alt+F9');
  check('missing hotkeys fall back to defaults',
    legacyShaped.hotkeys.clipSave === 'CommandOrControl+Shift+V');

  await settings.update({ profile: { resolution: '1280x720', fps: '30' } });
  check('saved profile round-trips', settings.value.profile?.resolution === '1280x720',
    JSON.stringify(settings.value.profile));
  check('profile values are clamped',
    require('../src/main/settings').normalize({ profile: { fps: '9999', bitrate: '-4' } })
      .profile.fps === '240');
  await settings.update({
    selectedPreset: null,
    profile: { resolution: '2560x1440', fps: '120', bitrate: '24' }
  });
  check('profile and inactive preset persist atomically',
    settings.value.selectedPreset === null
      && settings.value.profile?.resolution === '2560x1440'
      && settings.value.profile?.fps === '120');

  await Promise.all(['atomic-a', 'atomic-b'].map((id) => settings.update((current) => ({
    customPresets: [{ id, name: id, profile: {} }, ...current.customPresets]
  }))));
  check('functional settings updates do not lose concurrent preset changes',
    ['atomic-a', 'atomic-b'].every((id) => settings.value.customPresets.some((item) => item.id === id)));

  const safeMeta = normalizeRecordingMeta({
    mode: 'screen',
    sourceName: 'x'.repeat(1000),
    width: 999999,
    requestedSystemAudio: true,
    unknownHugeField: 'y'.repeat(10000)
  });
  check('recording metadata uses an allowlist and bounds',
    safeMeta.sourceName.length === 160
      && safeMeta.width === 16384
      && safeMeta.requestedSystemAudio === true
      && !Object.hasOwn(safeMeta, 'unknownHugeField'));

  const replaceOriginal = path.join(SANDBOX, 'replace-original.bin');
  const replaceCandidate = path.join(SANDBOX, 'replace-candidate.bin');
  await fsp.writeFile(replaceOriginal, 'known-good');
  await fsp.writeFile(replaceCandidate, 'invalid-new');
  let replacementRejected = false;
  try {
    await replaceFileSafely(replaceOriginal, replaceCandidate, {
      validate: async () => { throw new Error('invalid media'); }
    });
  } catch {
    replacementRejected = true;
  }
  check('failed replacement validation restores the original',
    replacementRejected && await fsp.readFile(replaceOriginal, 'utf8') === 'known-good');

  // A drive root must never be accepted as a recordings folder.
  check('drive root rejected as recordings dir', paths.isPlausibleRecordingsDir('D:\\') === false);
  check('relative path rejected as recordings dir', paths.isPlausibleRecordingsDir('recordings') === false);
  check('path containment allows nested file',
    paths.isInside(RECORDINGS, path.join(RECORDINGS, 'a', 'b.mp4')) === true);
  check('path containment blocks traversal',
    paths.isInside(RECORDINGS, path.join(RECORDINGS, '..', 'secret.mp4')) === false);
  check('bounded binary validation accepts typed arrays',
    toBoundedBuffer(new Uint8Array([1, 2]), 2).length === 2);
  let oversizedBinaryRejected = false;
  try {
    toBoundedBuffer(new Uint8Array([1, 2, 3]), 2);
  } catch {
    oversizedBinaryRejected = true;
  }
  check('bounded binary validation rejects before copying', oversizedBinaryRejected);

  const settingsSnapshot = await fsp.readFile(paths.settingsFile());
  await fsp.truncate(paths.settingsFile(), MAX_SETTINGS_BYTES + 1);
  const oversizedSettings = await readJson(paths.settingsFile());
  check('oversized settings file is backed up without parsing',
    oversizedSettings.value === null && Boolean(oversizedSettings.recovery?.backupPath));
  await fsp.writeFile(paths.settingsFile(), settingsSnapshot);

  for (const conflict of ['foreign-temp', 'temp-file', 'screenshots-file']) {
    const root = path.join(SANDBOX, conflict);
    await fsp.mkdir(root, { recursive: true });
    if (conflict === 'foreign-temp') {
      await fsp.mkdir(path.join(root, paths.TEMP_DIR_NAME));
    } else if (conflict === 'temp-file') {
      await fsp.writeFile(path.join(root, paths.TEMP_DIR_NAME), 'not a directory');
    } else {
      await fsp.writeFile(path.join(root, paths.SCREENSHOTS_DIR_NAME), 'not a directory');
    }
    let rejected = false;
    try {
      await paths.ensureRecordingDirs(root);
    } catch {
      rejected = true;
    }
    check(`${conflict} recording folder conflict is rejected`, rejected);
    check(`${conflict} failure does not change saved recording path`,
      settings.recordingsDir === RECORDINGS);
  }

  const displayPayload = require('../src/main/displays').getDisplayPayload();
  const horizontalPair = displayPayload.displays
    .flatMap((left) => displayPayload.displays.map((right) => ({ left, right })))
    .find(({ left, right }) => (
      left.id !== right.id
      && left.bounds.x + left.bounds.width === right.bounds.x
      && Math.max(left.bounds.y, right.bounds.y)
        + 32 <= Math.min(left.bounds.y + left.bounds.height, right.bounds.y + right.bounds.height)
    ));
  if (horizontalPair) {
    const boundary = horizontalPair.right.bounds.x;
    const y = Math.max(horizontalPair.left.bounds.y, horizontalPair.right.bounds.y) + 16;
    check('cross-monitor area selection is rejected',
      require('../src/main/displays').normalizeDesktopArea({ x: boundary - 16, y, width: 32, height: 32 })
        === null);
  }

  const oversizedIndexPath = path.join(USER_DATA, 'recordings-index.json');
  await fsp.writeFile(oversizedIndexPath, 'x');
  await fsp.truncate(oversizedIndexPath, MAX_INDEX_BYTES + 1);
  const recordings = new RecordingManager({ settings, emit: () => {} });
  const oversizedIndex = await recordings.loadIndex();
  check('oversized recording index is backed up without parsing',
    oversizedIndex.recovered && Boolean(oversizedIndex.backupPath));

  // A stale crop host must never satisfy or clear a request belonging to its successor.
  const { WindowCropService } = require('../src/main/window-crop');
  const cropService = new WindowCropService();
  const staleChild = {};
  const currentChild = {};
  cropService.unsupported = false;
  cropService.child = currentChild;
  cropService.generation = 2;
  let cropResolved = false;
  const cropResult = new Promise((resolve) => {
    cropService.pending.set('q-test', {
      child: currentChild,
      generation: 2,
      timer: setTimeout(() => resolve(null), 1000),
      resolve: (value) => {
        cropResolved = true;
        resolve(value);
      }
    });
  });
  cropService.handleLine(staleChild, 1, 'RP4:q-test:null');
  check('stale crop host response is ignored', !cropResolved && cropService.pending.has('q-test'));
  cropService.handleLine(currentChild, 2, 'RP4:q-test:{"x":1,"y":2,"width":3,"height":4}');
  check('current crop host owns its response', (await cropResult)?.width === 3);
  cropService.child = null;

  const pipeFailureService = new WindowCropService();
  const pipeChild = new EventEmitter();
  pipeChild.killed = false;
  pipeChild.kill = () => { pipeChild.killed = true; };
  pipeChild.stdin = new EventEmitter();
  pipeChild.stdin.writable = true;
  pipeChild.stdin.write = (_value, callback) => setImmediate(() => callback(new Error('EPIPE')));
  pipeFailureService.unsupported = false;
  pipeFailureService.child = pipeChild;
  pipeFailureService.generation = 7;
  pipeFailureService.ensureHost = async () => pipeChild;
  const pipeFailureResult = await pipeFailureService.query('1234');
  check('window crop pipe failure resolves safely', pipeFailureResult === null && pipeChild.killed);

  // Main waits for an explicit renderer ACK even before a recording session exists.
  const fakeContents = new EventEmitter();
  fakeContents.send = (channel, payload) => {
    if (channel === 'app:finalize-recordings') {
      const emitAck = (eventName, progress = undefined) => require('electron').ipcMain.emit(
        eventName, { sender: fakeContents }, { requestId: payload.requestId, progress }
      );
      setImmediate(() => emitAck('app:shutdown-accepted'));
      setTimeout(() => emitAck('app:shutdown-progress', { phase: 'write', completedBytes: 1 }), 30);
      setTimeout(() => emitAck('app:shutdown-progress', { phase: 'write', completedBytes: 2 }), 65);
      setTimeout(() => emitAck('app:shutdown-ready'), 100);
    }
  };
  const fakeWindow = { isDestroyed: () => false, webContents: fakeContents };
  let shutdownOptions = null;
  const fakeRecordings = {
    hasActiveSessions: () => false,
    hasPendingRecordings: () => false,
    finalizeAllSessions: async (options) => {
      shutdownOptions = options;
      return [];
    }
  };
  const shutdownStartedAt = Date.now();
  const drained = await require('../src/main/windows').drainRecordings(
    fakeWindow,
    fakeRecordings,
    { timeoutMs: 50 }
  );
  check('shutdown heartbeat extends the inactivity deadline',
    drained.rendererAccepted === true
      && drained.rendererReady === true
      && drained.timedOut === false
      && shutdownOptions.failureReason === null
      && Date.now() - shutdownStartedAt >= 90);

  const hardLimitContents = new EventEmitter();
  let hardLimitHeartbeat = null;
  hardLimitContents.send = (channel, payload) => {
    if (channel !== 'app:finalize-recordings') return;
    require('electron').ipcMain.emit(
      'app:shutdown-accepted', { sender: hardLimitContents }, { requestId: payload.requestId }
    );
    let completedBytes = 0;
    hardLimitHeartbeat = setInterval(() => {
      completedBytes += 1;
      require('electron').ipcMain.emit(
        'app:shutdown-progress',
        { sender: hardLimitContents },
        { requestId: payload.requestId, progress: { phase: 'stuck', completedBytes } }
      );
    }, 15);
  };
  const hardLimitStartedAt = Date.now();
  const hardLimited = await require('../src/main/windows').drainRecordings(
    { isDestroyed: () => false, webContents: hardLimitContents },
    fakeRecordings,
    { timeoutMs: 40, maxTotalMs: 80 }
  );
  clearInterval(hardLimitHeartbeat);
  check('shutdown hard deadline cannot be extended by heartbeat',
    hardLimited.timedOut === true && Date.now() - hardLimitStartedAt < 180);

  const failedContents = new EventEmitter();
  failedContents.send = (channel, payload) => {
    if (channel !== 'app:finalize-recordings') return;
    setImmediate(() => require('electron').ipcMain.emit(
      'app:shutdown-failed',
      { sender: failedContents },
      { requestId: payload.requestId, error: 'simulated clip save failure' }
    ));
  };
  let failedFinalizeCalls = 0;
  const failedDrain = await require('../src/main/windows').drainRecordings(
    { isDestroyed: () => false, webContents: failedContents },
    {
      hasActiveSessions: () => false,
      hasPendingRecordings: () => false,
      finalizeAllSessions: async () => { failedFinalizeCalls += 1; return []; }
    },
    { timeoutMs: 100 }
  );
  check('clip save failure aborts shutdown before forced finalization',
    failedDrain.shutdownFailed === true
      && /simulated/.test(failedDrain.error)
      && failedFinalizeCalls === 0);

  let closeAttempts = 0;
  const closeFailureSession = {
    handleClosed: false,
    failed: null,
    handle: { close: async () => { closeAttempts += 1; throw new Error('simulated EIO'); } }
  };
  await recordings.closeSessionHandle(closeFailureSession);
  await recordings.closeSessionHandle(closeFailureSession);
  check('unexpected recording close error becomes a single partial-save failure',
    closeAttempts === 1 && /simulated EIO/.test(closeFailureSession.failed));

  // ---- capture real MediaRecorder output ----------------------------------------
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false }
  });
  const page = path.join(SANDBOX, 'page.html');
  fs.writeFileSync(page, '<!doctype html><html><body>itest</body></html>', 'utf8');
  await win.loadFile(page);

  const recorded = await recordChunks(win, { seconds: 5, timeslice: 1000 });
  check('renderer produced MP4 chunks', recorded.buffers.length >= 2,
    `${recorded.buffers.length} chunks, mime=${recorded.mime}`);
  check('first chunk is a small init segment', recorded.sizes[0] < recorded.sizes[1],
    `init=${recorded.sizes[0]}B media=${recorded.sizes[1]}B`);

  // ---- normal recording: stop must be effectively instant -----------------------
  const meta = {
    mode: 'screen',
    modeLabel: '전체 화면',
    sourceName: '테스트 소스',
    format: 'mp4',
    mimeType: recorded.mime,
    width: 1280,
    height: 720,
    fps: 30,
    bitrateMbps: 4,
    audioBitrateKbps: 192,
    encoderPreset: 'veryfast'
  };

  const session = await recordings.start(meta, { webContentsId: win.webContents.id });
  check('recording writes straight to the target container', session.directToTarget === true,
    `container=${session.recordedContainer} codec=${session.recordedCodec}`);

  let written = 0;
  for (const buffer of recorded.buffers) {
    const result = await recordings.write(
      { sessionId: session.sessionId, buffer },
      { webContentsId: win.webContents.id }
    );
    written = result.bytes;
  }
  check('all bytes streamed to disk',
    written === recorded.buffers.reduce((sum, b) => sum + b.length, 0), `${written} bytes`);

  // Another renderer must not be able to write into someone else's session.
  let ownershipEnforced = false;
  try {
    await recordings.write(
      { sessionId: session.sessionId, buffer: Buffer.from([1, 2, 3]) },
      { webContentsId: win.webContents.id + 999 }
    );
  } catch {
    ownershipEnforced = true;
  }
  check('session rejects writes from another renderer', ownershipEnforced);
  let duplicateSessionRejected = false;
  try {
    await recordings.start(meta, { webContentsId: win.webContents.id });
  } catch {
    duplicateSessionRejected = true;
  }
  check('renderer cannot exhaust handles with duplicate sessions', duplicateSessionRejected);

  const stopStarted = Date.now();
  const saved = await recordings.stop({ sessionId: session.sessionId, durationMs: 5000 });
  const stopMs = Date.now() - stopStarted;

  check('stop returned a saved recording', Boolean(saved), saved?.name);
  check('saved file is .mp4', saved?.name?.toLowerCase().endsWith('.mp4') === true, saved?.name);
  check('no conversion was performed', saved?.converted === false);
  // The whole point of the change: stopping is a close plus a rename.
  check('stop completes in under 250 ms', stopMs < 250, `${stopMs} ms`);

  const probe = await ffprobe(saved.filePath);
  check('saved file is readable H.264 MP4',
    probe.codec === 'h264' && /\bmp4\b/.test(probe.container || ''),
    `container=${probe.container} codec=${probe.codec} ${probe.width}x${probe.height}`);
  check('saved file reports a real duration', (probe.durationSec || 0) > 3,
    `${probe.durationSec}s`);
  check('reported duration excludes nothing unexpected',
    Math.abs((probe.durationSec || 0) - 5) < 1.5, `${probe.durationSec}s vs 5s`);

  const invalidSession = await recordings.start(meta, { webContentsId: win.webContents.id });
  await recordings.write({
    sessionId: invalidSession.sessionId,
    buffer: Buffer.alloc(4096, 0xaa)
  }, { webContentsId: win.webContents.id });
  const invalidSaved = await recordings.stop({
    sessionId: invalidSession.sessionId,
    durationMs: 1000
  }, { webContentsId: win.webContents.id });
  const invalidDeadline = Date.now() + 5000;
  while (recordings.metadata.get(invalidSaved.filePath)?.status === 'verifying'
    && Date.now() < invalidDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check('invalid direct recording is not classified complete',
    recordings.metadata.get(invalidSaved.filePath)?.status === 'invalid');

  recordings.optimizeQueue.push({ filePath: 'pending-test.mp4', durationMs: 1 });
  check('pending optimization blocks recording-folder mutation', recordings.hasPendingFileMutations());
  recordings.optimizeQueue.pop();

  const concurrentStarts = await Promise.allSettled([
    recordings.start(meta, { webContentsId: win.webContents.id }),
    recordings.start(meta, { webContentsId: win.webContents.id })
  ]);
  const concurrentSuccesses = concurrentStarts.filter((result) => result.status === 'fulfilled');
  check('simultaneous starts reserve the renderer atomically',
    concurrentSuccesses.length === 1 && concurrentStarts.filter((result) => result.status === 'rejected').length === 1);
  if (concurrentSuccesses[0]) {
    await recordings.stop({ sessionId: concurrentSuccesses[0].value.sessionId });
  }

  // ---- unique file names --------------------------------------------------------
  const first = await recordings.start(meta, { webContentsId: win.webContents.id });
  await recordings.write({ sessionId: first.sessionId, buffer: recorded.buffers[0] },
    { webContentsId: win.webContents.id });
  await recordings.write({ sessionId: first.sessionId, buffer: recorded.buffers[1] },
    { webContentsId: win.webContents.id });
  const savedA = await recordings.stop({ sessionId: first.sessionId, durationMs: 1000 });

  const second = await recordings.start(meta, { webContentsId: win.webContents.id });
  await recordings.write({ sessionId: second.sessionId, buffer: recorded.buffers[0] },
    { webContentsId: win.webContents.id });
  await recordings.write({ sessionId: second.sessionId, buffer: recorded.buffers[1] },
    { webContentsId: win.webContents.id });
  const savedB = await recordings.stop({ sessionId: second.sessionId, durationMs: 1000 });

  check('same-second recordings get distinct files',
    Boolean(savedA && savedB) && savedA.filePath !== savedB.filePath,
    `${savedA?.name} vs ${savedB?.name}`);
  check('both same-second files still exist',
    fs.existsSync(savedA.filePath) && fs.existsSync(savedB.filePath));

  // Main-process ordering must remain correct even when callers do not await each write
  // before asking to stop the session.
  const raced = await recordings.start(meta, { webContentsId: win.webContents.id });
  const racedWrites = recorded.buffers.map((buffer) => recordings.write(
    { sessionId: raced.sessionId, buffer },
    { webContentsId: win.webContents.id }
  ));
  const racedStop = recordings.stop({ sessionId: raced.sessionId, durationMs: 5000 }, {
    webContentsId: win.webContents.id
  });
  await Promise.all(racedWrites);
  const racedSaved = await racedStop;
  const racedProbe = await ffprobe(racedSaved.filePath);
  check('concurrent writes finish before stop closes the file',
    racedProbe.codec === 'h264' && (racedProbe.durationSec || 0) > 3,
    `codec=${racedProbe.codec} duration=${racedProbe.durationSec}s`);

  // Once a session is marked failed, ordinary writes stop but the terminal
  // dataavailable Blob is still accepted as a best-effort salvage.
  const failedSession = await recordings.start(meta, { webContentsId: win.webContents.id });
  await recordings.write({ sessionId: failedSession.sessionId, buffer: recorded.buffers[0] },
    { webContentsId: win.webContents.id });
  recordings.sessions.get(failedSession.sessionId).failed = 'simulated recording failure';
  let failedWriteRejected = false;
  try {
    await recordings.write({ sessionId: failedSession.sessionId, buffer: recorded.buffers[1] },
      { webContentsId: win.webContents.id });
  } catch {
    failedWriteRejected = true;
  }
  const terminalWrite = await recordings.write({
    sessionId: failedSession.sessionId,
    buffer: recorded.buffers[1],
    terminal: true
  }, { webContentsId: win.webContents.id });
  const failedSaved = await recordings.stop({ sessionId: failedSession.sessionId, durationMs: 1000 });
  check('failed session rejects non-terminal writes', failedWriteRejected);
  check('failed session preserves terminal chunk',
    terminalWrite.bytes === recorded.buffers[0].length + recorded.buffers[1].length
      && failedSaved?.status === 'partial');

  const boundedRecordings = new RecordingManager({
    settings,
    emit: () => {},
    maxSessionQueuedBytes: 1024
  });
  const bounded = await boundedRecordings.start(meta, { webContentsId: win.webContents.id + 500 });
  const boundedSession = boundedRecordings.sessions.get(bounded.sessionId);
  const originalBoundedWrite = boundedSession.handle.write.bind(boundedSession.handle);
  let releaseBoundedWrite;
  boundedSession.handle.write = (...args) => new Promise((resolve, reject) => {
    releaseBoundedWrite = () => originalBoundedWrite(...args).then(resolve, reject);
  });
  const queuedWrite = boundedRecordings.write({
    sessionId: bounded.sessionId,
    buffer: Buffer.alloc(800, 0x11)
  }, { webContentsId: win.webContents.id + 500 });
  await new Promise((resolve) => setImmediate(resolve));
  let queueLimitRejected = false;
  try {
    await boundedRecordings.write({
      sessionId: bounded.sessionId,
      buffer: Buffer.alloc(800, 0x22)
    }, { webContentsId: win.webContents.id + 500 });
  } catch {
    queueLimitRejected = true;
  }
  releaseBoundedWrite();
  await queuedWrite;
  await boundedRecordings.stop({ sessionId: bounded.sessionId }, {
    webContentsId: win.webContents.id + 500
  });
  check('main recording queue enforces a total byte limit', queueLimitRejected);

  // Chromium may fall back to Matroska H.264 + Opus. MP4 keeps the video bitstream but
  // must convert Opus audio to AAC for broad player compatibility.
  const opusInput = path.join(SANDBOX, 'h264-opus.mkv');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '1.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus',
    opusInput
  ]);
  const fallbackMeta = {
    ...meta,
    mimeType: 'video/x-matroska;codecs=avc1,opus',
    width: 320,
    height: 180
  };
  const fallbackSession = await recordings.start(fallbackMeta, { webContentsId: win.webContents.id });
  await recordings.write({
    sessionId: fallbackSession.sessionId,
    buffer: await fsp.readFile(opusInput)
  }, { webContentsId: win.webContents.id });
  const fallbackSaved = await recordings.stop({
    sessionId: fallbackSession.sessionId,
    durationMs: 1200
  });
  const fallbackProbe = await ffprobe(fallbackSaved.filePath);
  check('H.264 Opus fallback becomes H.264 AAC MP4',
    fallbackProbe.codec === 'h264'
      && fallbackProbe.audioCodec === 'aac'
      && /\bmp4\b/.test(fallbackProbe.container || ''),
    `video=${fallbackProbe.codec} audio=${fallbackProbe.audioCodec} container=${fallbackProbe.container}`);

  // ---- clip mode: init segment + suffix of fragments ----------------------------
  const clipBuffers = [
    recorded.buffers[0],
    ...recorded.buffers.slice(Math.max(1, recorded.buffers.length - 2))
  ];
  const clipStarted = Date.now();
  const clipMeta = {
    ...meta,
    modeLabel: '전체 화면 클립',
    durationMs: 2000,
    trimRecentMs: 2000,
    trimEndOffsetMs: 0,
    clip: true
  };
  const clipSession = await recordings.start(clipMeta, { webContentsId: win.webContents.id });
  for (const buffer of clipBuffers) {
    await recordings.write({ sessionId: clipSession.sessionId, buffer }, {
      webContentsId: win.webContents.id
    });
  }
  const clip = await recordings.stop({
    sessionId: clipSession.sessionId,
    durationMs: 2000,
    meta: clipMeta
  }, {
    webContentsId: win.webContents.id
  });
  const clipMs = Date.now() - clipStarted;

  check('clip saved', Boolean(clip), `${clip?.name} in ${clipMs} ms`);
  check('clip is .mp4', clip?.name?.toLowerCase().endsWith('.mp4') === true);
  const clipProbe = await ffprobe(clip.filePath);
  check('clip is decodable H.264', clipProbe.codec === 'h264', `codec=${clipProbe.codec}`);
  // The stream copy exists to normalize a spliced clip back to a zero start time.
  check('clip starts at zero after normalization', (clipProbe.startSec ?? 1) < 0.1,
    `start=${clipProbe.startSec}`);
  check('clip save stays fast', clipMs < 5000, `${clipMs} ms`);

  const secondEpoch = await recordChunks(win, { seconds: 3, timeslice: 1000 });
  const segmentedMeta = {
    ...clipMeta,
    durationMs: 8000,
    trimRecentMs: 8000,
    segmentedClip: true
  };
  const segmentedSession = await recordings.start(segmentedMeta, {
    webContentsId: win.webContents.id
  });
  for (const buffer of recorded.buffers) {
    await recordings.write({ sessionId: segmentedSession.sessionId, segmentIndex: 0, buffer }, {
      webContentsId: win.webContents.id
    });
  }
  for (const buffer of secondEpoch.buffers) {
    await recordings.write({ sessionId: segmentedSession.sessionId, segmentIndex: 1, buffer }, {
      webContentsId: win.webContents.id
    });
  }
  const segmentedClip = await recordings.stop({
    sessionId: segmentedSession.sessionId,
    durationMs: 8000,
    meta: segmentedMeta
  }, { webContentsId: win.webContents.id });
  const segmentedProbe = await ffprobe(segmentedClip.filePath);
  check('rolling clip epochs concatenate into one decodable clip',
    segmentedProbe.codec === 'h264' && (segmentedProbe.durationSec || 0) > 6,
    `codec=${segmentedProbe.codec} duration=${segmentedProbe.durationSec}s`);

  const genericMeta = { ...clipMeta, mimeType: 'video/mp4' };
  const genericSession = await recordings.start(genericMeta, { webContentsId: win.webContents.id });
  for (const buffer of recorded.buffers) {
    await recordings.write({ sessionId: genericSession.sessionId, buffer }, {
      webContentsId: win.webContents.id
    });
  }
  const genericClip = await recordings.stop({
    sessionId: genericSession.sessionId,
    durationMs: 2000,
    meta: genericMeta
  }, { webContentsId: win.webContents.id });
  const genericProbe = await ffprobe(genericClip.filePath);
  check('generic video/mp4 H.264 clip remains lossless and decodable',
    genericProbe.codec === 'h264' && (genericProbe.durationSec || 0) > 1,
    `codec=${genericProbe.codec} duration=${genericProbe.durationSec}s`);

  // Recovery artifacts have strict app-generated names. User recordings that merely
  // contain ".backup-" must never be deleted or renamed.
  const userBackupName = path.join(RECORDINGS, 'normal.backup-user.mp4');
  await fsp.copyFile(saved.filePath, userBackupName);
  const recoveryUuid = crypto.randomUUID();
  const trueBackup = path.join(RECORDINGS, `restored.mp4.backup-${recoveryUuid}`);
  const restoredTarget = path.join(RECORDINGS, 'restored.mp4');
  await fsp.copyFile(saved.filePath, trueBackup);
  const reconciliation = await recordings.reconcileRecordingsDir();
  check('ordinary backup-like recording name is preserved', fs.existsSync(userBackupName));
  check('only UUID-suffixed optimization backup is restored',
    reconciliation.restored === 1 && fs.existsSync(restoredTarget) && !fs.existsSync(trueBackup));
  const ordinaryOptimizingName = path.join(RECORDINGS, 'user-video.mp4.optimizing.mp4');
  await fsp.copyFile(saved.filePath, ordinaryOptimizingName);
  const reconciliation2 = await recordings.reconcileRecordingsDir();
  check('ordinary optimizing-like recording name is preserved',
    reconciliation2.removed === 0 && reconciliation2.restored === 0
      && fs.existsSync(ordinaryOptimizingName));

  // ---- metadata survives a restart ---------------------------------------------
  const revived = new RecordingManager({ settings, emit: () => {} });
  await revived.loadIndex();
  const listed = await revived.list();
  const match = listed.find((item) => item.filePath === saved.filePath);
  check('recording index persists metadata across restart',
    Boolean(match) && match.durationMs > 0 && match.width === 1280,
    `duration=${match?.durationMs} ${match?.width}x${match?.height}`);
  await revived.setMetadata(saved.filePath, {
    ...revived.metadata.get(saved.filePath),
    status: 'verifying'
  });
  const resumed = new RecordingManager({ settings, emit: () => {} });
  await resumed.loadIndex();
  const resumedCount = await resumed.resumePendingMediaJobs();
  const resumeDeadline = Date.now() + 5000;
  while (resumed.metadata.get(saved.filePath)?.status === 'verifying'
    && Date.now() < resumeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check('verifying media resumes validation after restart',
    resumedCount === 1 && resumed.metadata.get(saved.filePath)?.status === 'complete');
  const thumbnail = await revived.thumbnail(saved.filePath);
  check('recent recording thumbnail is generated',
    typeof thumbnail === 'string' && thumbnail.startsWith('data:image/jpeg;base64,'));
  const oldFolderMetadata = path.join(`${RECORDINGS}-old`, 'old.mp4');
  recordings.metadata.set(oldFolderMetadata, { durationMs: 1234 });
  await recordings.list();
  check('listing current folder keeps similarly prefixed folder metadata',
    recordings.metadata.has(oldFolderMetadata));

  const { resolveRecordingMediaFile } = require('../src/main/ipc');
  check('owned top-level media file passes IPC validation',
    await resolveRecordingMediaFile(RECORDINGS, saved.filePath) === await fsp.realpath(saved.filePath));
  const executable = path.join(RECORDINGS, 'not-a-recording.exe');
  await fsp.writeFile(executable, Buffer.from('MZ'));
  check('non-media file is rejected by IPC validation',
    await resolveRecordingMediaFile(RECORDINGS, executable) === null);
  const nestedDir = path.join(RECORDINGS, 'nested');
  await fsp.mkdir(nestedDir, { recursive: true });
  const nestedMedia = path.join(nestedDir, 'nested.mp4');
  await fsp.copyFile(saved.filePath, nestedMedia);
  check('nested media file is rejected by IPC validation',
    await resolveRecordingMediaFile(RECORDINGS, nestedMedia) === null);

  // ---- orphaned temp files are recovered, not lost ------------------------------
  const orphan = path.join(settings.tempDir, `rp4-${crypto.randomUUID()}.part.mp4`);
  await fsp.writeFile(orphan, Buffer.concat([recorded.buffers[0], recorded.buffers[1]]));
  const sweep = await recordings.sweepTempDir();
  check('orphaned temp recording is recovered', sweep.recovered.length === 1,
    sweep.recovered[0] ? path.basename(sweep.recovered[0]) : 'none');
  check('recovered file left the temp folder', !fs.existsSync(orphan));

  const corruptOrphan = path.join(settings.tempDir, `rp4-${crypto.randomUUID()}.part.mp4`);
  await fsp.writeFile(corruptOrphan, Buffer.alloc(2048, 0xaa));
  const corruptSweep = await recordings.sweepTempDir();
  const corruptRecovered = corruptSweep.recovered[0];
  const corruptMeta = corruptRecovered ? recordings.metadata.get(corruptRecovered) : null;
  check('invalid orphan is preserved and explicitly classified partial',
    Boolean(corruptRecovered)
      && !fs.existsSync(corruptOrphan)
      && corruptMeta?.status === 'partial'
      && corruptMeta?.outcome === 'recovered-partial');

  const tiny = path.join(settings.tempDir, `rp4-${crypto.randomUUID()}.part.mp4`);
  await fsp.writeFile(tiny, Buffer.alloc(128));
  const unrelated = path.join(settings.tempDir, 'another-program.tmp');
  const unrelatedDir = path.join(settings.tempDir, 'another-program-cache');
  await fsp.writeFile(unrelated, Buffer.alloc(16));
  await fsp.mkdir(unrelatedDir);
  const sweep2 = await recordings.sweepTempDir();
  check('worthless temp scraps are cleaned up',
    sweep2.removed === 1 && !fs.existsSync(tiny));
  check('unrelated temp file is preserved', fs.existsSync(unrelated));
  check('unrelated temp directory is preserved', fs.existsSync(unrelatedDir));

  // ---- screenshots get unique names --------------------------------------------
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000a49444154789c6300010000050001',
    'hex'
  );
  const shotA = await recordings.saveScreenshot({ buffer: png });
  const shotB = await recordings.saveScreenshot({ buffer: png });
  check('screenshots in the same second do not overwrite',
    shotA.filePath !== shotB.filePath && fs.existsSync(shotA.filePath) && fs.existsSync(shotB.filePath),
    `${shotA.fileName} / ${shotB.fileName}`);
  check('screenshot writes leave no partial files',
    fs.readdirSync(settings.screenshotsDir).every((name) => !name.endsWith('.part')));

  const originalScreenshotWriter = recordings.performSaveScreenshot.bind(recordings);
  let releaseScreenshot;
  recordings.performSaveScreenshot = () => new Promise((resolve) => { releaseScreenshot = resolve; });
  const pendingScreenshot = recordings.saveScreenshot({ buffer: png });
  check('pending screenshot participates in shutdown state', recordings.hasPendingRecordings());
  releaseScreenshot({ filePath: shotA.filePath, fileName: shotA.fileName });
  await pendingScreenshot;
  recordings.performSaveScreenshot = originalScreenshotWriter;
  check('completed screenshot releases shutdown state', !recordings.hasPendingRecordings());

  // ---- background optimization never destroys the file -------------------------
  recordings.enqueueOptimize(saved.filePath, 5000);
  const optimizeDeadline = Date.now() + 20000;
  while ((recordings.optimizing || recordings.optimizeQueue.length > 0) && Date.now() < optimizeDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const afterOptimize = await ffprobe(saved.filePath);
  check('file still valid after background optimization',
    afterOptimize.codec === 'h264' && (afterOptimize.durationSec || 0) > 3,
    `codec=${afterOptimize.codec} duration=${afterOptimize.durationSec}s`);
  check('no .optimizing leftovers',
    fs.readdirSync(RECORDINGS).every((f) => (
      !/\.optimizing-[0-9a-f-]{36}\.mp4$/i.test(f)
    )));

  win.destroy();
}

app.whenReady().then(async () => {
  let fatal = null;
  try {
    await run();
  } catch (error) {
    fatal = error;
    process.stdout.write(`FATAL ${error?.stack || error}\n`);
  }

  const passed = results.filter((r) => r.passed).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);

  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    // The OS will clean the temp directory eventually.
  }

  app.exit(failures > 0 || fatal ? 1 : 0);
});
