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
function run(args, { onProgress, totalDurationMs = 0, jobId } = {}) {
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
    activeJobs.set(id, {
      cancel: () => {
        cancelled = true;
        child.kill('SIGKILL');
      }
    });

    let stderr = '';
    let stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const blocks = stdoutBuffer.split(/(?<=progress=\w+\r?\n)/);
      stdoutBuffer = blocks.pop() || '';
      if (!onProgress) return;

      for (const block of blocks) {
        const fields = parseProgress(block);
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
      reject(error);
    });

    child.on('close', (code) => {
      activeJobs.delete(id);
      if (cancelled) {
        const error = new Error('작업이 취소되었습니다.');
        error.code = 'CANCELLED';
        reject(error);
        return;
      }
      if (code === 0) {
        if (onProgress) onProgress(1);
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `FFmpeg가 코드 ${code}로 종료되었습니다.`));
    });
  });
}

function cancel(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  job.cancel();
  return true;
}

function cancelAll() {
  for (const job of activeJobs.values()) {
    job.cancel();
  }
}

function hasActiveJobs() {
  return activeJobs.size > 0;
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

/** Extracts the most recent interval from one complete MediaRecorder stream. */
async function trimRecent(inputPath, outputPath, { durationMs, jobId, onProgress } = {}) {
  const seconds = Math.max(0.1, Number(durationMs) / 1000 || 0.1);
  const args = [
    '-y',
    '-sseof', `-${seconds.toFixed(3)}`,
    '-fflags', '+genpts',
    '-i', inputPath,
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
 * Full software re-encode. Only reached when the recorder could not produce H.264 at
 * all, so it is a compatibility fallback rather than part of the normal path.
 */
async function transcodeToMp4(inputPath, outputPath, options = {}) {
  const fps = Math.max(1, Math.min(240, Number(options.fps) || 60));
  const bitrateMbps = Math.max(1, Number(options.bitrateMbps) || 10);
  const audioBitrateKbps = Math.max(64, Math.min(320, Number(options.audioBitrateKbps) || 192));
  const preset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']
    .includes(options.encoderPreset) ? options.encoderPreset : 'veryfast';

  await fs.rm(outputPath, { force: true });
  await run([
    '-y',
    '-i', inputPath,
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
    totalDurationMs: options.totalDurationMs
  });
}

module.exports = {
  resolveExecutable,
  run,
  cancel,
  cancelAll,
  hasActiveJobs,
  remux,
  trimRecent,
  transcodeToMp4
};
