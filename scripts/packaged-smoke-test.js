#!/usr/bin/env node
'use strict';

/*
 * Exercises the packaged, unpacked app rather than the source Electron entry point.
 * This catches missing asar-unpacked FFmpeg files and afterPack packaging regressions
 * without showing a user-facing window or touching the user's profile.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packagedDir = process.env.RP4_PACKAGED_DIR
  ? path.resolve(projectRoot, process.env.RP4_PACKAGED_DIR)
  : path.join(projectRoot, 'dist', 'win-unpacked');
const executable = path.join(packagedDir, 'RP4 Recorder.exe');

async function main() {
  await fs.access(executable);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'rp4-packaged-smoke-'));
  const env = {
    ...process.env,
    RP4_SMOKE: '1',
    RP4_SMOKE_TIMEOUT_MS: '60000'
  };

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--user-data-dir=${profile}`], {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
        windowsHide: true
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`Packaged smoke test exited with code ${exitCode}.`);
    process.stdout.write('PACKAGED SMOKE OK\n');
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`PACKAGED SMOKE FAIL ${error?.stack || error}\n`);
  process.exitCode = 1;
});
