'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ffmpegStaticPath = require('ffmpeg-static');

/**
 * Inside a packaged app the binary lives in app.asar.unpacked (see `asarUnpack` in
 * package.json); ffmpeg-static still reports the in-archive path.
 */
function resolveExecutable() {
  if (!ffmpegStaticPath) return null;
  return String(ffmpegStaticPath).replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
}

const activeJobs = new Map();
const DEFAULT_CANCEL_TIMEOUT_MS = 5000;

function parseProgress(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

/**
 * Runs ffmpeg. Reports progress when `totalDurationMs` is known and calls `onProgress`
 * with a 0..1 ratio. The returned promise rejects with `code === 'CANCELLED'` when the
 * job is cancelled through `cancel()`.
 */
function run(args, {
  onProgress,
  totalDurationMs = 0,
  jobId,
  captureProgress = false
} = {}) {
  const executable = resolveExecutable();
  if (!executable) {
    return Promise.reject(new Error('FFmpeg 실행 파일을 찾을 수 없습니다.'));
  }

  const id = jobId || crypto.randomUUID();
  const fullArgs = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, fullArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let cancelled = false;
    let resolveClosed;
    const closed = new Promise((done) => { resolveClosed = done; });
    activeJobs.set(id, {
      cancel: () => {
        cancelled = true;
        child.kill('SIGKILL');
      },
      closed
    });

    let stderr = '';
    let stdoutBuffer = '';
    let finalProgress = {};

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const blocks = stdoutBuffer.split(/(?<=progress=\w+\r?\n)/);
      stdoutBuffer = blocks.pop() || '';
      if (!onProgress && !captureProgress) return;

      for (const block of blocks) {
        const fields = parseProgress(block);
        finalProgress = { ...finalProgress, ...fields };
        if (!onProgress) continue;
        const microseconds = Number(fields.out_time_us ?? fields.out_time_ms);
        if (!Number.isFinite(microseconds) || totalDurationMs <= 0) continue;
        const ratio = microseconds / 1000 / totalDurationMs;
        onProgress(Math.max(0, Math.min(1, ratio)));
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Keep only the tail: ffmpeg can emit a lot and we only need the failure reason.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (error) => {
      activeJobs.delete(id);
      resolveClosed();
      reject(error);
    });

    child.on('close', (code) => {
      activeJobs.delete(id);
      resolveClosed();
      if (captureProgress && stdoutBuffer.trim()) {
        finalProgress = { ...finalProgress, ...parseProgress(stdoutBuffer) };
        stdoutBuffer = '';
      }
      if (cancelled) {
        const error = new Error('작업이 취소되었습니다.');
        error.code = 'CANCELLED';
        reject(error);
        return;
      }
      if (code === 0) {
        if (onProgress) onProgress(1);
        resolve({ progress: finalProgress });
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg가 코드 ${code}로 종료되었습니다.`));
    });
  });
}

function waitForClose(promise, timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function cancel(jobId, { timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS } = {}) {
  const job = activeJobs.get(jobId);
  if (!job) return Promise.resolve(false);
  job.cancel();
  return waitForClose(job.closed.then(() => true), timeoutMs);
}

async function cancelAll({ timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS } = {}) {
  const jobs = [...activeJobs.values()];
  for (const job of jobs) {
    job.cancel();
  }
  const closed = await waitForClose(Promise.allSettled(jobs.map((job) => job.closed)), timeoutMs);
  return closed !== false;
}

function hasActiveJobs() {
  return activeJobs.size > 0;
}

/**
 * Decodes the primary video and every audio stream end-to-end. Optional expectations
 * prevent a truncated-but-parseable file from being accepted as a complete recording.
 */
async function validateMedia(inputPath, {
  expectedDurationMs = 0,
  expectedFrames = 0,
  requireAudio = false,
  minDurationRatio = 0.95,
  minFrameRatio = 0.95,
  jobId
} = {}) {
  const result = await run([
    '-v', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', requireAudio ? '0:a:0' : '0:a?',
    '-f', 'null',
    '-'
  ], { captureProgress: true, jobId });

  const progress = result?.progress || {};
  const frameCount = Number(progress.frame);
  const microseconds = Number(progress.out_time_us ?? progress.out_time_ms);
  const durationMs = Number.isFinite(microseconds) ? microseconds / 1000 : 0;
  const durationFloor = Math.max(0, Number(expectedDurationMs))
    * Math.max(0.5, Math.min(1, Number(minDurationRatio) || 0.95));
  const frameFloor = Math.max(0, Number(expectedFrames))
    * Math.max(0.5, Math.min(1, Number(minFrameRatio) || 0.95));
  const finalFrameAllowanceMs = expectedFrames > 0
    ? Math.max(1, Number(expectedDurationMs) / Number(expectedFrames) * 1.1)
    : 0;

  if (durationFloor > 0 && durationMs + finalFrameAllowanceMs < durationFloor) {
    throw new Error(
      `검증된 미디어 길이가 예상보다 짧습니다. (${Math.round(durationMs)}ms / ${Math.round(expectedDurationMs)}ms)`
    );
  }
  if (frameFloor > 0 && (!Number.isFinite(frameCount) || frameCount < frameFloor)) {
    throw new Error(
      `검증된 영상 프레임 수가 예상보다 적습니다. (${frameCount || 0} / ${Math.round(expectedFrames)})`
    );
  }
  return { durationMs, frameCount: Number.isFinite(frameCount) ? frameCount : 0 };
}

async function createThumbnail(inputPath, outputPath, { jobId } = {}) {
  const extract = (seek) => run([
    '-y', '-ss', seek, '-i', inputPath, '-frames:v', '1',
    '-vf', 'scale=112:64:force_original_aspect_ratio=decrease,pad=112:64:(ow-iw)/2:(oh-ih)/2',
    '-q:v', '4', outputPath
  ], { jobId });
  await fs.rm(outputPath, { force: true });
  try {
    await extract('0.2');
  } catch (firstError) {
    await fs.rm(outputPath, { force: true });
    if (firstError?.code === 'CANCELLED') throw firstError;
    try {
      await extract('0');
    } catch (error) {
      await fs.rm(outputPath, { force: true });
      throw error;
    }
  }
}

/**
 * Stream-copy remux. No re-encoding, so this is I/O bound (measured ~75 ms for 11.5 MB)
 * rather than the minutes a libx264 pass costs.
 */
async function remux(inputPath, outputPath, { jobId, onProgress, totalDurationMs } = {}) {
  await fs.rm(outputPath, { force: true });
  await run([
    '-y',
    '-fflags', '+genpts',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath
  ], { jobId, onProgress, totalDurationMs });
}

/** Joins complete rolling MediaRecorder epochs without re-encoding. */
async function concatSegments(inputPaths, outputPath, options = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('결합할 클립 세그먼트가 없습니다.');
  }
  const listPath = `${outputPath}.concat-${crypto.randomUUID()}.txt`;
  const escapePath = (value) => String(value).replace(/'/g, "'\\''");
  const manifest = inputPaths.map((inputPath) => `file '${escapePath(inputPath)}'`).join('\n');
  await fs.writeFile(listPath, manifest, 'utf8');
  await fs.rm(outputPath, { force: true });
  try {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c', 'copy',
      '-fflags', '+genpts'
    ];
    if (path.extname(outputPath).toLowerCase() === '.mp4') {
      args.push('-movflags', '+faststart');
    }
    args.push(outputPath);
    await run(args, {
      jobId: options.jobId,
      onProgress: options.onProgress,
      totalDurationMs: options.totalDurationMs
    });
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => {});
  }
}

/** Keeps H.264 lossless while converting Opus audio to MP4-compatible AAC. */
async function remuxH264ToMp4(inputPath, outputPath, options = {}) {
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));
  await fs.rm(outputPath, { force: true });
  await run([
    '-y',
    '-fflags', '+genpts',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-movflags', '+faststart',
    outputPath
  ], {
    jobId: options.jobId,
    onProgress: options.onProgress,
    totalDurationMs: options.totalDurationMs
  });
}

/** Extracts the most recent interval from one complete MediaRecorder stream. */
async function trimRecent(inputPath, outputPath, {
  durationMs,
  endOffsetMs = 0,
  jobId,
  onProgress
} = {}) {
  const seconds = Math.max(0.1, Number(durationMs) / 1000 || 0.1);
  const seekSeconds = seconds + Math.max(0, Number(endOffsetMs) || 0) / 1000;
  const args = [
    '-y',
    '-sseof', `-${seekSeconds.toFixed(3)}`,
    '-fflags', '+genpts',
    '-i', inputPath,
    '-t', seconds.toFixed(3),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero'
  ];
  if (path.extname(outputPath).toLowerCase() === '.mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push(outputPath);
  await fs.rm(outputPath, { force: true });
  await run(args, { jobId, onProgress, totalDurationMs: durationMs });
}

/**
 * Extracts a recent H.264 interval into MP4. The video remains a stream copy while audio
 * is normalized to AAC, since MediaRecorder fallbacks commonly pair H.264 with Opus and
 * that combination is not reliably playable in an MP4 container.
 */
async function trimRecentToMp4(inputPath, outputPath, options = {}) {
  const durationMs = Math.max(100, Number(options.durationMs) || 100);
  const seconds = durationMs / 1000;
  const seekSeconds = seconds + Math.max(0, Number(options.endOffsetMs) || 0) / 1000;
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));

  await fs.rm(outputPath, { force: true });
  await run([
    '-y',
    '-sseof', `-${seekSeconds.toFixed(3)}`,
    '-fflags', '+genpts',
    '-i', inputPath,
    '-t', seconds.toFixed(3),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outputPath
  ], {
    jobId: options.jobId,
    onProgress: options.onProgress,
    totalDurationMs: durationMs
  });
}

/**
 * Full software re-encode. Only reached when the recorder could not produce H.264 at
 * all, so it is a compatibility fallback rather than part of the normal path.
 */
async function transcodeToMp4(inputPath, outputPath, options = {}) {
  const fps = Math.max(1, Math.min(240, Number(options.fps) || 60));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 10);
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));
  const preset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']
    .includes(options.encoderPreset) ? options.encoderPreset : 'veryfast';

  const inputArgs = [];
  const recentDurationMs = Number(options.recentDurationMs);
  const recentEndOffsetMs = Math.max(0, Number(options.recentEndOffsetMs) || 0);
  if (Number.isFinite(recentDurationMs) && recentDurationMs > 0) {
    inputArgs.push('-sseof', `-${((recentDurationMs + recentEndOffsetMs) / 1000).toFixed(3)}`);
  }

  await fs.rm(outputPath, { force: true });
  await run([
    '-y',
    ...inputArgs,
    '-i', inputPath,
    ...(recentDurationMs > 0 ? ['-t', (recentDurationMs / 1000).toFixed(3)] : []),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', `fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-b:v', `${bitrateMbps}M`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-movflags', '+faststart',
    outputPath
  ], {
    jobId: options.jobId,
    onProgress: options.onProgress,
    totalDurationMs: recentDurationMs > 0 ? recentDurationMs : options.totalDurationMs
  });
}

module.exports = {
  resolveExecutable,
  DEFAULT_CANCEL_TIMEOUT_MS,
  waitForClose,
  run,
  cancel,
  cancelAll,
  hasActiveJobs,
  validateMedia,
  createThumbnail,
  remux,
  concatSegments,
  remuxH264ToMp4,
  trimRecent,
  trimRecentToMp4,
  transcodeToMp4
};
