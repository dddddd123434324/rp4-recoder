'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const legalDir = path.join(projectRoot, 'legal');
const ffmpegPath = require('ffmpeg-static');
const ffmpegDir = path.dirname(ffmpegPath);

function normalizeOutput(value) {
  return String(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd() + '\n';
}

function runFfmpeg(args) {
  try {
    return normalizeOutput(execFileSync(ffmpegPath, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`;
    if (output.trim()) return normalizeOutput(output);
    throw error;
  }
}

fs.mkdirSync(legalDir, { recursive: true });
fs.writeFileSync(path.join(legalDir, 'FFMPEG_VERSION.txt'), runFfmpeg(['-version']), 'utf8');
fs.writeFileSync(path.join(legalDir, 'FFMPEG_BUILDCONF.txt'), runFfmpeg(['-buildconf']), 'utf8');

for (const [source, target] of [
  ['ffmpeg.exe.LICENSE', 'FFMPEG-GPL-3.0.txt'],
  ['ffmpeg.exe.README', 'FFMPEG-UPSTREAM-README.txt']
]) {
  const sourcePath = path.join(ffmpegDir, source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required FFmpeg notice is missing: ${sourcePath}`);
  }
  fs.writeFileSync(
    path.join(legalDir, target),
    normalizeOutput(fs.readFileSync(sourcePath, 'utf8')),
    'utf8'
  );
}

fs.copyFileSync(
  path.join(projectRoot, 'src', 'fonts', 'LICENSE-PyeojinGothic.txt'),
  path.join(legalDir, 'PyeojinGothic-OFL-1.1.txt')
);

console.log('Updated generated legal files.');
